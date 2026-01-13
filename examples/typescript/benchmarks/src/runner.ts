import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerOdpDeferredEvmScheme } from "@x402/evm/odp-deferred/client";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentRequired } from "@x402/core/types";
import { createMockSigner } from "./mockSigner";
import { loadConfig, ScenarioConfig } from "./config";
import { startExactFacilitator, startExactServer } from "./services/exact";
import { startOdpFacilitator, startOdpServer } from "./services/odp";
import {
  average,
  decodePaymentRequired,
  encodePaymentPayload,
  runWithConcurrency,
  sleep,
} from "./utils";

type ScenarioResult = {
  scheme: "exact" | "odp-deferred";
  scenario: ScenarioConfig;
  totals: {
    sessions: number;
    paymentsPerSession: number;
    totalPayments: number;
  };
  latency: {
    avgMs: number;
  };
  throughput: {
    paymentsPerSecond: number;
  };
  settlement: {
    settledReceipts: number;
    settlementTxCount: number;
  };
  gas: {
    units: number;
    costEth: number;
    costUsd: number;
  };
  timing: {
    requestStartAt: number;
    requestEndAt: number;
    settlementEndAt: number;
  };
};

type MetricsResponse = {
  verifiedReceipts?: number;
  settledReceipts?: number;
  settlementTxCount?: number;
  pendingSessions?: number;
  lastSettlementAt?: number;
};

const fetchPaymentRequired = async (url: string): Promise<PaymentRequired> => {
  const response = await fetch(url);
  if (response.status !== 402) {
    throw new Error(`Expected 402 payment required, got ${response.status}`);
  }
  const header = response.headers.get("PAYMENT-REQUIRED");
  if (!header) {
    throw new Error("Missing PAYMENT-REQUIRED header");
  }
  return decodePaymentRequired(header);
};

const waitForSettlement = async (
  url: string,
  expectedReceipts: number,
  timeoutMs: number,
): Promise<MetricsResponse> => {
  const start = Date.now();
  let lastMetrics: MetricsResponse = {};

  while (Date.now() - start < timeoutMs) {
    const response = await fetch(url);
    lastMetrics = (await response.json()) as MetricsResponse;
    const settledReceipts = lastMetrics.settledReceipts || 0;
    const pendingSessions = lastMetrics.pendingSessions;
    const pendingClear = pendingSessions === undefined || pendingSessions === 0;

    if (settledReceipts >= expectedReceipts && pendingClear) {
      return lastMetrics;
    }
    await sleep(200);
  }

  const settledReceipts = lastMetrics.settledReceipts || 0;
  const pendingSessions = lastMetrics.pendingSessions;
  throw new Error(
    `Settlement incomplete after ${timeoutMs}ms (settled ${settledReceipts}/${expectedReceipts}, pendingSessions ${pendingSessions ?? "n/a"})`,
  );
};

const runExactScenario = async (
  scenario: ScenarioConfig,
  config: ReturnType<typeof loadConfig>,
  clientKey: `0x${string}`,
  facilitatorAddress: `0x${string}`,
): Promise<ScenarioResult> => {
  const mockSigner = createMockSigner({
    address: facilitatorAddress,
    debitWalletBalance: BigInt(config.mock.debitWalletBalance),
    withdrawDelaySeconds: BigInt(config.mock.withdrawDelaySeconds),
  });

  const facilitator = await startExactFacilitator({
    network: config.network,
    signer: mockSigner,
  });

  const server = await startExactServer({
    facilitatorUrl: facilitator.url,
    network: config.network,
    asset: config.asset,
    price: config.price,
    payTo: config.serverAddress,
  });

  const client = new x402Client();
  const account = privateKeyToAccount(clientKey);
  registerExactEvmScheme(client, { signer: account });

  const endpoint = `${server.url}/weather`;
  const paymentRequired = await fetchPaymentRequired(endpoint);

  const totalPayments = scenario.sessions * scenario.paymentsPerSession;
  const latencies: number[] = [];
  const requestStartAt = Date.now();

  const tasks = Array.from({ length: totalPayments }).map(() => async () => {
    const start = Date.now();
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const paymentHeader = encodePaymentPayload(paymentPayload);

    const response = await fetch(endpoint, {
      headers: {
        "PAYMENT-SIGNATURE": paymentHeader,
      },
    });

    if (!response.ok) {
      throw new Error(`Exact request failed: ${response.status}`);
    }

    await response.arrayBuffer();
    const end = Date.now();
    latencies.push(end - start);

    return response.status;
  });

  await runWithConcurrency(tasks, Math.max(1, scenario.requestConcurrency));
  const requestEndAt = Date.now();

  const settleTimeoutMs = Math.max(60_000, totalPayments * 5);
  const metrics = await waitForSettlement(
    `${facilitator.url}/benchmark/metrics`,
    totalPayments,
    settleTimeoutMs,
  );

  const settlementEndAt = metrics.lastSettlementAt ?? requestEndAt;
  const endToEndMs = Math.max(1, settlementEndAt - requestStartAt);
  const settledReceipts = metrics.settledReceipts ?? totalPayments;
  const settlementTxCount = metrics.settlementTxCount ?? totalPayments;

  await server.stop();
  await facilitator.stop();

  const gasUnits = settlementTxCount * config.gas.exactTxGas;
  const gasCostEth = (gasUnits * config.gas.gasPriceGwei) / 1e9;
  const gasCostUsd = gasCostEth * config.gas.ethUsd;

  return {
    scheme: "exact",
    scenario,
    totals: {
      sessions: scenario.sessions,
      paymentsPerSession: scenario.paymentsPerSession,
      totalPayments,
    },
    latency: {
      avgMs: average(latencies),
    },
    throughput: {
      paymentsPerSecond: settledReceipts / (endToEndMs / 1000),
    },
    settlement: {
      settledReceipts,
      settlementTxCount,
    },
    gas: {
      units: gasUnits,
      costEth: gasCostEth,
      costUsd: gasCostUsd,
    },
    timing: {
      requestStartAt,
      requestEndAt,
      settlementEndAt,
    },
  };
};

const runOdpScenario = async (
  scenario: ScenarioConfig,
  config: ReturnType<typeof loadConfig>,
  clientKey: `0x${string}`,
  facilitatorAddress: `0x${string}`,
): Promise<ScenarioResult> => {
  const mockSigner = createMockSigner({
    address: facilitatorAddress,
    debitWalletBalance: BigInt(config.mock.debitWalletBalance),
    withdrawDelaySeconds: BigInt(config.mock.withdrawDelaySeconds),
  });

  const facilitator = await startOdpFacilitator({
    network: config.network,
    signer: mockSigner,
    settlementContract: config.mock.settlementContract,
    debitWallet: config.mock.debitWallet,
    withdrawDelaySeconds: config.mock.withdrawDelaySeconds,
    authorizedProcessors: [facilitatorAddress],
    autoSettleIntervalSeconds: config.autoSettleIntervalSeconds,
    maxReceiptsPerSettlement:
      config.autoSettleMaxReceipts && config.autoSettleMaxReceipts > 0
        ? config.autoSettleMaxReceipts
        : undefined,
  });

  const server = await startOdpServer({
    facilitatorUrl: facilitator.url,
    network: config.network,
    price: config.price,
    payTo: config.serverAddress,
    maxTimeoutSeconds: 60,
    maxReceiptsPerSession: scenario.paymentsPerSession,
    expirySeconds: 3600,
  });

  const client = new x402Client();
  const account = privateKeyToAccount(clientKey);
  registerOdpDeferredEvmScheme(client, { signer: account });

  const endpoint = `${server.url}/metered`;

  const sessions: PaymentRequired[] = [];
  for (let i = 0; i < scenario.sessions; i += 1) {
    sessions.push(await fetchPaymentRequired(endpoint));
  }

  const latencies: number[] = [];
  const requestStartAt = Date.now();

  const sessionTasks = sessions.map((paymentRequired, sessionIndex) => async () => {
    for (let i = 0; i < scenario.paymentsPerSession; i += 1) {
      const start = Date.now();
      const paymentPayload = await client.createPaymentPayload(paymentRequired);
      const paymentHeader = encodePaymentPayload(paymentPayload);

      const response = await fetch(endpoint, {
        headers: {
          "PAYMENT-SIGNATURE": paymentHeader,
        },
      });

      if (!response.ok) {
        throw new Error(`ODP request failed: ${response.status}`);
      }

      await response.arrayBuffer();
      const end = Date.now();
      latencies.push(end - start);
    }
    return sessionIndex;
  });

  await runWithConcurrency(sessionTasks, Math.max(1, scenario.sessionConcurrency));
  const requestEndAt = Date.now();

  const totalPayments = scenario.sessions * scenario.paymentsPerSession;
  const maxReceipts = config.autoSettleMaxReceipts && config.autoSettleMaxReceipts > 0
    ? config.autoSettleMaxReceipts
    : scenario.paymentsPerSession;
  const expectedBatches = Math.ceil(scenario.paymentsPerSession / Math.max(1, maxReceipts));
  const settleIntervalMs = Math.max(1, config.autoSettleIntervalSeconds) * 1000;
  const settleTimeoutMs = Math.max(60_000, expectedBatches * settleIntervalMs * 3);
  const metrics = await waitForSettlement(
    `${facilitator.url}/benchmark/metrics`,
    totalPayments,
    settleTimeoutMs,
  );

  const settlementEndAt = metrics.lastSettlementAt ?? requestEndAt;
  const endToEndMs = Math.max(1, settlementEndAt - requestStartAt);
  const settledReceipts = metrics.settledReceipts ?? 0;
  const settlementTxCount = metrics.settlementTxCount ?? 0;

  await server.stop();
  await facilitator.stop();

  const gasUnits = settlementTxCount * config.gas.odpTxGas;
  const gasCostEth = (gasUnits * config.gas.gasPriceGwei) / 1e9;
  const gasCostUsd = gasCostEth * config.gas.ethUsd;

  return {
    scheme: "odp-deferred",
    scenario,
    totals: {
      sessions: scenario.sessions,
      paymentsPerSession: scenario.paymentsPerSession,
      totalPayments,
    },
    latency: {
      avgMs: average(latencies),
    },
    throughput: {
      paymentsPerSecond: settledReceipts / (endToEndMs / 1000),
    },
    settlement: {
      settledReceipts,
      settlementTxCount,
    },
    gas: {
      units: gasUnits,
      costEth: gasCostEth,
      costUsd: gasCostUsd,
    },
    timing: {
      requestStartAt,
      requestEndAt,
      settlementEndAt,
    },
  };
};

export const runBenchmarks = async (): Promise<ScenarioResult[]> => {
  const config = loadConfig();

  const clientKey =
    (process.env.CLIENT_PRIVATE_KEY as `0x${string}` | undefined) ??
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

  const facilitatorAddress =
    (process.env.FACILITATOR_ADDRESS as `0x${string}` | undefined) ??
    "0x000000000000000000000000000000000000fAac";

  const results: ScenarioResult[] = [];

  for (const scenario of config.scenarios) {
    results.push(await runExactScenario(scenario, config, clientKey, facilitatorAddress));
    results.push(await runOdpScenario(scenario, config, clientKey, facilitatorAddress));
  }

  return results;
};
