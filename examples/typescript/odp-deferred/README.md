# ODP Deferred Scheme Example

This example demonstrates the `odp-deferred` scheme with deferred settlement on EVM, including debit wallet funding and facilitator-side batch settlement.

## Setup

```bash
cd ../
pnpm install && pnpm build
cd odp-deferred
```

## Environment Variables

Create a `.env` file (or export env vars) with:

```
EVM_PRIVATE_KEY=0x...
EVM_ADDRESS=0x...
FACILITATOR_URL=http://localhost:4022
RESOURCE_SERVER_URL=http://localhost:4021
SETTLEMENT_CONTRACT=0x0000000000000000000000000000000000000001
DEBIT_WALLET_CONTRACT=0x0000000000000000000000000000000000000002
WITHDRAW_DELAY_SECONDS=86400
AUTHORIZED_PROCESSORS=0x...,0x...
AUTO_SETTLE_INTERVAL_SECONDS=15
AUTO_SETTLE_AFTER_SECONDS=30
FALLBACK_SETTLE_INTERVAL_SECONDS=30
FALLBACK_SETTLE_AFTER_SECONDS=120
AUTO_DEPOSIT=true
EVM_RPC_URL=https://base-sepolia.g.alchemy.com/v2/...
```

Notes:
- `AUTHORIZED_PROCESSORS` is optional; if omitted, the facilitator address is used.
- `SETTLEMENT_CONTRACT` is a placeholder for demo purposes.
- `DEBIT_WALLET_CONTRACT` must be a deployed debit wallet contract implementing the interface in the spec.
- `WITHDRAW_DELAY_SECONDS` should match the on-chain contract value.
- `AUTO_DEPOSIT` requires `EVM_RPC_URL` and will approve/deposit ERC-20 funds if the balance is insufficient.

## Run

Terminal 1 (facilitator):

```bash
pnpm start:facilitator
```

Terminal 2 (server):

```bash
pnpm start:server
```

Terminal 3 (client):

```bash
pnpm start:client
```

The client sends three paid requests that are verified but not settled. It then calls the
`/settle/:sessionId` endpoint to trigger batch settlement.

The facilitator also runs a background scheduler that batch-settles sessions once they have been idle
for `AUTO_SETTLE_AFTER_SECONDS`. The server fallback scheduler can call `/settle` when a session has
not been settled within `FALLBACK_SETTLE_AFTER_SECONDS`.
