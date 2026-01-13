import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { resolve } from "path";

export type ScenarioConfig = {
  name: string;
  sessions: number;
  paymentsPerSession: number;
  sessionConcurrency: number;
  requestConcurrency: number;
};

export type BenchmarkConfig = {
  network: string;
  asset: `0x${string}`;
  price: string;
  serverAddress: `0x${string}`;
  mock: {
    debitWallet: `0x${string}`;
    settlementContract: `0x${string}`;
    withdrawDelaySeconds: string;
    debitWalletBalance: string;
  };
  autoSettleIntervalSeconds: number;
  autoSettleMaxReceipts?: number;
  gas: {
    exactTxGas: number;
    odpTxGas: number;
    gasPriceGwei: number;
    ethUsd: number;
  };
  scenarios: ScenarioConfig[];
};

const getConfigPath = (): string => {
  if (process.env.BENCHMARK_CONFIG) {
    return resolve(process.env.BENCHMARK_CONFIG);
  }
  const url = new URL("../benchmarks.config.json", import.meta.url);
  return fileURLToPath(url);
};

const overrideNumber = (value: number, envKey: string): number => {
  const envValue = process.env[envKey];
  if (!envValue) {
    return value;
  }
  const parsed = Number(envValue);
  return Number.isFinite(parsed) ? parsed : value;
};

const overrideString = (value: string, envKey: string): string =>
  process.env[envKey] ? String(process.env[envKey]) : value;

export const loadConfig = (): BenchmarkConfig => {
  const configPath = getConfigPath();
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as BenchmarkConfig;

  return {
    ...config,
    network: overrideString(config.network, "BENCHMARK_NETWORK"),
    asset: overrideString(config.asset, "BENCHMARK_ASSET") as `0x${string}`,
    price: overrideString(config.price, "BENCHMARK_PRICE"),
    serverAddress: overrideString(
      config.serverAddress,
      "BENCHMARK_SERVER_ADDRESS",
    ) as `0x${string}`,
    mock: {
      ...config.mock,
      debitWallet: overrideString(
        config.mock.debitWallet,
        "BENCHMARK_DEBIT_WALLET",
      ) as `0x${string}`,
      settlementContract: overrideString(
        config.mock.settlementContract,
        "BENCHMARK_SETTLEMENT_CONTRACT",
      ) as `0x${string}`,
      withdrawDelaySeconds: overrideString(
        config.mock.withdrawDelaySeconds,
        "BENCHMARK_WITHDRAW_DELAY_SECONDS",
      ),
      debitWalletBalance: overrideString(
        config.mock.debitWalletBalance,
        "BENCHMARK_DEBIT_WALLET_BALANCE",
      ),
    },
    autoSettleIntervalSeconds: overrideNumber(
      config.autoSettleIntervalSeconds,
      "BENCHMARK_AUTO_SETTLE_INTERVAL_SECONDS",
    ),
    autoSettleMaxReceipts: overrideNumber(
      config.autoSettleMaxReceipts ?? 0,
      "BENCHMARK_AUTO_SETTLE_MAX_RECEIPTS",
    ),
    gas: {
      exactTxGas: overrideNumber(config.gas.exactTxGas, "BENCHMARK_EXACT_TX_GAS"),
      odpTxGas: overrideNumber(config.gas.odpTxGas, "BENCHMARK_ODP_TX_GAS"),
      gasPriceGwei: overrideNumber(config.gas.gasPriceGwei, "BENCHMARK_GAS_PRICE_GWEI"),
      ethUsd: overrideNumber(config.gas.ethUsd, "BENCHMARK_ETH_USD"),
    },
  };
};
