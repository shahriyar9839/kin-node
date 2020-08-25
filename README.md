# Kin Node SDK

The Kin Node SDK enables developers use Kin inside their backend servers. It contains support for blockchain actions
such as creating accounts and sending payments, as well a webhook handler class to assist with implementing Agora webhooks.

## Requirements
* Node supporting ES2015 or higher

## Installation
```
npm install @kinecosystem/kin-sdk-v2
```

```
yarn add @kinecosystem/kin-sdk-v2
```

## Overview
The SDK contains two main components: the `Client` and webhook handlers. The `Client` is used for blockchain
actions, such as creating accounts sending payments, while the web hook handlers are meant for developers who wish to make
use of Agora Webhooks. For a high-level overview of using Agora, please refer to the [website documentation](https://docs.kin.org).

## Client
The main component of this library is the `Client` class, which facilitates access to the Kin blockchain.

### Initialization
At a minimum, the client needs to be instantiated with an `Environment`.

```typescript
import {Client, Environment} from "@kinecosystem/kin-node";
const client = new Client(Environment.Test);
```

Apps with [registered](https://docs.kin.org/app-registration) app indexes should initialize the client with their index:

```typescript
import {Client, Environment} from "@kinecosystem/kin-node";
const client = new Client(Environment.Test, {
    appIndex: 1
});
```

Additional options include:
- `whitelistKey`: The private key of an account that will be used to co-sign all transactions.
- `retryConfig`: A custom `agora.client.RetryConfig` to configure how the client retries requests.
- `endpoint`: A specific endpoint to use in the client. This will be inferred by default from the Environment.

### Usage
#### Create an Account
The `createAccount` method creates an account with the provided private key.
```typescript
const privateKey = PrivateKey.random();
await client.createAccount(privateKey);
```

#### Get a Transaction
The `getTransaction` method gets transaction data by transaction hash.
```typescript
const txHash = Buffer.from("<some has value>", "hex");
const transactionData = await client.getTransaction(txHash);
```

#### Get an Account Balance
The `getBalance` method gets the balance of the provided account, in [quarks](https://docs.kin.org/terms-and-concepts#quark)
```typescript
const publicKey = PublicKey.fromString("");
const balance = await client.getBalance(publicKey);
```

#### Submit a Payment
The `submitPayment` method submits the provided payment to Agora.
```typescript
const sender: PrivateKey;
const dest: PublicKey;

let txHash = await client.submitPayment({
    sender: sender,
    destination: dest,
    type: TransactionType.Earn,
    quarks: kinToQuarks("1"),
});
```

A `Payment` has the following required properties:
- `sender`: The private key of the account from which the payment will be sent.
- `destination`: The public key of the account to which the payment will be sent.
- `type`: The transaction type of the payment.
- `quarks`: The amount of the payment, in [quarks](https://docs.kin.org/terms-and-concepts#quark).

Additionally, it has some optional properties:
- `source`: The private key of a source account to use for the transaction. If unset, `sender` will be used as the transaction source.
- `invoice`: An [Invoice](https://docs.kin.org/how-it-works#invoices) to associate with this payment. Cannot be set if `memo` is set.
- `memo` A text memo to include in the transaction. Cannot be set if `invoice` is set.

#### Submit an Earn Batch
The `submitEarnBatch` method submits a batch of earns to Agora from a single account. It batches the earns into fewer
transactions where possible and submits as many transactions as necessary to submit all the earns.
```typescript
const earns: Earn[] = [
    {
        destination: PublicKey.fromString("xx"),
        quarks: kinToQuarks("1"),
    },
    {
        destination: PublicKey.fromString("yy"),
        quarks: kinToQuarks("1"),
    }
];
const result = await client.submitEarnBatch({
    sender: sender,
    earns: earns,
})
```


A single `Earn` has the following properties:
- `destination`: The public key of the account to which the earn will be sent.
- `quarks`: The amount of the earn, in [quarks](https://docs.kin.org/terms-and-concepts#quark).
- `invoice`: (optional) An [Invoice](https://docs.kin.org/how-it-works#invoices) to associate with this earn.

The `submitEarnBatch` method has the following parameters:
- `sender`:  The private key of the account from which the earns will be sent.
- `earns`: The list of earns to send.
- `source`: (optional): The private key of an account to use as the transaction source. If not set, `sender` will be used as the source.
- `memo`: (optional) A text memo to include in the transaction. Cannot be used if the earns have invoices associated with them.

### Examples
A few examples for creating an account and different ways of submitting payments and batched earns can be found in `examples/client`.

## Webhook Handlers

The SDK offers handler functions to assist  developers with implementing the [Agora webhooks](https://docs.kin.org/how-it-works#webhooks).

Only apps that have been assigned an [app index](https://docs.kin.org/app-registration) can make use of Agora webhooks.

### Prerequisites

The handlers assume usage of the `express` framework, as the default `http` library does not offer
much support for body reading, and middleware.

### Usage

There are currently two handlers:

- [Events](https://docs.kin.org/how-it-works#events) with `EventsHandler`
- [Sign Transaction](https://docs.kin.org/how-it-works#sign-transaction) with `SignTransactionHandler`

When configuring a webhook, a [webhook secret](https://docs.kin.org/agora/webhook#authentication) can be specified.

#### Events Webhook

To consume events from Agora:

```typescript
import { express, json } from "express";
import { Event, EventsHandler } from "@kinecosystem/kin-node/webhook";

// Note: if no secret is provided to the handler, all requests will be processed.
//       otherwise, the request signature will be validated to ensure it came from agora.
const secret = "WEBHOOK_SECRET";

const app = express();

// json() properly reads the entire response body and transforms it into a
// object suitable for use by the EventsHandler.
app.use("/events", json());
app.use("/events", EventsHandler(events: []Event) => {
    // processing logic
}, secret),
```

#### Sign Transaction Webhook

To verify and sign transactions related to your app:

```typescript
import { express, json } from "express";
import {
    SignTransactionRequest,
    SignTransactionResponse,
    SignTransactionHandler,
} from "@kinecosystem/kin-node/webhook";

// Note: if no secret is provided to the handler, all requests will be processed.
//       otherwise, the request signature will be validated to ensure it came from agora.
const secret = "WEBHOOK_SECRET";

const app = express();

// json() properly reads the entire response body and transforms it into a
// object suitable for use by the EventsHandler.
app.use("/sign_transaction", json());
app.use("/sign_transaction", SignTransactionHandler(req: SignTransactionRequest, resp: SignTransactionResponse) => {
    // decide whether or not to sign() or reject() the request.
}, secret),
```

### Example Code

A simple example Express server implementing both the Events and Sign Transaction webhooks can be found in `examples/webhook/webhook.tx`. To run it, first install all required dependencies:
```
$ npm i
or
$ yarn install
```


Next, run it as follows from the root directory (it will run on port 8080):
```
export WEBHOOK_SECRET=yoursecrethere
export WEBHOOK_SEED=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

npx ts-node examples/webhook/webhook.ts
```
