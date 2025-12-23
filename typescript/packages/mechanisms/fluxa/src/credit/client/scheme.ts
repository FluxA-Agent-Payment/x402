import type { SchemeNetworkClient } from "@x402/core/types";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

/**
 * FluxA credits (exact price) client scheme.
 * Does not generate HTTP signatures; only constructs the x402 v2 payload.
 */
export class FluxaCreditClientScheme implements SchemeNetworkClient {
  readonly scheme = "fluxacredit" as const;

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    // Minimal payload per spec; HTTP Message Signatures live in HTTP headers,
    // not inside the JSON payload. The server (Plan B) can inject headers
    // into extensions before calling the facilitator.
    const challengeId = String(paymentRequirements.extra?.id ?? "");

    return {
      x402Version,
      payload: {
        signature: "http-message-signatures",
        "signature-fluxa-ai-agent-id": "",
        challengeId,
      },
    };
  }
}

