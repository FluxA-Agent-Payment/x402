import type { FacilitatorEvmSigner } from "@x402/evm";
import { encodePacked, keccak256, verifyTypedData } from "viem";

type MockSignerConfig = {
  address: `0x${string}`;
  debitWalletBalance: bigint;
  withdrawDelaySeconds: bigint;
  onWrite?: (hash: `0x${string}`) => void;
};

export const createMockSigner = (config: MockSignerConfig): FacilitatorEvmSigner => {
  let counter = 0n;

  const nextHash = (): `0x${string}` => {
    counter += 1n;
    return keccak256(encodePacked(["uint256"], [counter]));
  };

  return {
    getAddresses: () => [config.address],
    readContract: async (args: {
      address: `0x${string}`;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }): Promise<unknown> => {
      if (args.functionName === "balanceOf") {
        return config.debitWalletBalance;
      }
      if (args.functionName === "withdrawDelaySeconds") {
        return config.withdrawDelaySeconds;
      }
      return 0n;
    },
    verifyTypedData: async (args: {
      address: `0x${string}`;
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
      signature: `0x${string}`;
    }): Promise<boolean> =>
      verifyTypedData({
        address: args.address,
        domain: args.domain,
        types: args.types,
        primaryType: args.primaryType,
        message: args.message,
        signature: args.signature,
      }),
    writeContract: async (): Promise<`0x${string}`> => {
      const hash = nextHash();
      config.onWrite?.(hash);
      return hash;
    },
    sendTransaction: async (): Promise<`0x${string}`> => {
      const hash = nextHash();
      config.onWrite?.(hash);
      return hash;
    },
    waitForTransactionReceipt: async (): Promise<{ status: string }> => ({
      status: "success",
    }),
    getCode: async (): Promise<`0x${string}` | undefined> => "0x1",
  };
};
