# ODP Deferred Scheme Example

This example demonstrates the `odp-deferred` scheme with deferred settlement on EVM.

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
AUTHORIZED_PROCESSORS=0x...,0x...
```

Notes:
- `AUTHORIZED_PROCESSORS` is optional; if omitted, the facilitator address is used.
- `SETTLEMENT_CONTRACT` is a placeholder for demo purposes.

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
