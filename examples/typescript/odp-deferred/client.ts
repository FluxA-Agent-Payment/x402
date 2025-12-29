import { config } from "dotenv";
import { x402Client } from "@x402/core/client";
import { registerOdpDeferredEvmScheme } from "@x402/evm/odp-deferred/client";
import { createWalletClient, http, publicActions } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const BASE_URL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const EVM_RPC_URL = process.env.EVM_RPC_URL;
const AUTO_DEPOSIT = (process.env.AUTO_DEPOSIT || "true").toLowerCase() !== "false";

if (!evmPrivateKey) {
  console.error("❌ EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}

const url = `${BASE_URL}/metered`;

const decodeHeader = (value: string) => JSON.parse(Buffer.from(value, "base64").toString("utf-8"));
const encodeHeader = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64");

const erc20Abi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

const debitWalletAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "asset", type: "address" },
    ],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const getExtraString = (extra: Record<string, unknown>, field: string): string => {
  const value = extra[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing odp-deferred extra.${field}`);
  }
  return value;
};

const getChainId = (network: string): number => {
  const [, chainIdString] = network.split(":");
  const chainId = Number(chainIdString);
  if (!Number.isFinite(chainId)) {
    throw new Error(`Invalid network for odp-deferred: ${network}`);
  }
  return chainId;
};

async function main(): Promise<void> {
  const account = privateKeyToAccount(evmPrivateKey);
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
  const requirement = Array.isArray(paymentRequired.accepts)
    ? paymentRequired.accepts[0]
    : paymentRequired.accepts;

  if (!requirement) {
    throw new Error("No payment requirements returned");
  }

  const chainId = getChainId(requirement.network);
  if (chainId !== baseSepolia.id) {
    throw new Error(`Example expects base-sepolia (84532), got ${requirement.network}`);
  }

  if (AUTO_DEPOSIT) {
    if (!EVM_RPC_URL) {
      console.warn("WARN: EVM_RPC_URL not set, skipping auto-deposit.");
    } else {
      const walletClient = createWalletClient({
        account,
        chain: baseSepolia,
        transport: http(EVM_RPC_URL),
      }).extend(publicActions);

      const extra = requirement.extra as Record<string, unknown>;
      const debitWallet = getExtraString(extra, "debitWallet") as `0x${string}`;
      const minDeposit =
        (extra.minDeposit as string | undefined) || getExtraString(extra, "maxSpend");

      const requiredDeposit = BigInt(minDeposit);
      const currentBalance = (await walletClient.readContract({
        address: debitWallet,
        abi: debitWalletAbi,
        functionName: "balanceOf",
        args: [account.address, requirement.asset],
      })) as bigint;

      if (currentBalance < requiredDeposit) {
        const topUp = requiredDeposit - currentBalance;
        const allowance = (await walletClient.readContract({
          address: requirement.asset,
          abi: erc20Abi,
          functionName: "allowance",
          args: [account.address, debitWallet],
        })) as bigint;

        if (allowance < topUp) {
          const approveHash = await walletClient.writeContract({
            address: requirement.asset,
            abi: erc20Abi,
            functionName: "approve",
            args: [debitWallet, requiredDeposit],
          });
          await walletClient.waitForTransactionReceipt({ hash: approveHash });
        }

        const depositHash = await walletClient.writeContract({
          address: debitWallet,
          abi: debitWalletAbi,
          functionName: "deposit",
          args: [requirement.asset, topUp],
        });
        await walletClient.waitForTransactionReceipt({ hash: depositHash });
      } else {
        console.log("Debit wallet already funded.");
      }
    }
  } else {
    console.log("Auto-deposit disabled; ensure the debit wallet is funded before continuing.");
  }

  let sessionId: string | undefined;

  for (let i = 0; i < 3; i += 1) {
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const paymentHeader = encodeHeader(paymentPayload);

    sessionId = (paymentPayload.payload as { receipt?: { sessionId?: string } })?.receipt?.sessionId;

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

  const settleResponse = await fetch(`${BASE_URL}/settle/${sessionId}`, {
    method: "POST",
  });
  const settleBody = await settleResponse.json();

  console.log("Settlement response:", settleBody);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
