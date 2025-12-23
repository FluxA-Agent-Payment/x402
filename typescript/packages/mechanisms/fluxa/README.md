# @x402/fluxa

FluxA Credits ("fluxacredit") mechanism for the x402 payment protocol, using HTTP Message Signatures for payer authentication and an exact-price flow.

## Installation

```bash
npm install @x402/fluxa
```

## Overview

This package provides FluxA Credits support for x402 with three roles:

- Client scheme — builds x402 v2 payment payloads for FluxA Credits
- Server scheme — produces precise "Payment-Required" offers in FluxA Credits
- Facilitator scheme — verifies Web Bot Auth signatures and settles payments

It focuses on the v2 protocol with CAIP-2 style networks (e.g., `fluxa:monetize`).

## Package Exports

You can import the concrete schemes via explicit subpaths:

- `@x402/fluxa/credit/client` — `FluxaCreditClientScheme`
- `@x402/fluxa/credit/server` — `FluxaCreditServerScheme`
- `@x402/fluxa/credit/facilitator` — `FluxaCreditFacilitatorScheme`

Or use the top-level namespace export:

```ts
import { fluxacredit } from "@x402/fluxa";
// fluxacredit.FluxaCreditClientScheme, fluxacredit.FluxaCreditServerScheme, fluxacredit.FluxaCreditFacilitatorScheme
```

## Version Support

- Protocol: x402 v2 only
- Networks: CAIP family `fluxa:*` (e.g., `fluxa:monetize`)
- Asset: `FLUXA_CREDIT`

## Usage

### 1) Client: creating a payment payload and HTTP headers

The FluxA client scheme builds the minimal x402 payload. HTTP Message Signatures live in HTTP headers (not inside the payload) and must be created by the caller or a helper library.

```ts
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { FluxaCreditClientScheme } from "@x402/fluxa/credit/client";

// 1) Register the scheme for your FluxA network
const client = new x402Client().register("fluxa:monetize", new FluxaCreditClientScheme());
const http = new x402HTTPClient(client);

// 2) Obtain a Payment-Required response from the server (402)
//    and decode it using the HTTP helper if you prefer:
//    const required = http.getPaymentRequiredResponse((name) => res.headers[name.toLowerCase()]);

// For illustration, assume `required` is the decoded object
const required = {
  x402Version: 2,
  resource: { url: "https://api.example.com/protected", description: "Paid resource", mimeType: "application/json" },
  accepts: [{
    scheme: "fluxacredit",
    network: "fluxa:monetize",
    amount: "25",
    asset: "FLUXA_CREDIT",
    payTo: "fluxa:facilitator:us-east-1",
    maxTimeoutSeconds: 60,
    extra: { id: "abc123" }
  }]
};

// 3) Build the x402 v2 payment payload
const paymentPayload = await client.createPaymentPayload(required);

// 4) Encode the PAYMENT-SIGNATURE header (base64url of payload)
const headers = http.encodePaymentSignatureHeader(paymentPayload);
const paymentSignature = headers["PAYMENT-SIGNATURE"]; // attach to your HTTP request

// 5) Create HTTP Message Signatures (Web Bot Auth) using your signing library
// Required components: "payment-signature", "signature-agent", "@authority"
// Example pseudo-code:
const signatureAgent = '\"https://example.com/.well-known/http-message-signatures-directory\"';
const created = Math.floor(Date.now() / 1000);
const expires = created + 60; // 60s validity
const signatureInput = `sig1=("payment-signature" "signature-agent" "@authority");created=${created};expires=${expires};keyid="<your-key-thumbprint>";alg="ed25519";nonce="demo";tag="web-bot-auth"`;
const signature = await mySigner.sign({
  signatureInput,
  method: "GET",
  url: "https://api.example.com/protected",
  headers: {
    "payment-signature": paymentSignature,
    "signature-agent": signatureAgent
  },
  privateKeyJwk: {/* Ed25519 JWK */}
});

// 6) Send the request with all required headers
await fetch("https://api.example.com/protected", {
  headers: {
    "PAYMENT-SIGNATURE": paymentSignature,
    "Signature-Agent": signatureAgent,
    "Signature-Input": signatureInput,
    "Signature": signature,
  }
});
```

Notes:
- The client scheme derives a `challengeId` from `paymentRequirements.extra.id` when present.
- The facilitator verifies the HTTP Message Signature over the exact `PAYMENT-SIGNATURE` value.
  Passing the raw header back through extensions is recommended when a server proxies the flow (see below).

### 2) Server: constructing Payment-Required

Use the server scheme to validate price input and construct precise requirements. The asset must be `FLUXA_CREDIT`.

```ts
import { FluxaCreditServerScheme } from "@x402/fluxa/credit/server";
import { encodePaymentRequiredHeader } from "@x402/core/http";

const serverScheme = new FluxaCreditServerScheme();

// Convert price -> concrete asset+amount (accepts number or { asset, amount })
const { amount, asset } = await serverScheme.parsePrice(25, "fluxa:monetize");

// Optionally ensure a unique id in requirements.extra
const accepted = await serverScheme.enhancePaymentRequirements({
  scheme: "fluxacredit",
  network: "fluxa:monetize",
  amount,
  asset,
  payTo: "fluxa:facilitator:us-east-1",
  maxTimeoutSeconds: 60,
  extra: { id: "abc123" }
});

const paymentRequired = {
  x402Version: 2,
  resource: { url: "https://api.example.com/protected", description: "Paid resource", mimeType: "application/json" },
  accepts: [accepted]
};

// Set 402 with header
res.writeHead(402, {
  "Content-Type": "application/json",
  "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired)
});
```

### 3) Facilitator: verification and settlement

The facilitator verifies Web Bot Auth and binds the requirements before settling.

```ts
import { x402Facilitator } from "@x402/core/facilitator";
import { FluxaCreditFacilitatorScheme } from "@x402/fluxa/credit/facilitator";

const fac = new x402Facilitator();
fac.register("fluxa:monetize", new FluxaCreditFacilitatorScheme());

// Verify
const verifyResp = await fac.verify(paymentPayload, requirements);
if (!verifyResp.isValid) throw new Error(verifyResp.invalidReason);

// Settle (mock debit that returns a logical tx id)
const settleResp = await fac.settle(paymentPayload, requirements);
// { success: true, transaction: "credit-ledger:<id>", network: "fluxa:monetize" }
```

## API Reference

Below are the primary classes and their key methods. Types come from `@x402/core/types`.

- `FluxaCreditClientScheme`
  - `scheme: "fluxacredit"`
  - `createPaymentPayload(x402Version, paymentRequirements) => Promise<Pick<PaymentPayload, "x402Version" | "payload">>`
    - Produces a minimal payload with `signature: "http-message-signatures"` and a `challengeId` derived from `paymentRequirements.extra.id` if present.

- `FluxaCreditServerScheme`
  - `scheme: "fluxacredit"`
  - `parsePrice(price, network) => Promise<{ amount: string; asset: string }>`
    - Accepts a number or `{ asset, amount }`. Enforces `asset === "FLUXA_CREDIT"`.
  - `enhancePaymentRequirements(req) => Promise<PaymentRequirements>`
    - Ensures `req.extra.id` is present (injects a random id if missing).

- `FluxaCreditFacilitatorScheme`
  - `scheme: "fluxacredit"`
  - `caipFamily: "fluxa:*"`
  - `getExtra() => Record<string, unknown> | undefined`
  - `getSigners() => string[]` (empty; credit debits do not require on-chain signers)
  - `verify(paymentPayload, requirements) => Promise<VerifyResponse>`
    - Validates that `paymentPayload.accepted` equals `requirements` and that Web Bot Auth HTTP Message Signature is valid (Ed25519, short window).
  - `settle(paymentPayload, requirements) => Promise<SettleResponse>`
    - Mock debit; returns `{ success: true, transaction: "credit-ledger:<id>", network }` where `<id>` comes from `requirements.extra.id`.

## Web Bot Auth (HTTP Message Signatures)

The FluxA facilitator expects an HTTP Message Signature labeled like `sig1` and containing these components:

- Components: `"payment-signature"`, `"signature-agent"`, `"@authority"`
- Params: `created`, `expires`, `keyid`, `alg`=`ed25519`, and `tag`=`web-bot-auth`
- Algorithm: Ed25519
- JWKS Directory: `Signature-Agent` header pointing to a URL that returns a directory with Ed25519 keys (OKP JWKs)

How verification works:
- Parses `Signature-Input` and `Signature` and enforces a short validity window (≤ 60s, with ±60s skew).
- Reconstructs the signature base from the exact `PAYMENT-SIGNATURE` value, `Signature-Agent`, and `@authority` (host[:port]).
- Fetches the JWKS directory and selects the public key whose RFC 7638/8037 thumbprint matches `keyid`.
- Verifies the detached signature using `tweetnacl`.

When proxying through a resource server before calling the facilitator, pass through the original `PAYMENT-SIGNATURE` header value via extensions so the verifier signs the exact same bytes:

```ts
(paymentPayload as any).extensions = {
  ...(paymentPayload as any).extensions,
  "web-bot-auth": {
    signatureAgent: req.headers["signature-agent"],
    signatureInput: req.headers["signature-input"],
    signature: req.headers["signature"],
    paymentSignatureHeader: req.headers["payment-signature"],
  },
};
```

See a full working flow in the example at: `examples/fluxacredit/ts-integration/run-all.ts`.

## Supported Networks & Assets

- CAIP family: `fluxa:*` (e.g., `fluxa:monetize`). You can choose your own right-hand identifier for logical networks.
- Asset: `FLUXA_CREDIT` (required by the server scheme).

## Development

```bash
# Build
npm run build

# Test
npm run test

# Lint
npm run lint
```

## Related Packages

- `@x402/core` — core protocol types, client, and facilitator
- `@x402/http` or `@x402/fetch` — helpers for HTTP header encoding/decoding and client wrappers
- `@x402/evm` and `@x402/svm` — other mechanisms
