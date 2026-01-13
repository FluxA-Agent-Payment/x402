import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/facilitator";
import { registerExactEvmScheme as registerExactServerScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/express";
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
};

export type RunningService = {
  url: string;
  stop: () => Promise<void>;
};

export type ExactFacilitatorConfig = {
  port?: number;
  network: string;
  signer: FacilitatorEvmSigner;
};

export type ExactServerConfig = {
  port?: number;
  facilitatorUrl: string;
  network: string;
  asset: `0x${string}`;
  price: string;
  payTo: `0x${string}`;
};

export const startExactFacilitator = async (
  config: ExactFacilitatorConfig,
): Promise<RunningService> => {
  const facilitator = new x402Facilitator();
  registerExactEvmScheme(facilitator, {
    signer: config.signer,
    networks: config.network,
  });

  const metrics: Metrics = {
    verifiedReceipts: 0,
    settledReceipts: 0,
    settlementTxCount: 0,
    settledSessions: 0,
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

      res.json(response);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.post("/settle", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body as {
        paymentPayload: PaymentPayload;
        paymentRequirements: PaymentRequirements;
      };

      const response: SettleResponse = await facilitator.settle(
        paymentPayload,
        paymentRequirements,
      );

      if (response.success) {
        metrics.settledReceipts += 1;
        metrics.settlementTxCount += 1;
        metrics.settledSessions += 1;
        metrics.firstSettlementAt = metrics.firstSettlementAt ?? Date.now();
        metrics.lastSettlementAt = Date.now();
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

export const startExactServer = async (
  config: ExactServerConfig,
): Promise<RunningService> => {
  const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient);

  registerExactServerScheme(resourceServer, {
    networks: [config.network as `eip155:${string}`],
  });

  const app = express();

  app.use(
    paymentMiddleware(
      {
        "GET /weather": {
          accepts: [
            {
              scheme: "exact",
              price: config.price,
              network: config.network,
              payTo: config.payTo,
              asset: config.asset,
            },
          ],
          description: "Benchmark weather data",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  );

  app.get("/weather", (req, res) => {
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
