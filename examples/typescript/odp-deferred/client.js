import { config } from "dotenv";
import { x402Client } from "@x402/core/client";
import { registerOdpDeferredEvmScheme } from "@x402/evm/odp-deferred/client";
import { privateKeyToAccount } from "viem/accounts";
config();
const clientPrivateKey = process.env.CLIENT_PRIVATE_KEY;
const BASE_URL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
if (!clientPrivateKey) {
    console.error("❌ CLIENT_PRIVATE_KEY environment variable is required");
    process.exit(1);
}
const url = `${BASE_URL}/metered`;
const decodeHeader = (value) => JSON.parse(Buffer.from(value, "base64").toString("utf-8"));
const encodeHeader = (value) => Buffer.from(JSON.stringify(value)).toString("base64");
async function main() {
    const account = privateKeyToAccount(clientPrivateKey);
    const client = new x402Client();
    registerOdpDeferredEvmScheme(client, { signer: account });
    const initial = await fetch(url);
    if (initial.status !== 402) {
        throw new Error(`Expected 402, got ${initial.status}`);
    }
    const paymentRequiredHeader = initial.headers.get("PAYMENT-REQUIRED");
    if (!paymentRequiredHeader) {
        throw new Error("Missing PAYMENT-REQUIRED header");
    }
    const paymentRequired = decodeHeader(paymentRequiredHeader);
    let sessionId;
    for (let i = 0; i < 3; i += 1) {
        const paymentPayload = await client.createPaymentPayload(paymentRequired);
        const paymentHeader = encodeHeader(paymentPayload);
        sessionId = paymentPayload.payload?.receipt?.sessionId;
        const response = await fetch(url, {
            headers: {
                "PAYMENT-SIGNATURE": paymentHeader,
            },
        });
        const body = await response.json();
        console.log(`Response ${i + 1}:`, body);
    }
    if (!sessionId) {
        throw new Error("Session ID missing from payload");
    }
    console.log("Session complete; facilitator will settle asynchronously.", { sessionId });
}
main().catch(error => {
    console.error(error);
    process.exit(1);
});
