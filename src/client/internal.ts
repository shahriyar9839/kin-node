import grpc from "grpc";
import commonpb from "@kinecosystem/agora-api/node/common/v3/model_pb";
import accountpb from "@kinecosystem/agora-api/node/account/v3/account_service_pb";
import accountgrpc from "@kinecosystem/agora-api/node/account/v3/account_service_grpc_pb";
import transactionpb from "@kinecosystem/agora-api/node/transaction/v3/transaction_service_pb";
import transactiongrpc from "@kinecosystem/agora-api/node/transaction/v3/transaction_service_grpc_pb";
import accountpbv4 from "@kinecosystem/agora-api/node/account/v4/account_service_pb";
import accountgrpcv4 from "@kinecosystem/agora-api/node/account/v4/account_service_grpc_pb";
import airdroppbv4 from "@kinecosystem/agora-api/node/airdrop/v4/airdrop_service_pb";
import airdropgrpcv4 from "@kinecosystem/agora-api/node/airdrop/v4/airdrop_service_grpc_pb";
import commonpbv4 from "@kinecosystem/agora-api/node/common/v4/model_pb";
import transactionpbv4 from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_pb";
import transactiongrpcv4 from "@kinecosystem/agora-api/node/transaction/v4/transaction_service_grpc_pb";
import { 
    Account as SolanaAccount,
    PublicKey as SolanaPublicKey,
    SystemProgram,
    Transaction as SolanaTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

import { xdr } from "stellar-base";

import {
    PrivateKey,
    PublicKey,
    TransactionData,
    TransactionErrors,
    transactionStateFromProto,
    commitmentToProto,
    Commitment,
    txDataFromProto,
    TransactionType,
    Memo,
    paymentsFromEnvelope,
    TransactionState,
} from "../";
import { errorsFromXdr, AccountDoesNotExist, AccountExists, TransactionRejected, InsufficientBalance, errorsFromSolanaTx, PayerRequired, NoSubsidizerError, AlreadySubmitted, nonRetriableErrors as nonRetriableErrorsList, BadNonce, NoTokenAccounts } from "../errors";
import { ShouldRetry, retryAsync, limit, nonRetriableErrors } from "../retry";
import BigNumber from "bignumber.js";
import { Transaction } from "@solana/web3.js";
import { AccountSize, AuthorityType, TokenProgram } from "../solana/token-program";
import LRUCache from "lru-cache";
import { generateTokenAccount } from "./utils";

export const SDK_VERSION = "0.2.3";
export const USER_AGENT_HEADER = "kin-user-agent";
export const KIN_VERSION_HEADER = "kin-version";
export const DESIRED_KIN_VERSION_HEADER = "desired-kin-version";
export const USER_AGENT = `KinSDK/${SDK_VERSION} node/${process.version}`;
const SERVICE_CONFIG_CACHE_KEY = "GetServiceConfig";

export class SubmitTransactionResult {
    TxId: Buffer;
    InvoiceErrors?: commonpb.InvoiceError[];
    Errors?: TransactionErrors;

    constructor() {
        this.TxId = Buffer.alloc(32);
    }
}

export interface InternalClientConfig {
    endpoint?: string
    accountClient?: accountgrpc.AccountClient
    txClient?: transactiongrpc.TransactionClient

    accountClientV4?: accountgrpcv4.AccountClient
    airdropClientV4?: airdropgrpcv4.AirdropClient
    txClientV4?: transactiongrpcv4.TransactionClient

    strategies?: ShouldRetry[]
    kinVersion?: number

    desiredKinVersion?: number
}

// Internal is the low level gRPC client for Agora used by Client.
//
// The interface is _not_ stable, and should not be used. However,
// it is exported in case there is some strong reason that access
// to the underlying blockchain primitives are required.
export class Internal {
    txClient: transactiongrpc.TransactionClient;
    accountClient: accountgrpc.AccountClient;
    accountClientV4: accountgrpcv4.AccountClient;
    airdropClientV4: airdropgrpcv4.AirdropClient;
    txClientV4: transactiongrpcv4.TransactionClient;
    strategies: ShouldRetry[];
    metadata: grpc.Metadata;
    kinVersion: number;
    private responseCache: LRUCache<string, string>;

    constructor(config: InternalClientConfig) {
        if (config.endpoint) {
            if (config.accountClient || config.txClient || config.accountClientV4 || config.airdropClientV4 || config.txClientV4) {
                throw new Error("cannot specify endpoint and clients");
            }

            const sslCreds = grpc.credentials.createSsl();
            this.accountClient = new accountgrpc.AccountClient(config.endpoint, sslCreds);
            this.txClient = new transactiongrpc.TransactionClient(config.endpoint, sslCreds);

            this.accountClientV4 = new accountgrpcv4.AccountClient(config.endpoint, sslCreds);
            this.airdropClientV4 = new airdropgrpcv4.AirdropClient(config.endpoint, sslCreds);
            this.txClientV4 = new transactiongrpcv4.TransactionClient(config.endpoint, sslCreds);
        } else if (config.accountClient) {
            if (!config.txClient || !config.accountClientV4 || !config.airdropClientV4 || !config.txClientV4) {
                throw new Error("must specify all gRPC clients");
            }

            this.accountClient = config.accountClient;
            this.txClient = config.txClient;

            this.accountClientV4 = config.accountClientV4;
            this.airdropClientV4 = config.airdropClientV4;
            this.txClientV4 = config.txClientV4;
        } else {
            throw new Error("must specify endpoint or gRPC clients");
        }

        if (config.strategies) {
            this.strategies = config.strategies;
        } else {
            this.strategies = [
                limit(3),
                nonRetriableErrors(...nonRetriableErrorsList),
            ];
        }

        if (config.kinVersion) {
            this.kinVersion = config.kinVersion;
        } else {
            this.kinVersion = 3;
        }

        this.metadata = new grpc.Metadata();
        this.metadata.set(USER_AGENT_HEADER, USER_AGENT);
        this.metadata.set(KIN_VERSION_HEADER, this.kinVersion.toString());
        if (config.desiredKinVersion) {
            this.metadata.set(DESIRED_KIN_VERSION_HEADER, config.desiredKinVersion!.toString());
        }

        // Currently only caching GetServiceConfig, so limit to 1 entry
        this.responseCache = new LRUCache({
            max: 1,
            maxAge: 24 * 60 * 60 * 1000, // 24 hours
        });
    }

    setKinVersion(kinVersion: number): void {
        this.kinVersion = kinVersion;
        this.metadata.set(KIN_VERSION_HEADER, this.kinVersion.toString());
    }

    async getBlockchainVersion(): Promise<number> {
        const req = new transactionpbv4.GetMinimumKinVersionRequest();
        return retryAsync(() => {
            return new Promise<number>((resolve, reject) => {
                this.txClientV4.getMinimumKinVersion(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    return resolve(resp.getVersion());
                });
            });
        }, ...this.strategies);
    }

    async createStellarAccount(key: PrivateKey): Promise<void> {
        const accountId = new commonpb.StellarAccountId();
        accountId.setValue(key.publicKey().stellarAddress());

        const req = new accountpb.CreateAccountRequest();
        req.setAccountId(accountId);

        return retryAsync(() => {
            return new Promise<void>((resolve, reject) => {
                this.accountClient.createAccount(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (resp.getResult() == accountpb.CreateAccountResponse.Result.EXISTS) {
                        reject(new AccountExists());
                        return;
                    }

                    resolve();
                });
            });
        }, ...this.strategies);
    }

    async getAccountInfo(account: PublicKey): Promise<accountpb.AccountInfo> {
        const accountId = new commonpb.StellarAccountId();
        accountId.setValue(account.stellarAddress());

        const req = new accountpb.GetAccountInfoRequest();
        req.setAccountId(accountId);

        return retryAsync(() => {
            return new Promise<accountpb.AccountInfo>((resolve, reject) => {
                this.accountClient.getAccountInfo(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (resp.getResult() == accountpb.GetAccountInfoResponse.Result.NOT_FOUND) {
                        reject(new AccountDoesNotExist());
                        return;
                    }

                    return resolve(resp.getAccountInfo());
                });
            });
        }, ...this.strategies);
    }

    async getStellarTransaction(hash: Buffer): Promise<TransactionData | undefined> {
        const transactionHash = new commonpb.TransactionHash();
        transactionHash.setValue(hash);

        const req = new transactionpb.GetTransactionRequest();
        req.setTransactionHash(transactionHash);

        return retryAsync(() => {
            return new Promise<TransactionData | undefined>((resolve, reject) => {
                this.txClient.getTransaction(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const data = new TransactionData();
                    data.txId = hash;

                    switch (resp.getState()) {
                        case transactionpb.GetTransactionResponse.State.UNKNOWN: {
                            data.txState = TransactionState.Unknown;
                            break;
                        }
                        case transactionpb.GetTransactionResponse.State.SUCCESS: {
                            const envelope = xdr.TransactionEnvelope.fromXDR(Buffer.from(resp.getItem()!.getEnvelopeXdr()!));

                            let type: TransactionType = TransactionType.Unknown;
                            const memo = Memo.fromXdr(envelope.v0().tx().memo(), true);
                            if (memo) {
                                type = memo.TransactionType();
                            }

                            data.txState = TransactionState.Success;
                            data.payments = paymentsFromEnvelope(envelope, type, resp.getItem()!.getInvoiceList(), this.kinVersion);
                            break;
                        }
                        default: {
                            reject("unknown transaction state: " + resp.getState());
                            return;
                        }
                    }

                    resolve(data);
                });
            });
        }, ...this.strategies);
    }

    async submitStellarTransaction(envelope: xdr.TransactionEnvelope, invoiceList?: commonpb.InvoiceList): Promise<SubmitTransactionResult> {
        const req = new transactionpb.SubmitTransactionRequest();
        req.setEnvelopeXdr(envelope.toXDR());
        req.setInvoiceList(invoiceList);

        return retryAsync(() => {
            return new Promise<SubmitTransactionResult>((resolve, reject) => {
                this.txClient.submitTransaction(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const result = new SubmitTransactionResult();
                    result.TxId = Buffer.from(resp.getHash()!.getValue()!);

                    switch (resp.getResult()) {
                        case transactionpb.SubmitTransactionResponse.Result.OK: {
                            break;
                        }
                        case transactionpb.SubmitTransactionResponse.Result.REJECTED: {
                            reject(new TransactionRejected());
                            return;
                        }
                        case transactionpb.SubmitTransactionResponse.Result.INVOICE_ERROR: {
                            result.InvoiceErrors = resp.getInvoiceErrorsList();
                            break;
                        }
                        case transactionpb.SubmitTransactionResponse.Result.FAILED: {
                            const resultXdr = xdr.TransactionResult.fromXDR(Buffer.from(resp.getResultXdr()));
                            result.Errors = errorsFromXdr(resultXdr);
                            break;
                        }
                        default:
                            reject("unexpected result from agora: " + resp.getResult());
                            return;
                    }

                    resolve(result);
                });
            });
        }, ...this.strategies);
    }

    async createSolanaAccount(key: PrivateKey, commitment: Commitment = Commitment.Single, subsidizer?: PrivateKey): Promise<void> {
        const tokenAccountKey = generateTokenAccount(key);
        
        const fn = async() => {
            const [serviceConfigResp, recentBlockhash, minBalance] = await Promise.all([
                this.getServiceConfig(),
                this.getRecentBlockhash(),
                this.getMinimumBalanceForRentExemption()
            ]);
            if (!subsidizer && !serviceConfigResp.getSubsidizerAccount()) {
                throw new NoSubsidizerError();
            }

            let subsidizerKey: SolanaPublicKey;
            if (subsidizer) {
                subsidizerKey = subsidizer!.publicKey().solanaKey();
            } else {
                subsidizerKey = new SolanaPublicKey(Buffer.from(serviceConfigResp.getSubsidizerAccount()!.getValue_asU8()));
            }

            const tokenProgram = new SolanaPublicKey(Buffer.from(serviceConfigResp.getTokenProgram()!.getValue_asU8()));

            const transaction = new Transaction({ 
                feePayer: subsidizerKey,
                recentBlockhash: recentBlockhash,
            }).add(
                SystemProgram.createAccount({
                    fromPubkey: subsidizerKey,
                    newAccountPubkey: tokenAccountKey.publicKey().solanaKey(),
                    lamports: minBalance,
                    space: AccountSize,
                    programId: tokenProgram,
                }),
                TokenProgram.initializeAccount({
                    account: tokenAccountKey.publicKey().solanaKey(),
                    mint: new SolanaPublicKey(Buffer.from(serviceConfigResp.getToken()!.getValue_asU8())),
                    owner: key.publicKey().solanaKey(),
                }, tokenProgram),
                TokenProgram.setAuthority({
                    account: tokenAccountKey.publicKey().solanaKey(),
                    currentAuthority: key.publicKey().solanaKey(),
                    newAuthority: subsidizerKey,
                    authorityType: AuthorityType.CloseAccount,
                }, tokenProgram)
            );
            transaction.partialSign(new SolanaAccount(key.secretKey()), new SolanaAccount(tokenAccountKey.secretKey()));
            if (subsidizer) {
                transaction.partialSign(new SolanaAccount(subsidizer.secretKey()));
            }
            
            const protoTx = new commonpbv4.Transaction();
            protoTx.setValue(transaction.serialize({
                requireAllSignatures: false,
                verifySignatures: false,
            }));
            
            const req = new accountpbv4.CreateAccountRequest();
            req.setTransaction(protoTx);
            req.setCommitment(commitmentToProto(commitment));

            this.accountClientV4.createAccount(req, this.metadata, (err, resp) => {
                if (err) {
                    throw err;
                }
                
                switch (resp.getResult()) {
                    case accountpbv4.CreateAccountResponse.Result.EXISTS:
                        throw new AccountExists();
                    case accountpbv4.CreateAccountResponse.Result.PAYER_REQUIRED:
                        throw new PayerRequired();
                    case accountpbv4.CreateAccountResponse.Result.BAD_NONCE:
                        throw new BadNonce();
                    case accountpbv4.CreateAccountResponse.Result.OK:
                        return Promise.resolve();
                    default:
                        throw new Error("unexpected result from Agora: " + resp.getResult());
                }
            });
        };

        return retryAsync(fn, ...this.strategies).catch(err => {
            return Promise.reject(err);
        });
    }

    async getSolanaAccountInfo(account: PublicKey, commitment: Commitment = Commitment.Single): Promise<accountpbv4.AccountInfo> {
        const accountId = new commonpbv4.SolanaAccountId();
        accountId.setValue(account.buffer);

        const req = new accountpbv4.GetAccountInfoRequest();
        req.setAccountId(accountId);
        req.setCommitment(commitmentToProto(commitment));

        return retryAsync(() => {
            return new Promise<accountpbv4.AccountInfo>((resolve, reject) => {
                this.accountClientV4.getAccountInfo(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (resp.getResult() === accountpbv4.GetAccountInfoResponse.Result.NOT_FOUND) {
                        reject(new AccountDoesNotExist());
                        return;
                    }

                    return resolve(resp.getAccountInfo()!);
                });
            });
        }, ...this.strategies);
    }

    async submitSolanaTransaction(tx: SolanaTransaction, invoiceList?: commonpb.InvoiceList, commitment: Commitment = Commitment.Single, dedupeId?: Buffer): Promise<SubmitTransactionResult> {
        const protoTx = new commonpbv4.Transaction();
        protoTx.setValue(tx.serialize({
            requireAllSignatures: false,
            verifySignatures: false,
        }));

        const req = new transactionpbv4.SubmitTransactionRequest();
        req.setTransaction(protoTx);
        req.setInvoiceList(invoiceList);
        req.setCommitment(commitmentToProto(commitment));
        if (dedupeId) {
            req.setDedupeId(dedupeId!);
        }

        let attempt = 0;
        return retryAsync(() => {
            return new Promise<SubmitTransactionResult>((resolve, reject) => {
                attempt = attempt + 1;
                this.txClientV4.submitTransaction(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    const result = new SubmitTransactionResult();
                    result.TxId = Buffer.from(resp.getSignature()!.getValue()!);

                    switch (resp.getResult()) {
                        case transactionpbv4.SubmitTransactionResponse.Result.OK: {
                            break;
                        }
                        case transactionpbv4.SubmitTransactionResponse.Result.ALREADY_SUBMITTED: {
                            // If this occurs on the first attempt, it's likely due to the submission of two identical transactions
                            // in quick succession and we should raise the error to the caller. Otherwise, it's likely that the
                            // transaction completed successfully on a previous attempt that failed due to a transient error.
                            if (attempt == 1) {
                                reject(new AlreadySubmitted());
                                return;
                            }
                            break;
                        }
                        case transactionpbv4.SubmitTransactionResponse.Result.REJECTED: {
                            reject(new TransactionRejected());
                            return;
                        }
                        case transactionpbv4.SubmitTransactionResponse.Result.PAYER_REQUIRED: {
                            reject(new PayerRequired());
                            return;
                        }
                        case transactionpbv4.SubmitTransactionResponse.Result.INVOICE_ERROR: {
                            result.InvoiceErrors = resp.getInvoiceErrorsList();
                            break;
                        }
                        case transactionpbv4.SubmitTransactionResponse.Result.FAILED: {
                            result.Errors = errorsFromSolanaTx(tx, resp.getTransactionError()!);
                            break;
                        }
                        default:
                            reject("unexpected result from agora: " + resp.getResult());
                            return;
                    }

                    resolve(result);
                });
            });
        }, ...this.strategies);
    }

    async getTransaction(id: Buffer, commitment: Commitment = Commitment.Single): Promise<TransactionData | undefined> {
        const transactionId = new commonpbv4.TransactionId();
        transactionId.setValue(id);

        const req = new transactionpbv4.GetTransactionRequest();
        req.setTransactionId(transactionId);
        req.setCommitment(commitmentToProto(commitment));

        return retryAsync(() => {
            return new Promise<TransactionData | undefined>((resolve, reject) => {
                this.txClientV4.getTransaction(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    let data: TransactionData;
                    if (resp.getItem()) {
                        data = txDataFromProto(resp.getItem()!, resp.getState());
                    } else {
                        data = new TransactionData();
                        data.txId = id;
                        data.txState = transactionStateFromProto(resp.getState());
                    }

                    resolve(data);
                });
            });
        }, ...this.strategies);
    }

    async getServiceConfig(): Promise<transactionpbv4.GetServiceConfigResponse> {
        const req = new transactionpbv4.GetServiceConfigRequest();
        return retryAsync(() => {
            return new Promise<transactionpbv4.GetServiceConfigResponse>((resolve, reject) => {
                const cached = this.responseCache.get(SERVICE_CONFIG_CACHE_KEY);
                if (cached) {
                    const resp = transactionpbv4.GetServiceConfigResponse.deserializeBinary(Buffer.from(cached, "base64"));
                    resolve(resp);
                    return;
                }

                this.txClientV4.getServiceConfig(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    this.responseCache.set(SERVICE_CONFIG_CACHE_KEY, Buffer.from(resp.serializeBinary()).toString("base64"));
                    resolve(resp);
                });
            });
        }, ...this.strategies);
    }

    async getRecentBlockhash(): Promise<string> {
        const req = new transactionpbv4.GetRecentBlockhashRequest();
        return retryAsync(() => {
            return new Promise<string>((resolve, reject) => {
                this.txClientV4.getRecentBlockhash(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    resolve(bs58.encode(Buffer.from(resp.getBlockhash()!.getValue_asU8())));
                });
            });
        }, ...this.strategies);
    }

    async getMinimumBalanceForRentExemption(): Promise<number> {
        const req = new transactionpbv4.GetMinimumBalanceForRentExemptionRequest();
        req.setSize(AccountSize);

        return retryAsync(() => {
            return new Promise<number>((resolve, reject) => {
                this.txClientV4.getMinimumBalanceForRentExemption(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    resolve(resp.getLamports());
                });
            });
        }, ...this.strategies);
    }

    async requestAirdrop(publicKey: PublicKey, quarks: BigNumber, commitment: Commitment = Commitment.Single): Promise<Buffer> {
        const accountId = new commonpbv4.SolanaAccountId();
        accountId.setValue(publicKey.buffer);

        const req = new airdroppbv4.RequestAirdropRequest();
        req.setAccountId(accountId);
        req.setQuarks(quarks.toNumber());
        req.setCommitment(commitmentToProto(commitment));

        return retryAsync(() => {
            return new Promise<Buffer>((resolve, reject) => {
                this.airdropClientV4.requestAirdrop(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    switch (resp.getResult()) {
                        case (airdroppbv4.RequestAirdropResponse.Result.OK):
                            resolve(Buffer.from(resp.getSignature()!.getValue_asU8()));
                            return;
                        case (airdroppbv4.RequestAirdropResponse.Result.NOT_FOUND):
                            reject(new AccountDoesNotExist());
                            return;
                        case (airdroppbv4.RequestAirdropResponse.Result.INSUFFICIENT_KIN):
                            reject(new InsufficientBalance());
                            return;
                        default:
                            reject("unexpected result from agora: " + resp.getResult());
                            return;
                    }
                });
            });
        }, ...this.strategies);
    }

    async resolveTokenAccounts(publicKey: PublicKey): Promise<PublicKey[]> {
        const accountId = new commonpbv4.SolanaAccountId();
        accountId.setValue(publicKey.buffer);

        const req = new accountpbv4.ResolveTokenAccountsRequest();
        req.setAccountId(accountId);

        return retryAsync(() => {
            return new Promise<PublicKey[]>((resolve, reject) => {
                this.accountClientV4.resolveTokenAccounts(req, this.metadata, (err, resp) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    resolve(resp.getTokenAccountsList().map((tokenAccount => {
                        return new PublicKey(Buffer.from(tokenAccount.getValue_asU8()));
                    })));
                });
            });
        });
    }
}
