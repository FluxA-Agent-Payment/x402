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
});

const routeConfig: ResourceConfig = {
  scheme: "odp-deferred",
  price: "$0.001",
  network: "eip155:84532",
  payTo: SERVER_ADDRESS,
  maxTimeoutSeconds: 60,
};

const requirementsBySession = new Map<string, PaymentRequirements>();

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

resourceServer.initialize().then(() => {
  app.listen(parseInt(PORT, 10), () => {
    logger.info("ODP resource server listening", {
      url: `http://localhost:${PORT}`,
    });
  });
});
