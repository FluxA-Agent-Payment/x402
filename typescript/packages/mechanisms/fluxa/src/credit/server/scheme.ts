import type { SchemeNetworkServer } from "@x402/core/types";
import type { AssetAmount, Network, Price } from "@x402/core/types";
import type { PaymentRequirements } from "@x402/core/types";

function toStringAmount(v: number | string): string {
  if (typeof v === "number") return Math.trunc(v).toString();
  return String(v);
}

export class FluxaCreditServerScheme implements SchemeNetworkServer {
  readonly scheme = "fluxacredit" as const;

  async parsePrice(price: Price, _network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "asset" in price && "amount" in price) {
      const asset = (price as AssetAmount).asset;
      if (asset !== "FLUXA_CREDIT") {
        throw new Error("fluxacredit expects asset=FLUXA_CREDIT");
      }
      return { amount: toStringAmount((price as AssetAmount).amount), asset };
    }

    return { amount: toStringAmount(price as number | string), asset: "FLUXA_CREDIT" };
  }

  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentRequirements> {
    const extra = { ...(paymentRequirements.extra || {}) } as Record<string, unknown>;
    if (!extra.id) {
      extra.id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    return { ...paymentRequirements, extra };
  }
}

