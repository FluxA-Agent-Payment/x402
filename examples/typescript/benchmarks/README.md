# x402 Benchmark (Exact vs ODP-Deferred)

This benchmark compares x402 v2 "exact" (per-request settlement) against `odp-deferred` (session-based, deferred settlement).
It runs locally with synthetic settlement and collects end-to-end latency, throughput (payments/sec after settlement),
gas cost estimates (settlement only), real money cost (USD), and number of settlement transactions.

## What It Measures

- **Latency (avg)**: end-to-end request latency from client → server → facilitator.
- **Throughput**: settled receipts per second, measured from first request to final settlement.
- **Gas cost**: estimated gas units for settlement transactions only (no approve/deposit).
- **Real money cost**: synthetic ETH → USD conversion based on config.
- **Transactions**: settlement transaction count (exact = one per request, ODP = one per session/batch).

## Setup

1) Install dependencies:

```bash
cd ../
pnpm install
```

2) Build the x402 packages used by the benchmark:

```bash
pnpm -C ../../typescript build
```

3) Run the benchmark:

```bash
pnpm bench:x402
```

Outputs are written to `examples/typescript/benchmarks/results/` as both JSON and Markdown.

## Config

Default settings live in `examples/typescript/benchmarks/benchmarks.config.json`.
You can override any key with environment variables:

```bash
export BENCHMARK_CONFIG=./benchmarks.config.json
export BENCHMARK_NETWORK=eip155:84532
export BENCHMARK_ASSET=0x036CbD53842c5426634e7929541eC2318f3dCF7e
export BENCHMARK_SERVER_ADDRESS=0x000000000000000000000000000000000000dEaD

export BENCHMARK_DEBIT_WALLET=0x0000000000000000000000000000000000000001
export BENCHMARK_SETTLEMENT_CONTRACT=0x0000000000000000000000000000000000000002
export BENCHMARK_WITHDRAW_DELAY_SECONDS=86400
export BENCHMARK_DEBIT_WALLET_BALANCE=100000000000

export BENCHMARK_AUTO_SETTLE_INTERVAL_SECONDS=1
export BENCHMARK_AUTO_SETTLE_MAX_RECEIPTS=200

export BENCHMARK_EXACT_TX_GAS=65000
export BENCHMARK_ODP_TX_GAS=120000
export BENCHMARK_GAS_PRICE_GWEI=10
export BENCHMARK_ETH_USD=3000
```

Client signer (used for payment signatures):

```bash
export CLIENT_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
```

If `CLIENT_PRIVATE_KEY` is omitted, the benchmark uses the test key above.

## Scenarios

Default scenarios are in `benchmarks.config.json`:

- `single-session-heavy`: one payer → one payee with many payments (session ideal case)
- `multi-session`: multiple sessions in parallel

Adjust `sessions`, `paymentsPerSession`, and concurrency fields to add more data points.

## Notes

- The benchmark uses **synthetic settlement** (no on-chain RPC).
- Gas and USD costs are **estimates** based on config values.
- For ODP, settlement happens asynchronously via facilitator auto-settlement.
