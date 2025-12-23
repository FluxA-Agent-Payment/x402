import type { SchemeNetworkFacilitator } from "@x402/core/types";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { SettleResponse, VerifyResponse } from "@x402/core/types";
import { verifyWebBotAuth } from "../utils/webBotAuthVerifier";

type WebBotAuthExt = {
  signatureAgent?: string;
  signatureInput?: string;
  signature?: string;
};

function deepEqual(a: unknown, b: unknown): boolean {
  try {
    const normalize = (obj: unknown): unknown => {
      if (obj === null || typeof obj !== "object") return obj;
      if (Array.isArray(obj)) return obj.map(normalize);
      const out: Record<string, unknown> = {};
      Object.keys(obj as Record<string, unknown>)
        .sort()
        .forEach(k => (out[k] = normalize((obj as Record<string, unknown>)[k])));
      return out;
    };
    return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
  } catch {
    return JSON.stringify(a) === JSON.stringify(b);
  }
}

function getWebBotAuth(payload: PaymentPayload): WebBotAuthExt | undefined {
  const ext = (payload as any).extensions;
  if (!ext) return undefined;
  return ext["web-bot-auth"] as WebBotAuthExt | undefined;
}

export class FluxaCreditFacilitatorScheme implements SchemeNetworkFacilitator {
  readonly scheme = "fluxacredit" as const;
  readonly caipFamily = "fluxa:*" as const;

  getExtra(): Record<string, unknown> | undefined {
    return undefined;
  }

  getSigners(): string[] {
    return [];
  }

  async verify(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    // 1) Requirements binding
    if (!deepEqual(paymentPayload.accepted, requirements)) {
      return { isValid: false, invalidReason: "requirements_mismatch" };
    }

    // 2) Web Bot Auth extraction
    const wba = getWebBotAuth(paymentPayload);
    if (!wba?.signatureAgent || !wba?.signatureInput || !wba?.signature) {
      return { isValid: false, invalidReason: "invalid_web_bot_auth" };
    }

    // Extract the raw PAYMENT-SIGNATURE header if provided via extensions, else reconstruct
    const paymentSignatureHeader: string =
      (paymentPayload as any).extensions?.["web-bot-auth"]?.paymentSignatureHeader ||
      // fall back to re-encoding, but this may not match exactly — strong recommendation to pass raw header
      Buffer.from(JSON.stringify(paymentPayload)).toString("base64url");

    // Perform real HTTP Message Signatures verification for required components
    const v = await verifyWebBotAuth({
      signatureAgent: String(wba.signatureAgent),
      signatureInput: String(wba.signatureInput),
      signature: String(wba.signature),
      method: "GET", // best effort; callers may extend to pass true method if needed
      url: String(paymentPayload.resource?.url || ""),
      paymentSignatureHeader,
    });
    if (!v.ok) return { isValid: false, invalidReason: v.error };

    return { isValid: true, payer: v.thumbprint || (paymentPayload.payload as any)["signature-fluxa-ai-agent-id"] || "" };
  }

  async settle(paymentPayload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    // Mock debit: always succeed and emit a pseudo tx id; network is logical fluxa:monetize
    const tx = `credit-ledger:${String(requirements.extra?.id ?? "")}`;
    return { success: true, transaction: tx, network: requirements.network } as SettleResponse;
  }
}
