import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient, ResourceConfig, x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import { registerOdpDeferredEvmScheme } from "@x402/evm/odp-deferred/facilitator";
import { OdpDeferredEvmScheme } from "@x402/evm/odp-deferred/server";
import type { FacilitatorEvmSigner } from "@x402/evm";

type Metrics = {
  verifiedReceipts: number;
  settledReceipts: number;
  settlementTxCount: number;
  settledSessions: number;
  firstVerifyAt?: number;
  lastVerifyAt?: number;
  firstSettlementAt?: number;
  lastSettlementAt?: number;
  pendingSessions: number;
};

export type RunningService = {
  url: string;
  stop: () => Promise<void>;
};

export type OdpFacilitatorConfig = {
  port?: number;
  network: string;
  signer: FacilitatorEvmSigner;
  settlementContract: `0x${string}`;
  debitWallet: `0x${string}`;
  withdrawDelaySeconds: string;
  authorizedProcessors?: `0x${string}`[];
  autoSettleIntervalSeconds: number;
  maxReceiptsPerSettlement?: number;
};

export type OdpServerConfig = {
  port?: number;
  facilitatorUrl: string;
  network: string;
  price: string;
  payTo: `0x${string}`;
  maxTimeoutSeconds: number;
  maxReceiptsPerSession: number;
  expirySeconds: number;
};

type PendingSession = {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  receiptCount: number;
  settling: boolean;
};

export const startOdpFacilitator = async (
  config: OdpFacilitatorConfig,
): Promise<RunningService> => {
  const facilitator = new x402Facilitator();

  registerOdpDeferredEvmScheme(facilitator, {
    signer: config.signer,
    networks: config.network,
    settlementContract: config.settlementContract,
    debitWallet: config.debitWallet,
    withdrawDelaySeconds: config.withdrawDelaySeconds,
    settlementMode: "synthetic",
    authorizedProcessors: config.authorizedProcessors,
    maxReceiptsPerSettlement: config.maxReceiptsPerSettlement,
  });

  const metrics: Metrics = {
    verifiedReceipts: 0,
    settledReceipts: 0,
    settlementTxCount: 0,
    settledSessions: 0,
    pendingSessions: 0,
  };

  const pendingSessions = new Map<string, PendingSession>();

  const getSessionId = (payload: PaymentPayload): string | undefined => {
    const receipt = (payload.payload as { receipt?: { sessionId?: string } })?.receipt;
    return receipt?.sessionId;
  };

  const app = express();
  app.use(express.json());

  app.post("/verify", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };

      const response: VerifyResponse = await facilitator.verify(
        paymentPayload,
        paymentRequirements,
      );

      metrics.verifiedReceipts += 1;
      metrics.firstVerifyAt = metrics.firstVerifyAt ?? Date.now();
      metrics.lastVerifyAt = Date.now();

      if (response.isValid) {
        const sessionId = getSessionId(paymentPayload);
        if (sessionId) {
          const existing = pendingSessions.get(sessionId);
          pendingSessions.set(sessionId, {
            paymentPayload,
            paymentRequirements,
            receiptCount: existing ? existing.receiptCount + 1 : 1,
            settling: existing?.settling ?? false,
          });
          metrics.pendingSessions = pendingSessions.size;
        }
      }

      res.json(response);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.get("/supported", (req, res) => {
    res.json(facilitator.getSupported());
  });

  app.get("/benchmark/metrics", (req, res) => {
    res.json(metrics);
  });

  const runAutoSettlement = async (): Promise<void> => {
    if (pendingSessions.size === 0) {
      return;
    }

    const maxReceiptsPerSettlement =
      config.maxReceiptsPerSettlement && config.maxReceiptsPerSettlement > 0
        ? config.maxReceiptsPerSettlement
        : undefined;

    for (const [sessionId, entry] of pendingSessions) {
      if (entry.settling) {
        continue;
      }

      if (entry.receiptCount <= 0) {
        pendingSessions.delete(sessionId);
        metrics.pendingSessions = pendingSessions.size;
        continue;
      }

      const settleCount = maxReceiptsPerSettlement
        ? Math.min(entry.receiptCount, maxReceiptsPerSettlement)
        : entry.receiptCount;

      if (settleCount <= 0) {
        continue;
      }

      pendingSessions.set(sessionId, { ...entry, settling: true });

      try {
        const response = await facilitator.settle(
          entry.paymentPayload,
          entry.paymentRequirements,
        );

        if (response.success) {
          const current = pendingSessions.get(sessionId);
          const remainingReceipts = Math.max(
            0,
            (current?.receiptCount ?? entry.receiptCount) - settleCount,
          );

          if (remainingReceipts === 0) {
            pendingSessions.delete(sessionId);
            metrics.pendingSessions = pendingSessions.size;
            metrics.settledSessions += 1;
          } else if (current) {
            pendingSessions.set(sessionId, {
              ...current,
              receiptCount: remainingReceipts,
              settling: false,
            });
          }

          metrics.settlementTxCount += 1;
          metrics.settledReceipts += settleCount;
          metrics.firstSettlementAt = metrics.firstSettlementAt ?? Date.now();
          metrics.lastSettlementAt = Date.now();
        }
      } catch {
        // Ignore settlement errors for benchmark runs.
      } finally {
        const current = pendingSessions.get(sessionId);
        if (current) {
          pendingSessions.set(sessionId, { ...current, settling: false });
        }
      }
    }
  };

  const interval = setInterval(() => {
    void runAutoSettlement();
  }, Math.max(1, config.autoSettleIntervalSeconds) * 1000);

  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(config.port ?? 0, () => resolve(listener));
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind facilitator port");
  }

  return {
    url: `http://localhost:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(interval);
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
};

export const startOdpServer = async (config: OdpServerConfig): Promise<RunningService> => {
  const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    config.network,
    new OdpDeferredEvmScheme({
      maxReceiptsPerSession: config.maxReceiptsPerSession,
      expirySeconds: config.expirySeconds,
    }),
  );

  await resourceServer.initialize();

  const routeConfig: ResourceConfig = {
    scheme: "odp-deferred",
    price: config.price,
    network: config.network,
    payTo: config.payTo,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
  };

  const requirementsBySession = new Map<string, PaymentRequirements>();

  const app = express();
  app.use(express.json());

  app.use(async (req, res, next) => {
    if (req.path !== "/metered") {
      return next();
    }

    const paymentHeader = (req.headers["payment-signature"] || req.headers["x-payment"]) as
      | string
      | undefined;

    const resourceInfo = {
      url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
      description: "Benchmark metered data",
      mimeType: "application/json",
    };

    if (!paymentHeader) {
      const requirements = await resourceServer.buildPaymentRequirements(routeConfig);
      const requirement = requirements[0];
      if (!requirement) {
        res.status(500).json({
          error: "No payment requirements generated",
        });
        return;
      }

      const sessionId = requirement.extra?.sessionId as string | undefined;
      if (sessionId) {
        requirementsBySession.set(sessionId, requirement);
      }

      const paymentRequired = resourceServer.createPaymentRequiredResponse(
        [requirement],
        resourceInfo,
        "Payment required",
      );

      const header = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
      res.status(402).set("PAYMENT-REQUIRED", header).json({
        error: "Payment Required",
      });
      return;
    }

    let paymentPayload: PaymentPayload;
    try {
      paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid payment payload",
      });
      return;
    }

    const sessionId = (paymentPayload.payload as { receipt?: { sessionId?: string } })?.receipt
      ?.sessionId;
    const matchingRequirements = sessionId ? requirementsBySession.get(sessionId) : undefined;

    if (!matchingRequirements) {
      res.status(402).json({
        error: "Payment Requirements Mismatch",
      });
      return;
    }

    const verifyResult = await resourceServer.verifyPayment(
      paymentPayload,
      matchingRequirements,
    );

    if (!verifyResult.isValid) {
      res.status(402).json({
        error: "Invalid Payment",
        details: verifyResult.invalidReason,
      });
      return;
    }

    next();
  });

  app.get("/metered", (req, res) => {
    res.json({
      report: {
        weather: "sunny",
        temperature: 70,
        timestamp: new Date().toISOString(),
      },
    });
  });

  const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
    const listener = app.listen(config.port ?? 0, () => resolve(listener));
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind server port");
  }

  return {
    url: `http://localhost:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
};
