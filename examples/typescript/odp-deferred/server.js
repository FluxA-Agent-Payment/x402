import { config } from "dotenv";
import express from "express";
import { HTTPFacilitatorClient, x402ResourceServer, } from "@x402/core/server";
import { OdpDeferredEvmScheme } from "@x402/evm/odp-deferred/server";
config();
const PORT = process.env.PORT || "4021";
const FACILITATOR_URL = process.env.FACILITATOR_URL;
const SERVER_ADDRESS = process.env.SERVER_ADDRESS;
if (!FACILITATOR_URL) {
    console.error("❌ FACILITATOR_URL environment variable is required");
    process.exit(1);
}
if (!SERVER_ADDRESS) {
    console.error("❌ SERVER_ADDRESS environment variable is required");
    process.exit(1);
}
const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register("eip155:84532", new OdpDeferredEvmScheme({
    maxReceiptsPerSession: 10,
    expirySeconds: 900,
}));
const routeConfig = {
    scheme: "odp-deferred",
    price: "$0.001",
    network: "eip155:84532",
    payTo: SERVER_ADDRESS,
    maxTimeoutSeconds: 60,
};
const sessionPayments = new Map();
const requirementsBySession = new Map();
async function customPaymentMiddleware(req, res, next) {
    if (req.path !== "/metered") {
        return next();
    }
    const paymentHeader = (req.headers["payment-signature"] || req.headers["x-payment"]);
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
        const sessionId = requirement.extra.sessionId;
        if (sessionId) {
            requirementsBySession.set(sessionId, requirement);
        }
        const paymentRequired = resourceServer.createPaymentRequiredResponse([requirement], resourceInfo, "Payment required");
        const header = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
        res.status(402).set("PAYMENT-REQUIRED", header).json({
            error: "Payment Required",
            message: "Provide a PAYMENT-SIGNATURE to access this endpoint",
        });
        return;
    }
    let paymentPayload;
    try {
        paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
    }
    catch (error) {
        res.status(400).json({
            error: "Invalid Payment",
            message: error instanceof Error ? error.message : "Failed to parse payment payload",
        });
        return;
    }
    const sessionId = paymentPayload.payload?.receipt
        ?.sessionId;
    const matchingRequirements = sessionId ? requirementsBySession.get(sessionId) : undefined;
    if (!matchingRequirements) {
        res.status(402).json({
            error: "Payment Requirements Mismatch",
            message: "No matching payment requirements found",
        });
        return;
    }
    const verifyResult = await resourceServer.verifyPayment(paymentPayload, matchingRequirements);
    if (!verifyResult.isValid) {
        res.status(402).json({
            error: "Invalid Payment",
            message: verifyResult.invalidReason || "Verification failed",
        });
        return;
    }
    if (sessionId) {
        sessionPayments.set(sessionId, { paymentPayload, requirements: matchingRequirements });
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
    const entry = sessionPayments.get(sessionId);
    if (!entry) {
        return res.status(404).json({
            error: "Session not found",
            message: "No receipts recorded for this session",
        });
    }
    try {
        const settleResult = await resourceServer.settlePayment(entry.paymentPayload, entry.requirements);
        if (settleResult.success) {
            sessionPayments.delete(sessionId);
            requirementsBySession.delete(sessionId);
        }
        return res.json(settleResult);
    }
    catch (error) {
        return res.status(500).json({
            error: "Settlement failed",
            message: error instanceof Error ? error.message : "Unknown error",
        });
    }
});
resourceServer.initialize().then(() => {
    app.listen(parseInt(PORT, 10), () => {
        console.log(`ODP resource server listening on http://localhost:${PORT}`);
    });
});
