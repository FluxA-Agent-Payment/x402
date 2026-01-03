import { config } from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { registerOdpDeferredEvmScheme } from "@x402/evm/odp-deferred/facilitator";
config();
const PORT = process.env.PORT || "4022";
const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY;
if (!FACILITATOR_PRIVATE_KEY) {
    console.error("❌ FACILITATOR_PRIVATE_KEY environment variable is required");
    process.exit(1);
}
const settlementContract = process.env.SETTLEMENT_CONTRACT ||
    "0x0000000000000000000000000000000000000001";
const authorizedProcessors = process.env.AUTHORIZED_PROCESSORS
    ? process.env.AUTHORIZED_PROCESSORS.split(",").map(value => value.trim())
    : [];
const facilitatorAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY);
const viemClient = createWalletClient({
    account: facilitatorAccount,
    chain: baseSepolia,
    transport: http(),
}).extend(publicActions);
const facilitatorSigner = toFacilitatorEvmSigner({
    address: facilitatorAccount.address,
    readContract: (args) => viemClient.readContract({
        ...args,
        args: args.args || [],
    }),
    verifyTypedData: (args) => viemClient.verifyTypedData(args),
    writeContract: (args) => viemClient.writeContract({
        ...args,
        args: args.args || [],
    }),
    sendTransaction: (args) => viemClient.sendTransaction(args),
    waitForTransactionReceipt: (args) => viemClient.waitForTransactionReceipt(args),
    getCode: (args) => viemClient.getCode(args),
});
const facilitator = new x402Facilitator();
registerOdpDeferredEvmScheme(facilitator, {
    signer: facilitatorSigner,
    networks: "eip155:84532",
    settlementContract,
    authorizedProcessors: authorizedProcessors.length > 0 ? authorizedProcessors : [facilitatorAccount.address],
});
const app = express();
app.use(express.json());
app.post("/verify", async (req, res) => {
    try {
        const { paymentPayload, paymentRequirements } = req.body;
        if (!paymentPayload || !paymentRequirements) {
            return res.status(400).json({
                error: "Missing paymentPayload or paymentRequirements",
            });
        }
        const response = await facilitator.verify(paymentPayload, paymentRequirements);
        res.json(response);
    }
    catch (error) {
        console.error("Verify error:", error);
        res.status(500).json({
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
});
app.post("/settle", async (req, res) => {
    try {
        const { paymentPayload, paymentRequirements } = req.body;
        if (!paymentPayload || !paymentRequirements) {
            return res.status(400).json({
                error: "Missing paymentPayload or paymentRequirements",
            });
        }
        const response = await facilitator.settle(paymentPayload, paymentRequirements);
        res.json(response);
    }
    catch (error) {
        console.error("Settle error:", error);
        res.status(500).json({
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
});
app.get("/supported", (req, res) => {
    try {
        res.json(facilitator.getSupported());
    }
    catch (error) {
        console.error("Supported error:", error);
        res.status(500).json({
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
});
app.listen(parseInt(PORT, 10), () => {
    console.log(`ODP facilitator listening on http://localhost:${PORT}`);
});
