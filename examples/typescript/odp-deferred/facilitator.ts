import { config } from "dotenv";
import express from "express";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { x402Facilitator } from "@x402/core/facilitator";
import { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { registerOdpDeferredEvmScheme } from "@x402/evm/odp-deferred/facilitator";
import { createLogger } from "./logger";

config();

const logger = createLogger({ component: "facilitator" });
const schemeLogger = logger.child({ scope: "odp-deferred" });

const PORT = process.env.PORT || "4022";
const EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;

if (!EVM_PRIVATE_KEY) {
  logger.error("EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

const settlementContract =
  (process.env.SETTLEMENT_CONTRACT as `0x${string}` | undefined) ||
  "0x0000000000000000000000000000000000000001";

const debitWalletContract =
  (process.env.DEBIT_WALLET_CONTRACT as `0x${string}` | undefined) ||
  "0x0000000000000000000000000000000000000002";

const withdrawDelaySeconds = process.env.WITHDRAW_DELAY_SECONDS || "86400";

const authorizedProcessors = process.env.AUTHORIZED_PROCESSORS
  ? process.env.AUTHORIZED_PROCESSORS.split(",").map(value => value.trim())
  : [];

const autoSettleIntervalSeconds = Number(process.env.AUTO_SETTLE_INTERVAL_SECONDS || "15");
const autoSettleAfterSeconds = Number(process.env.AUTO_SETTLE_AFTER_SECONDS || "30");
const settlementMode =
  process.env.SETTLEMENT_MODE && process.env.SETTLEMENT_MODE.toLowerCase() === "onchain"
    ? "onchain"
    : "synthetic";

if (!process.env.DEBIT_WALLET_CONTRACT) {
  logger.warn("DEBIT_WALLET_CONTRACT not set, using placeholder address.");
}

const evmAccount = privateKeyToAccount(EVM_PRIVATE_KEY);

const viemClient = createWalletClient({
  account: evmAccount,
  chain: baseSepolia,
  transport: http(),
}).extend(publicActions);

const evmSigner = toFacilitatorEvmSigner({
  address: evmAccount.address,
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }) =>
    viemClient.readContract({
      ...args,
      args: args.args || [],
    }),
  verifyTypedData: (args: {
    address: `0x${string}`;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) => viemClient.verifyTypedData(args as any),
  writeContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) =>
    viemClient.writeContract({
      ...args,
      args: args.args || [],
    }),
  sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
    viemClient.sendTransaction(args),
  waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
    viemClient.waitForTransactionReceipt(args),
  getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
});

const facilitator = new x402Facilitator();

const pendingSessions = new Map<
  string,
  { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements; lastReceiptAt: number }
>();

const getSessionIdFromPayload = (payload: PaymentPayload): string | undefined => {
  const receipt = (payload.payload as { receipt?: { sessionId?: string } })?.receipt;
  return receipt?.sessionId;
};

logger.info("ODP facilitator config", {
  port: PORT,
  settlementContract,
  debitWalletContract,
  withdrawDelaySeconds,
  settlementMode,
  autoSettleIntervalSeconds,
  autoSettleAfterSeconds,
});

registerOdpDeferredEvmScheme(facilitator, {
  signer: evmSigner,
  networks: "eip155:84532",
  settlementContract,
  debitWallet: debitWalletContract,
  withdrawDelaySeconds,
  settlementMode,
  logger: schemeLogger,
  authorizedProcessors:
    authorizedProcessors.length > 0 ? (authorizedProcessors as `0x${string}`[]) : [evmAccount.address],
});

const app = express();
app.use(express.json());

app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: VerifyResponse = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );

    if (response.isValid) {
      const sessionId = getSessionIdFromPayload(paymentPayload);
      if (sessionId) {
        pendingSessions.set(sessionId, {
          paymentPayload,
          paymentRequirements,
          lastReceiptAt: Date.now(),
        });
        logger.debug("Receipt verified", { sessionId, payer: response.payer });
      }
    } else {
      logger.warn("Receipt verification failed", {
        invalidReason: response.invalidReason,
        sessionId: getSessionIdFromPayload(paymentPayload),
      });
    }

    res.json(response);
  } catch (error) {
    logger.error("Verify error", { error });
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

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response: SettleResponse = await facilitator.settle(
      paymentPayload,
      paymentRequirements,
    );

    if (response.success) {
      const sessionId = getSessionIdFromPayload(paymentPayload);
      if (sessionId) {
        pendingSessions.delete(sessionId);
      }
      logger.info("Settlement succeeded", {
        sessionId,
        transaction: response.transaction,
        mode: settlementMode,
      });
    } else {
      logger.warn("Settlement failed", {
        errorReason: response.errorReason,
        sessionId: getSessionIdFromPayload(paymentPayload),
        mode: settlementMode,
      });
    }

    res.json(response);
  } catch (error) {
    logger.error("Settle error", { error });
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/supported", (req, res) => {
  try {
    res.json(facilitator.getSupported());
  } catch (error) {
    logger.error("Supported error", { error });
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

const runAutoSettlement = async (): Promise<void> => {
  if (pendingSessions.size === 0) {
    return;
  }

  const now = Date.now();
  for (const [sessionId, entry] of pendingSessions) {
    if (now - entry.lastReceiptAt < autoSettleAfterSeconds * 1000) {
      continue;
    }

    try {
      const response = await facilitator.settle(
        entry.paymentPayload,
        entry.paymentRequirements,
      );

      if (response.success) {
        pendingSessions.delete(sessionId);
        logger.info("Auto-settled session", {
          sessionId,
          transaction: response.transaction,
          mode: settlementMode,
        });
      } else {
        logger.warn("Auto-settlement failed", {
          sessionId,
          errorReason: response.errorReason,
          mode: settlementMode,
        });
      }
    } catch (error) {
      logger.error("Auto-settle error", { sessionId, error });
    }
  }
};

if (autoSettleIntervalSeconds > 0 && autoSettleAfterSeconds >= 0) {
  setInterval(() => {
    void runAutoSettlement();
  }, autoSettleIntervalSeconds * 1000);
}

app.listen(parseInt(PORT, 10), () => {
  logger.info("ODP facilitator listening", {
    url: `http://localhost:${PORT}`,
    settlementContract,
    debitWalletContract,
    withdrawDelaySeconds,
    settlementMode,
    autoSettleIntervalSeconds,
    autoSettleAfterSeconds,
  });
});
