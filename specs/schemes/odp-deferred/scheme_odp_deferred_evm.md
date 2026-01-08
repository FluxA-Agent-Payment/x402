# Scheme: `odp-deferred` on `EVM`

## Summary

The `odp-deferred` scheme on EVM chains uses EIP-712 signatures to establish a session and authorize per-request receipts. Resource servers or facilitators verify receipts immediately and record them off-chain. Settlement processors later batch receipts into on-chain settlements that enforce a contiguous nonce range and session spend limits.

## `PaymentRequirements` `extra` Fields

In addition to the standard x402 `PaymentRequirements` fields, `odp-deferred` requires the following fields inside `extra`:

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | `string` | Required | 32-byte hex identifier for the session (bytes32) |
| `startNonce` | `string` | Required | First nonce value for the session (uint256) |
| `maxSpend` | `string` | Required | Maximum total spend allowed for the session (uint256) |
| `expiry` | `string` | Required | Unix timestamp after which the session is invalid (uint256) |
| `settlementContract` | `string` | Required | Settlement contract address used for EIP-712 domain binding |
| `debitWallet` | `string` | Required | Debit wallet contract address holding locked funds |
| `withdrawDelaySeconds` | `string` | Required | Withdrawal delay enforced by the debit wallet (uint256) |
| `minDeposit` | `string` | Optional | Funding hint for the client to lock funds before usage (uint256) |
| `authorizedProcessors` | `array` | Optional | Allowlist of settlement processor addresses |
| `requestHash` | `string` | Optional | 32-byte hash to bind receipts to a request context |
| `maxAmountPerReceipt` | `string` | Optional | Upper bound on a single receipt amount (uint256) |

Notes:

- `PaymentRequirements.amount` is the per-request price and MUST equal the receipt amount.
- If `authorizedProcessors` is omitted, `authorizedProcessorsHash` MUST be `0x0000000000000000000000000000000000000000000000000000000000000000`.
- If `requestHash` is omitted, receipts MUST use `0x0000000000000000000000000000000000000000000000000000000000000000`.
- `minDeposit` is optional and MAY be lower than `maxSpend`. Facilitators MUST enforce spend vs balance, not a fixed deposit size.

Example `PaymentRequirements`:

```json
{
  "scheme": "odp-deferred",
  "network": "eip155:84532",
  "amount": "15000",
  "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  "maxTimeoutSeconds": 60,
  "extra": {
    "sessionId": "0x4b2f64f3a7c1d9e0846f1d2c3a9b7e5c2d8f9a0b1c2d3e4f5061728394a5b6c7",
    "startNonce": "0",
    "maxSpend": "1000000",
    "expiry": "1740673000",
    "settlementContract": "0xB1F3C46C8d27C93f4bF8f9Cb57d8aA12E612a7d9",
    "debitWallet": "0x4a52cC7b7D1A47BBAc7C0aF4c2450c6B91B7D1b2",
    "withdrawDelaySeconds": "86400",
    "minDeposit": "1000000",
    "authorizedProcessors": [
      "0x4b1E9B7C2F0A2d1a3F7e8A9bCdEf0123456789Ab",
      "0x8A3C1dF2b5E6A7c8D9e0F1234567890aBCdEf012"
    ],
    "requestHash": "0x9a1c3e5f7b2d4c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60",
    "maxAmountPerReceipt": "50000"
  }
}
```

## Debit Wallet Contract (Required)

The debit wallet is an on-chain smart contract that locks payer funds and enforces a withdrawal delay. Implementations MUST provide at least the following functions:

```solidity
function deposit(address asset, uint256 amount) external;
function requestWithdraw(address asset, uint256 amount) external;
function withdraw(address asset, uint256 amount) external;
function balanceOf(address owner, address asset) external view returns (uint256);
function withdrawDelaySeconds() external view returns (uint256);
function withdrawRequest(address owner, address asset)
  external
  view
  returns (uint256 amount, uint256 requestedAt);
function settleFrom(address payer, address asset, address payee, uint256 amount) external;
function setSettlementContract(address settlement) external;
```

Semantics:

- `deposit` locks ERC-20 funds into the debit wallet (requires token approval).
- `requestWithdraw` starts the withdrawal delay timer.
- `withdraw` MUST revert unless `block.timestamp >= requestedAt + withdrawDelaySeconds()`.
- `balanceOf` returns the currently locked balance for a payer and asset.
- `settleFrom` transfers locked funds to a payee and MUST only be callable by the configured settlement contract.
- `setSettlementContract` configures the authorized settlement contract address.

Facilitators MUST query `balanceOf` and `withdrawDelaySeconds` on-chain during verification and settlement.
Reference implementation (not audited): `specs/contracts/debit-wallet/DebitWallet.sol`.

## PaymentPayload `payload` Field

The `payload` field of `PaymentPayload` MUST contain a receipt and MAY include a session approval when opening a session.

```json
{
  "sessionApproval": {
    "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    "payee": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "maxSpend": "1000000",
    "expiry": "1740673000",
    "sessionId": "0x4b2f64f3a7c1d9e0846f1d2c3a9b7e5c2d8f9a0b1c2d3e4f5061728394a5b6c7",
    "startNonce": "0",
    "authorizedProcessorsHash": "0x5d7c2a9f0b6e1c4d8f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e"
  },
  "sessionSignature": "0x...",
  "receipt": {
    "sessionId": "0x4b2f64f3a7c1d9e0846f1d2c3a9b7e5c2d8f9a0b1c2d3e4f5061728394a5b6c7",
    "nonce": "0",
    "amount": "15000",
    "deadline": "1740672160",
    "requestHash": "0x9a1c3e5f7b2d4c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60"
  },
  "receiptSignature": "0x..."
}
```

If the server already has a valid SessionApproval on record for `sessionId`, the client MAY omit `sessionApproval` and `sessionSignature`. If they are omitted and the server does not recognize the session, verification MUST fail.

### SessionApproval Fields

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `payer` | `string` | Required | Payer address that signs the approval |
| `payee` | `string` | Required | Payee address (MUST match `PaymentRequirements.payTo`) |
| `asset` | `string` | Required | ERC-20 token contract address (MUST match `PaymentRequirements.asset`) |
| `maxSpend` | `string` | Required | Maximum spend for the session |
| `expiry` | `string` | Required | Unix timestamp when session expires |
| `sessionId` | `string` | Required | Unique session identifier (bytes32) |
| `startNonce` | `string` | Required | Starting nonce for receipts |
| `authorizedProcessorsHash` | `string` | Required | Hash of the allowlisted processors or zero hash |

### Receipt Fields

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `sessionId` | `string` | Required | Session identifier (bytes32) |
| `nonce` | `string` | Required | Monotonic nonce for the session |
| `amount` | `string` | Required | Per-request amount (MUST equal `PaymentRequirements.amount`) |
| `deadline` | `string` | Required | Unix timestamp after which the receipt is invalid |
| `requestHash` | `string` | Required | Request binding hash or zero hash |

## EIP-712 Typed Data

Domain:

- `name`: `x402-odp-deferred`
- `version`: `1`
- `chainId`: from `PaymentRequirements.network`
- `verifyingContract`: `PaymentRequirements.extra.settlementContract`

Types:

```javascript
const types = {
  SessionApproval: [
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "asset", type: "address" },
    { name: "maxSpend", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "sessionId", type: "bytes32" },
    { name: "startNonce", type: "uint256" },
    { name: "authorizedProcessorsHash", type: "bytes32" }
  ],
  Receipt: [
    { name: "sessionId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "requestHash", type: "bytes32" }
  ]
};
```

## Verification

A verifier MUST enforce the following checks before accepting a receipt:

1. `PaymentPayload.accepted` MUST match the selected `PaymentRequirements`.
2. If `sessionApproval` is present, verify its EIP-712 signature and ensure its fields match `PaymentRequirements` (payee, asset, maxSpend, expiry, sessionId, startNonce, authorizedProcessorsHash).
3. If `sessionApproval` is absent, the session MUST already exist and match the stored approval.
4. Verify `receiptSignature` against the payer from the SessionApproval.
5. `receipt.sessionId` MUST match the SessionApproval `sessionId`.
6. `receipt.nonce` MUST equal the current `nextNonce` for the session.
7. `receipt.amount` MUST equal `PaymentRequirements.amount` and MUST NOT exceed `maxAmountPerReceipt` when configured.
8. The running session spend plus `receipt.amount` MUST be <= `maxSpend`.
9. `receipt.deadline` MUST be >= current time and MUST be <= min(current time + `maxTimeoutSeconds`, session `expiry`).
10. If `requestHash` is provided in `PaymentRequirements.extra`, the receipt value MUST match it.
11. If `authorizedProcessors` is provided, the verifier MUST ensure the selected settlement processor is allowlisted.
12. The facilitator MUST read `balanceOf(payer, asset)` from the debit wallet and ensure cumulative spend (including the current receipt) does not exceed the locked balance.
13. The facilitator MUST read `withdrawDelaySeconds()` from the debit wallet and ensure it matches `PaymentRequirements.extra.withdrawDelaySeconds`.

Upon successful verification, the verifier MUST increment `nextNonce` and record the receipt amount toward session spend.

## Settlement

Settlement is performed by submitting a batch to the `settlementContract`. In a debit-wallet model, the settlement contract typically calls `debitWallet.settleFrom` to transfer locked funds to the payee and enforces an allowlist of processors. The on-chain contract MUST enforce all of the following:

- Session state exists or is created from a valid SessionApproval signature.
- Session is not expired.
- Batch nonce range starts at the stored `nextNonce` and is contiguous.
- The total batch amount equals the sum of receipts in the range.
- Total spent after settlement does not exceed `maxSpend`.
- Transfers are executed only to the `payee` for the configured `asset`.
- Processor authorization is enforced when an allowlist is configured.

Implementations MAY verify receipts on-chain directly or by validating a succinct proof (e.g., Groth16) that attests to receipt validity and totals. Regardless of method, the contract MUST enforce the same receipt rules and update `nextNonce` atomically.

Facilitators MAY batch-settle sessions on a schedule of their choosing and perform aggregation internally. Resource servers do not call `/settle` and do not maintain settlement status.

## Appendix

- `authorizedProcessorsHash` is computed as `keccak256(abi.encodePacked(sortedLowercaseAddresses))`. If no allowlist is used, the value MUST be the zero hash.
- `sessionId` MUST be unique per payer/payee/asset. A recommended derivation is `keccak256(abi.encode(payer, payee, asset, startNonce, expiry))`.
