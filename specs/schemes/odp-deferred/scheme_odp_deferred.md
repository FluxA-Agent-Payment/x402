# Scheme: `odp-deferred`

## Summary

Open Deferred Payment (ODP) is a session-based scheme for x402 that enables deferred settlement and batch execution. A client signs a SessionApproval once per session and signs a Receipt for each paid request. Resource servers or facilitators verify receipts immediately, deliver the resource, and later settle accumulated receipts on-chain in batches using a contiguous nonce range.

This scheme is transport-agnostic and uses the standard x402 `PaymentRequired` and `PaymentPayload` types.

## Use Cases

- High-frequency micro-payments for APIs, tools, or streaming usage
- Agent commerce with bursty repeated calls
- Systems that want to minimize on-chain transfers via batching

## Core Objects

- SessionApproval: payer-signed authorization that defines payee, asset, max spend, expiry, and starting nonce
- Receipt: payer-signed per-request micro-payment tied to a session
- Batch: an aggregated set of receipts for a contiguous nonce range

## Protocol Flow (Overview)

1. Server responds with `PaymentRequired` that includes `scheme=odp-deferred` and session parameters.
2. Client locks funds in a debit wallet contract before opening a session.
3. Client retries with `PaymentPayload` containing a Receipt and, when opening a session, a SessionApproval.
4. Server or facilitator verifies signatures, debit wallet funding, and session state, records the Receipt, and returns the protected resource.
5. A settlement processor batches receipts and submits a settlement transaction later.
6. The on-chain contract verifies the batch, updates session state, and executes transfers.

## Debit Wallet Funding and Withdrawal

ODP deferred requires the payer to lock funds in an on-chain debit wallet contract before using a session. The debit wallet contract enforces a withdrawal delay (for example, 24 hours) so funds remain available while settlement is deferred. Facilitators MUST query the debit wallet on-chain state during verification and settlement and SHOULD reject payments when the locked balance is insufficient.

The debit wallet contract interface is chain-specific; see the EVM scheme document for required functions and semantics.

## Settlement Scheduling

Facilitators SHOULD batch-settle receipts on a schedule of their choosing and perform the required aggregation logic. Clients do not need to explicitly trigger settlement. Resource servers do not initiate settlement and do not track settlement status; they rely on the facilitator to settle sessions asynchronously.

## Settlement Response Semantics

ODP allows settlement to occur after the resource response. Implementations MAY return the protected resource once verification succeeds without waiting for on-chain settlement. If a batch transaction hash is available at response time, servers SHOULD include it in the standard `SettlementResponse`. If it is not available, servers MAY omit `PAYMENT-RESPONSE` and provide settlement status out-of-band.

## Critical Validation Requirements

- Receipts MUST be sequential per session (nonce monotonic, no reuse).
- Receipt amount MUST match the per-request `PaymentRequirements.amount`.
- Total receipts MUST NOT exceed the session `maxSpend` and MUST be within `expiry`.
- The debit wallet locked balance MUST be sufficient to cover cumulative session spend.
- Asset and payee MUST match the SessionApproval and `PaymentRequirements`.
- Settlement processors MUST be authorized when a processor allowlist is configured.
- Batch settlement MUST enforce a contiguous nonce range and update `nextNonce` atomically.

## References

- EVM implementation: `scheme_odp_deferred_evm.md`
- Core types: `../../x402-specification-v2.md`
