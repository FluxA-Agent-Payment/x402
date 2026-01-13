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

const settlementContract =
  process.env.SETTLEMENT_CONTRACT || "0x0000000000000000000000000000000000000001";

const debitWalletContract =
  process.env.DEBIT_WALLET_CONTRACT || "0x0000000000000000000000000000000000000002";

const withdrawDelaySeconds = process.env.WITHDRAW_DELAY_SECONDS || "86400";

const authorizedProcessors = process.env.AUTHORIZED_PROCESSORS
  ? process.env.AUTHORIZED_PROCESSORS.split(",").map(value => value.trim())
  : [];

const autoSettleIntervalSeconds = Number(process.env.AUTO_SETTLE_INTERVAL_SECONDS || "15");
const autoSettleMaxReceiptsValue = process.env.AUTO_SETTLE_MAX_RECEIPTS;
const autoSettleMaxReceipts = autoSettleMaxReceiptsValue
  ? Number(autoSettleMaxReceiptsValue)
  : undefined;
const maxReceiptsPerSettlement =
  autoSettleMaxReceipts && Number.isFinite(autoSettleMaxReceipts) && autoSettleMaxReceipts > 0
    ? Math.floor(autoSettleMaxReceipts)
    : undefined;

const settlementMode =
  process.env.SETTLEMENT_MODE && process.env.SETTLEMENT_MODE.toLowerCase() === "onchain"
    ? "onchain"
    : "synthetic";

if (!process.env.DEBIT_WALLET_CONTRACT) {
  console.warn("DEBIT_WALLET_CONTRACT not set, using placeholder address.");
}

const facilitatorAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY);

const viemClient = createWalletClient({
  account: facilitatorAccount,
  chain: baseSepolia,
  transport: http(),
}).extend(publicActions);

const facilitatorSigner = toFacilitatorEvmSigner({
  address: facilitatorAccount.address,
  readContract: args =>
    viemClient.readContract({
      ...args,
      args: args.args || [],
    }),
  verifyTypedData: args => viemClient.verifyTypedData(args),
  writeContract: args =>
    viemClient.writeContract({
      ...args,
      args: args.args || [],
    }),
  sendTransaction: args => viemClient.sendTransaction(args),
  waitForTransactionReceipt: args => viemClient.waitForTransactionReceipt(args),
  getCode: args => viemClient.getCode(args),
});

const facilitator = new x402Facilitator();

const pendingSessions = new Map();

const getSessionIdFromPayload = payload => {
  const receipt = payload?.payload?.receipt;
  return receipt?.sessionId;
};

console.log("ODP facilitator config", {
  port: PORT,
  settlementContract,
  debitWalletContract,
  withdrawDelaySeconds,
  settlementMode,
  autoSettleIntervalSeconds,
  autoSettleMaxReceipts: maxReceiptsPerSettlement ?? "all",
});

registerOdpDeferredEvmScheme(facilitator, {
  signer: facilitatorSigner,
  networks: "eip155:84532",
  settlementContract,
  debitWallet: debitWalletContract,
  withdrawDelaySeconds,
  settlementMode,
  maxReceiptsPerSettlement,
  authorizedProcessors:
    authorizedProcessors.length > 0 ? authorizedProcessors : [facilitatorAccount.address],
});

const app = express();
app.use(express.json());

app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body || {};

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({
        error: "Missing paymentPayload or paymentRequirements",
      });
    }

    const response = await facilitator.verify(paymentPayload, paymentRequirements);

    if (response.isValid) {
      const sessionId = getSessionIdFromPayload(paymentPayload);
      if (sessionId) {
        const existing = pendingSessions.get(sessionId);
        pendingSessions.set(sessionId, {
          paymentPayload,
          paymentRequirements,
          receiptCount: existing ? existing.receiptCount + 1 : 1,
          settling: existing?.settling ?? false,
        });
        console.log("Receipt verified", {
          sessionId,
          payer: response.payer,
          receiptCount: existing ? existing.receiptCount + 1 : 1,
        });
      }
    } else {
      console.warn("Receipt verification failed", {
        invalidReason: response.invalidReason,
        sessionId: getSessionIdFromPayload(paymentPayload),
      });
    }

    return res.json(response);
  } catch (error) {
    console.error("Verify error", { error });
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/supported", (req, res) => {
  try {
    res.json(facilitator.getSupported());
  } catch (error) {
    console.error("Supported error", { error });
    res.status(500).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

const runAutoSettlement = async () => {
  if (pendingSessions.size === 0) {
    return;
  }

  const updateSettling = (sessionId, settling) => {
    const current = pendingSessions.get(sessionId);
    if (!current) {
      return;
    }
    pendingSessions.set(sessionId, { ...current, settling });
  };

  for (const [sessionId, entry] of pendingSessions) {
    if (entry.settling) {
      continue;
    }

    if (entry.receiptCount <= 0) {
      pendingSessions.delete(sessionId);
      continue;
    }

    const settleCount = maxReceiptsPerSettlement
      ? Math.min(entry.receiptCount, maxReceiptsPerSettlement)
      : entry.receiptCount;

    if (settleCount <= 0) {
      continue;
    }

    updateSettling(sessionId, true);

    try {
      const response = await facilitator.settle(entry.paymentPayload, entry.paymentRequirements);

      if (response.success) {
        const current = pendingSessions.get(sessionId);
        const remainingReceipts = Math.max(
          0,
          (current?.receiptCount ?? entry.receiptCount) - settleCount,
        );

        if (remainingReceipts === 0) {
          pendingSessions.delete(sessionId);
        } else if (current) {
          pendingSessions.set(sessionId, {
            ...current,
            receiptCount: remainingReceipts,
            settling: false,
          });
        }

        console.log("Auto-settled session", {
          sessionId,
          transaction: response.transaction,
          mode: settlementMode,
          settledReceipts: settleCount,
          remainingReceipts,
        });
      } else {
        console.warn("Auto-settlement failed", {
          sessionId,
          errorReason: response.errorReason,
          mode: settlementMode,
        });
      }
    } catch (error) {
      console.error("Auto-settle error", { sessionId, error });
    } finally {
      updateSettling(sessionId, false);
    }
  }
};

if (autoSettleIntervalSeconds > 0) {
  setInterval(() => {
    void runAutoSettlement();
  }, autoSettleIntervalSeconds * 1000);
}

app.listen(parseInt(PORT, 10), () => {
  console.log("ODP facilitator listening", {
    url: `http://localhost:${PORT}`,
    settlementContract,
    debitWalletContract,
    withdrawDelaySeconds,
    settlementMode,
    autoSettleIntervalSeconds,
    autoSettleMaxReceipts: maxReceiptsPerSettlement ?? "all",
  });
});
