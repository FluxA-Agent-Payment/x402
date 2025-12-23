# FluxAcredit Minimal Runner

This example starts a local JWKS directory (Web Bot Auth key agent), a facilitator, and a resource server, then runs a client request that signs HTTP headers and pays an exact credits price via `fluxacredit`.

Run

- Node 18+ required (uses global fetch and Ed25519 crypto).
- Start everything with:

```
node examples/fluxacredit/minimal/run-all.js
```

What it does

- Generates an Ed25519 keypair and publishes a JWKS at `http://localhost:5051/.well-known/http-message-signatures-directory`.
- Facilitator verifies Web Bot Auth by:
  - Parsing `Signature-Input` (requires components: "payment-signature", "signature-agent", "@authority").
  - Rebuilding the signature base (including `"@signature-params"`).
  - Fetching JWKS, matching `keyid` by JWK thumbprint, and verifying the Ed25519 signature.
- Resource server issues 402 with an exact credits price; on retry it injects the raw HTTP signature headers into `PaymentPayload.extensions['web-bot-auth']` before calling `/verify`.
- Client signs the `PAYMENT-SIGNATURE` header value so identity is bound to the x402 payload.

Verification details are printed to stdout (components, keyid, base string, verify result) to help you debug integration.

