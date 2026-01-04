# ODP Deferred Scheme Example

This example demonstrates the `odp-deferred` scheme with deferred settlement on EVM, including debit wallet
funding and facilitator-side batch settlement.

## Playbook (Step-by-Step)

1) Install dependencies and build the workspace packages:

```bash
cd ../
pnpm install
pnpm build:odp-deferred
cd odp-deferred
```

The build script uses Turbo to build `@x402/odp-deferred-example` and its dependency graph only.

2) Create your environment file:

```bash
cp .env.example .env
```

Fill in the values in `.env` using the explanations in the next section. Make sure the key you use has
testnet ETH for gas and the target ERC-20 (Base Sepolia USDC if running the on-chain flow). Use a
different key for the facilitator and the client.

3) (Optional, on-chain only) Deploy the debit wallet + settlement wallet contracts.

See "On-chain Base Sepolia Runbook" below for the Foundry flow.

4) Start the facilitator (skip if you are using an external facilitator):

```bash
pnpm start:facilitator
```

5) Start the resource server:

```bash
pnpm start:server
```

6) Run the client:

```bash
pnpm start:client
```

7) Verify settlement behavior:

- Manual settlement: the client calls `POST /settle/:sessionId` and the logs show "Settlement succeeded".
- Auto settlement: set `SKIP_MANUAL_SETTLE=true`, disable fallback (`FALLBACK_SETTLE_INTERVAL_SECONDS=0`,
  `FALLBACK_SETTLE_AFTER_SECONDS=0`), and wait for "Auto-settled session" in the facilitator logs.

## Environment Variables (Explained)

Use `.env.example` as the source of truth. The list below explains each variable and where it is used.
Client and facilitator signers are different entities; use distinct keys.

### Core wiring

| Variable | Used by | Purpose |
| --- | --- | --- |
| `FACILITATOR_PRIVATE_KEY` | facilitator | Signer for receipt verification + settlement actions. |
| `CLIENT_PRIVATE_KEY` | client | Signer for receipt creation + debit wallet funding. |
| `SERVER_ADDRESS` | server | Payee address included in payment requirements. |
| `FACILITATOR_URL` | server | Base URL for the facilitator (e.g. `http://localhost:4022`). |
| `RESOURCE_SERVER_URL` | client | Base URL for the resource server (e.g. `http://localhost:4021`). |

### Settlement + contracts

| Variable | Used by | Purpose |
| --- | --- | --- |
| `SETTLEMENT_MODE` | facilitator | `synthetic` (default) or `onchain` (real settlement tx). |
| `SETTLEMENT_CONTRACT` | facilitator | Settlement wallet contract address (owned by the facilitator). |
| `DEBIT_WALLET_CONTRACT` | facilitator, client | Deployed debit wallet contract address (owned by the client). |
| `WITHDRAW_DELAY_SECONDS` | facilitator | Must match the on-chain debit wallet configuration. |
| `AUTHORIZED_PROCESSORS` | facilitator | Comma-separated allowlist for settlement processors. |

### Scheduling controls

| Variable | Used by | Purpose |
| --- | --- | --- |
| `AUTO_SETTLE_INTERVAL_SECONDS` | facilitator | Auto-settlement scheduler tick. |
| `AUTO_SETTLE_AFTER_SECONDS` | facilitator | Minimum idle time before auto-settlement. |
| `FALLBACK_SETTLE_INTERVAL_SECONDS` | server | Server fallback scheduler tick (set `0` to disable). |
| `FALLBACK_SETTLE_AFTER_SECONDS` | server | Minimum idle time before server fallback settle. |
| `SKIP_MANUAL_SETTLE` | client | Skip manual `/settle` call to rely on auto-settlement. |

### Client funding

| Variable | Used by | Purpose |
| --- | --- | --- |
| `AUTO_DEPOSIT` | client | Auto-approve and deposit ERC-20 into the debit wallet. |
| `CLIENT_RPC_URL` | client | RPC endpoint required for `AUTO_DEPOSIT`. |

### Logging + ports

| Variable | Used by | Purpose |
| --- | --- | --- |
| `LOG_LEVEL` | all | `debug`, `info`, `warn`, or `error`. |
| `LOG_FORMAT` | all | `text` (default) or `json` for structured logs. |
| `PORT` | all | Override the default listening port per process. |

## Facilitator Deployment Options (External Access)

You can run the facilitator on a server and point the resource server at it via `FACILITATOR_URL`.
Choose one of the patterns below:

If the facilitator is hosted externally, assume the settlement contract is deployed and owned by the
facilitator. In that case, you only need to deploy your debit wallet and share its address with the
facilitator; locally you run just the server and client.

1) Public VM with open port

- Run `pnpm start:facilitator` on the VM.
- Open the port in your firewall (default `4022`).
- Set `FACILITATOR_URL=http://<public-ip>:4022` for the resource server.
- Consider restricting inbound traffic to the resource server IP.

2) Reverse proxy with TLS (recommended)

- Run the facilitator locally on the VM (e.g. port `4022`).
- Put Nginx in front and expose `https://facilitator.example.com`.
- Set `FACILITATOR_URL=https://facilitator.example.com` for the resource server.

Example Nginx snippet:

```nginx
server {
  server_name facilitator.example.com;
  location / {
    proxy_pass http://127.0.0.1:4022;
    proxy_set_header Host $host;
  }
}
```

3) Tunnel for quick review (ngrok, cloudflared)

- Run a tunnel to port `4022`.
- Use the tunnel URL as `FACILITATOR_URL`.
- Useful for short-lived demos; avoid for long-running deployments.

## Logging

Set `LOG_LEVEL=debug` for verbose output and `LOG_FORMAT=json` for structured logs.

## On-chain Base Sepolia Runbook

This flow deploys the debit wallet + settlement wallet contracts and runs the example against Base Sepolia USDC.
The reference settlement wallet trusts the allowlisted processor for receipt correctness and validates the
SessionApproval signature + nonce range + max spend on-chain.

### 1) Install Foundry

```bash
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### 2) Deploy contracts

Choose one of the following paths:

#### 2A) Run the facilitator yourself (deploy settlement + debit wallet)

```bash
cd onchain
forge install foundry-rs/forge-std

export RPC_URL="https://sepolia.base.org"
export PRIVATE_KEY="0x..."
export WITHDRAW_DELAY_SECONDS=86400
export PROCESSOR="0x..." # facilitator signer address (matches FACILITATOR_PRIVATE_KEY)

forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast
```

The script prints the `DebitWallet` and `SettlementWallet` addresses and sets the processor allowlist
and processors hash for a single facilitator address.

#### 2B) Use an external facilitator (deploy debit wallet only)

```bash
cd onchain
forge install foundry-rs/forge-std

export RPC_URL="https://sepolia.base.org"
export PRIVATE_KEY="0x..."
export WITHDRAW_DELAY_SECONDS=86400

forge create src/DebitWallet.sol:DebitWallet \
  --rpc-url $RPC_URL \
  --private-key $PRIVATE_KEY \
  --constructor-args $WITHDRAW_DELAY_SECONDS
```

Record the `DebitWallet` address, then share it with the facilitator. The facilitator will provide
the `SettlementWallet` address that it controls.

### 3) Configure the example

Populate `.env` in `examples/typescript/odp-deferred`:

```
FACILITATOR_PRIVATE_KEY=0x...  # facilitator signer (only if you run the facilitator locally)
CLIENT_PRIVATE_KEY=0x...       # client signer
SERVER_ADDRESS=0x...           # payee address
FACILITATOR_URL=http://localhost:4022
RESOURCE_SERVER_URL=http://localhost:4021
SETTLEMENT_CONTRACT=0x...      # SettlementWallet (from facilitator if external)
DEBIT_WALLET_CONTRACT=0x...    # DebitWallet (deployed by you)
WITHDRAW_DELAY_SECONDS=86400
SETTLEMENT_MODE=onchain        # only used by the facilitator
CLIENT_RPC_URL=https://base-sepolia.g.alchemy.com/v2/...
```

Make sure the facilitator signer has Base Sepolia ETH for settlement gas, and the client signer has
Base Sepolia ETH + USDC for the debit wallet deposit.
If you are not running the facilitator locally, you can leave `FACILITATOR_PRIVATE_KEY` and
`SETTLEMENT_MODE` unused on your machine; they are configured on the facilitator host.

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
