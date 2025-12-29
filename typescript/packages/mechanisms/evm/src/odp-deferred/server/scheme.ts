import {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";
import { getAddress } from "viem";
import { createNonce } from "../../utils";
import { ZERO_BYTES32 } from "../constants";

export interface OdpDeferredEvmSchemeConfig {
  maxReceiptsPerSession?: number;
  maxSpend?: string;
  expirySeconds?: number;
  startNonce?: string;
  maxAmountPerReceipt?: string;
  requestHash?: `0x${string}`;
  minDeposit?: string;
  sessionIdFactory?: () => `0x${string}`;
}

/**
 * EVM server implementation for the ODP deferred payment scheme.
 */
export class OdpDeferredEvmScheme implements SchemeNetworkServer {
  readonly scheme = "odp-deferred";
  private moneyParsers: MoneyParser[] = [];
  private config: Required<OdpDeferredEvmSchemeConfig>;

  constructor(config: OdpDeferredEvmSchemeConfig = {}) {
    this.config = {
      maxReceiptsPerSession: config.maxReceiptsPerSession ?? 100,
      maxSpend: config.maxSpend ?? "",
      expirySeconds: config.expirySeconds ?? 3600,
      startNonce: config.startNonce ?? "0",
      maxAmountPerReceipt: config.maxAmountPerReceipt ?? "",
      requestHash: config.requestHash ?? ZERO_BYTES32,
      minDeposit: config.minDeposit ?? "",
      sessionIdFactory: config.sessionIdFactory ?? createNonce,
    };
  }

  registerMoneyParser(parser: MoneyParser): OdpDeferredEvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra || {},
      };
    }

    const amount = this.parseMoneyToDecimal(price);

    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    return this.defaultMoneyConversion(amount, network);
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    void extensionKeys;

    const settlementContract = this.requireSupportedExtra(supportedKind.extra, "settlementContract");
    const debitWallet = this.requireSupportedExtra(supportedKind.extra, "debitWallet");
    const withdrawDelaySeconds = this.requireSupportedStringExtra(
      supportedKind.extra,
      "withdrawDelaySeconds",
    );
    const authorizedProcessors = this.optionalSupportedExtraArray(
      supportedKind.extra,
      "authorizedProcessors",
    );

    const sessionId = this.config.sessionIdFactory();
    const maxSpend =
      this.config.maxSpend && this.config.maxSpend.length > 0
        ? this.config.maxSpend
        : (BigInt(paymentRequirements.amount) * BigInt(this.config.maxReceiptsPerSession)).toString();

    const expiry = (Math.floor(Date.now() / 1000) + this.config.expirySeconds).toString();

    const extra: Record<string, unknown> = {
      ...paymentRequirements.extra,
      sessionId,
      startNonce: this.config.startNonce,
      maxSpend,
      expiry,
      settlementContract,
      debitWallet,
      withdrawDelaySeconds,
    };

    if (authorizedProcessors && authorizedProcessors.length > 0) {
      extra.authorizedProcessors = authorizedProcessors;
    }

    if (this.config.requestHash && this.config.requestHash !== ZERO_BYTES32) {
      extra.requestHash = this.config.requestHash;
    }

    if (this.config.maxAmountPerReceipt && this.config.maxAmountPerReceipt.length > 0) {
      extra.maxAmountPerReceipt = this.config.maxAmountPerReceipt;
    }

    if (this.config.minDeposit && this.config.minDeposit.length > 0) {
      extra.minDeposit = this.config.minDeposit;
    }

    return {
      ...paymentRequirements,
      extra,
    };
  }

  private parseMoneyToDecimal(money: string | number): number {
    if (typeof money === "number") {
      return money;
    }

    const cleanMoney = money.replace(/^\$/, "").trim();
    const amount = parseFloat(cleanMoney);

    if (isNaN(amount)) {
      throw new Error(`Invalid money format: ${money}`);
    }

    return amount;
  }

  private defaultMoneyConversion(amount: number, network: Network): AssetAmount {
    const tokenAmount = this.convertToTokenAmount(amount.toString(), network);
    const assetInfo = this.getDefaultAsset(network);

    return {
      amount: tokenAmount,
      asset: assetInfo.address,
      extra: {},
    };
  }

  private convertToTokenAmount(decimalAmount: string, network: Network): string {
    const decimals = this.getAssetDecimals(network);
    const amount = parseFloat(decimalAmount);
    if (isNaN(amount)) {
      throw new Error(`Invalid amount: ${decimalAmount}`);
    }

    const [intPart, decPart = ""] = String(amount).split(".");
    const paddedDec = decPart.padEnd(decimals, "0").slice(0, decimals);
    const tokenAmount = (intPart + paddedDec).replace(/^0+/, "") || "0";
    return tokenAmount;
  }

  private getDefaultAsset(network: Network): { address: string } {
    const usdcInfo: Record<string, { address: string }> = {
      "eip155:8453": {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      },
      "eip155:84532": {
        address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      },
      "eip155:1": {
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      },
      "eip155:11155111": {
        address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      },
    };

    const assetInfo = usdcInfo[network];
    if (!assetInfo) {
      throw new Error(`No default asset configured for network ${network}`);
    }

    return assetInfo;
  }

  private getAssetDecimals(_: Network): number {
    return 6;
  }

  private requireSupportedExtra(extra: Record<string, unknown> | undefined, field: string): string {
    if (!extra || typeof extra[field] !== "string") {
      throw new Error(`Missing required facilitator extra field: ${field}`);
    }
    return getAddress(extra[field] as string);
  }

  private requireSupportedStringExtra(
    extra: Record<string, unknown> | undefined,
    field: string,
  ): string {
    if (!extra || typeof extra[field] !== "string") {
      throw new Error(`Missing required facilitator extra field: ${field}`);
    }
    return extra[field] as string;
  }

  private optionalSupportedExtraArray(
    extra: Record<string, unknown> | undefined,
    field: string,
  ): `0x${string}`[] | undefined {
    if (!extra || extra[field] === undefined || extra[field] === null) {
      return undefined;
    }

    if (!Array.isArray(extra[field])) {
      throw new Error(`Invalid facilitator extra field: ${field}`);
    }

    return (extra[field] as string[]).map(value => getAddress(value));
  }
}
