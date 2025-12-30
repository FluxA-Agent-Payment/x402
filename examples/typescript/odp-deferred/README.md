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
- `SETTLEMENT_MODE=onchain` executes real settlement transactions on-chain using the settlement wallet.

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

If you want to rely solely on facilitator auto-settlement, set `SKIP_MANUAL_SETTLE=true` for the client
and disable server fallback (`FALLBACK_SETTLE_INTERVAL_SECONDS=0`, `FALLBACK_SETTLE_AFTER_SECONDS=0`).

### Logging

Set `LOG_LEVEL` to `debug` for verbose output and `LOG_FORMAT=json` for structured logs.

## On-chain Base Sepolia Runbook

This flow deploys the debit wallet + settlement wallet contracts and runs the example against Base Sepolia USDC.
The reference settlement wallet trusts the allowlisted processor for receipt correctness and validates the
SessionApproval signature + nonce range + max spend on-chain.

### 1) Install Foundry

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### 2) Deploy contracts (debit wallet + settlement wallet)

```bash
cd onchain
forge install foundry-rs/forge-std

export RPC_URL="https://sepolia.base.org"
export PRIVATE_KEY="0x..."
export WITHDRAW_DELAY_SECONDS=86400
export PROCESSOR="0x..." # facilitator signer address (matches EVM_PRIVATE_KEY)

forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast
```

The script prints the `DebitWallet` and `SettlementWallet` addresses and sets the processor allowlist
and processors hash for a single facilitator address.

### 3) Configure the example

Populate `.env` in `examples/typescript/odp-deferred`:

```
EVM_PRIVATE_KEY=0x...          # facilitator/client signer
EVM_ADDRESS=0x...              # payee address
FACILITATOR_URL=http://localhost:4022
RESOURCE_SERVER_URL=http://localhost:4021
SETTLEMENT_CONTRACT=0x...      # SettlementWallet
DEBIT_WALLET_CONTRACT=0x...    # DebitWallet
WITHDRAW_DELAY_SECONDS=86400
SETTLEMENT_MODE=onchain
EVM_RPC_URL=https://base-sepolia.g.alchemy.com/v2/...
```

Make sure the `EVM_PRIVATE_KEY` account has Base Sepolia ETH for gas and Base Sepolia USDC for the deposit.

### 4) Run the flow

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

The client will auto-deposit USDC into the debit wallet if needed, then send paid requests.
In `onchain` settlement mode, the facilitator (or fallback) submits a real settlement transaction.
