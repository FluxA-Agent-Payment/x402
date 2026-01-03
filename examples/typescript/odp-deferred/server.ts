import { config } from "dotenv";
import express, { NextFunction, Request, Response } from "express";
import {
  HTTPFacilitatorClient,
  ResourceConfig,
  x402ResourceServer,
} from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { OdpDeferredEvmScheme } from "@x402/evm/odp-deferred/server";
import { createLogger } from "./logger";

config();

const logger = createLogger({ component: "server" });

const PORT = process.env.PORT || "4021";
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const SERVER_ADDRESS = process.env.SERVER_ADDRESS as `0x${string}` | undefined;
const fallbackSettleIntervalSeconds = Number(
  process.env.FALLBACK_SETTLE_INTERVAL_SECONDS || "30",
);
const fallbackSettleAfterSeconds = Number(process.env.FALLBACK_SETTLE_AFTER_SECONDS || "120");

if (!FACILITATOR_URL) {
  logger.error("FACILITATOR_URL environment variable is required");
  process.exit(1);
}

if (!SERVER_ADDRESS) {
  logger.error("SERVER_ADDRESS environment variable is required");
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(
  "eip155:84532",
  new OdpDeferredEvmScheme({
    maxReceiptsPerSession: 10,
    expirySeconds: 900,
  }),
);

logger.info("ODP resource server config", {
  port: PORT,
  facilitatorUrl: FACILITATOR_URL,
  payTo: SERVER_ADDRESS,
  fallbackSettleIntervalSeconds,
  fallbackSettleAfterSeconds,
});

const routeConfig: ResourceConfig = {
  scheme: "odp-deferred",
  price: "$0.001",
  network: "eip155:84532",
  payTo: SERVER_ADDRESS,
  maxTimeoutSeconds: 60,
};

const sessionPayments = new Map<
  string,
  { paymentPayload: PaymentPayload; requirements: PaymentRequirements; lastReceiptAt: number }
>();
const requirementsBySession = new Map<string, PaymentRequirements>();

const settleSession = async (sessionId: string) => {
  const entry = sessionPayments.get(sessionId);

  if (!entry) {
    return undefined;
  }

  const settleResult = await resourceServer.settlePayment(
    entry.paymentPayload,
    entry.requirements,
  );

  if (settleResult.success) {
    sessionPayments.delete(sessionId);
    requirementsBySession.delete(sessionId);
  }

  return settleResult;
};

async function customPaymentMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.path !== "/metered") {
    return next();
  }

  const paymentHeader = (req.headers["payment-signature"] || req.headers["x-payment"]) as
    | string
    | undefined;

  const resourceInfo = {
    url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
    description: "Metered weather data",
    mimeType: "application/json",
  };

  if (!paymentHeader) {
    const requirements = await resourceServer.buildPaymentRequirements(routeConfig);
    const requirement = requirements[0];

    if (!requirement) {
      res.status(500).json({
        error: "Server configuration error",
        message: "No payment requirements generated",
      });
      return;
    }

    const sessionId = requirement.extra.sessionId as string | undefined;
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
      message: "Provide a PAYMENT-SIGNATURE to access this endpoint",
    });
    logger.info("Issued payment requirements", { sessionId, route: req.path });
    return;
  }

  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
  } catch (error) {
    res.status(400).json({
      error: "Invalid Payment",
      message: error instanceof Error ? error.message : "Failed to parse payment payload",
    });
    return;
  }

  const sessionId = (paymentPayload.payload as { receipt?: { sessionId?: string } })?.receipt
    ?.sessionId;
  const matchingRequirements = sessionId ? requirementsBySession.get(sessionId) : undefined;

  if (!matchingRequirements) {
    res.status(402).json({
      error: "Payment Requirements Mismatch",
      message: "No matching payment requirements found",
    });
    logger.warn("Payment requirements missing", { sessionId });
    return;
  }

  const verifyResult = await resourceServer.verifyPayment(paymentPayload, matchingRequirements);

  if (!verifyResult.isValid) {
    res.status(402).json({
      error: "Invalid Payment",
      message: verifyResult.invalidReason || "Verification failed",
    });
    logger.warn("Payment verification failed", {
      sessionId,
      invalidReason: verifyResult.invalidReason,
    });
    return;
  }

  if (sessionId) {
    sessionPayments.set(sessionId, {
      paymentPayload,
      requirements: matchingRequirements,
      lastReceiptAt: Date.now(),
    });
    logger.debug("Receipt accepted", { sessionId, payer: verifyResult.payer });
  }

  res.locals.paymentPayload = paymentPayload;
  res.locals.paymentRequirements = matchingRequirements;

  next();
}

const app = express();
app.use(express.json());
app.use(customPaymentMiddleware);

app.get("/metered", (req, res) => {
  res.json({
    report: {
      weather: "sunny",
      temperature: 70,
      timestamp: new Date().toISOString(),
    },
  });
});

app.post("/settle/:sessionId", async (req, res) => {
  const sessionId = req.params.sessionId;

  try {
    const settleResult = await settleSession(sessionId);

    if (!settleResult) {
      return res.status(404).json({
        error: "Session not found",
        message: "No receipts recorded for this session",
      });
    }

    if (settleResult.success) {
      logger.info("Manual settlement succeeded", {
        sessionId,
        transaction: settleResult.transaction,
      });
    } else {
      logger.warn("Manual settlement failed", {
        sessionId,
        errorReason: settleResult.errorReason,
      });
    }

    return res.json(settleResult);
  } catch (error) {
    logger.error("Manual settlement error", { sessionId, error });
    return res.status(500).json({
      error: "Settlement failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

const runFallbackSettlement = async (): Promise<void> => {
  if (sessionPayments.size === 0) {
    return;
  }

  const now = Date.now();
  for (const [sessionId, entry] of sessionPayments) {
    if (fallbackSettleAfterSeconds <= 0) {
      continue;
    }

    if (now - entry.lastReceiptAt < fallbackSettleAfterSeconds * 1000) {
      continue;
    }

    try {
      const settleResult = await settleSession(sessionId);
      if (settleResult?.success) {
        logger.info("Fallback-settled session", {
          sessionId,
          transaction: settleResult.transaction,
        });
      }
    } catch (error) {
      logger.error("Fallback settlement error", { sessionId, error });
    }
  }
};

if (fallbackSettleIntervalSeconds > 0 && fallbackSettleAfterSeconds > 0) {
  setInterval(() => {
    void runFallbackSettlement();
  }, fallbackSettleIntervalSeconds * 1000);
}

resourceServer.initialize().then(() => {
  app.listen(parseInt(PORT, 10), () => {
    logger.info("ODP resource server listening", {
      url: `http://localhost:${PORT}`,
    });
  });
});
