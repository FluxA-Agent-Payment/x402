import { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { getAddress } from "viem";
import { ClientEvmSigner } from "../../signer";
import {
  OdpDeferredEvmPayloadV2,
  OdpDeferredReceipt,
  OdpDeferredSessionApproval,
} from "../../types";
import { odpReceiptTypes, odpSessionApprovalTypes } from "../constants";
import {
  hashAuthorizedProcessors,
  normalizeRequestHash,
  parseOdpDeferredExtras,
} from "../utils";

type ClientSessionState = {
  approval: OdpDeferredSessionApproval;
  signature: `0x${string}`;
  nextNonce: bigint;
};

/**
 * EVM client implementation for the ODP deferred payment scheme.
 */
export class OdpDeferredEvmScheme implements SchemeNetworkClient {
  readonly scheme = "odp-deferred";
  private sessions = new Map<string, ClientSessionState>();

  constructor(private readonly signer: ClientEvmSigner) {}

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    const extras = parseOdpDeferredExtras(paymentRequirements.extra);
    const chainId = this.getChainId(paymentRequirements.network);

    const authorizedProcessorsHash = hashAuthorizedProcessors(extras.authorizedProcessors);
    const sessionKey = extras.sessionId;

    let sessionState = this.sessions.get(sessionKey);
    let includeSessionApproval = false;

    if (!sessionState) {
      const approval: OdpDeferredSessionApproval = {
        payer: this.signer.address,
        payee: getAddress(paymentRequirements.payTo),
        asset: getAddress(paymentRequirements.asset),
        maxSpend: extras.maxSpend,
        expiry: extras.expiry,
        sessionId: extras.sessionId,
        startNonce: extras.startNonce,
        authorizedProcessorsHash,
      };

      const signature = await this.signSessionApproval(approval, chainId, extras.settlementContract);

      sessionState = {
        approval,
        signature,
        nextNonce: BigInt(extras.startNonce),
      };

      this.sessions.set(sessionKey, sessionState);
      includeSessionApproval = true;
    } else {
      this.ensureSessionMatchesRequirements(sessionState.approval, paymentRequirements, extras);
    }

    const receipt = this.buildReceipt(paymentRequirements, extras, sessionState.nextNonce);
    const receiptSignature = await this.signReceipt(receipt, chainId, extras.settlementContract);

    sessionState.nextNonce = sessionState.nextNonce + 1n;

    const payload: OdpDeferredEvmPayloadV2 = {
      receipt,
      receiptSignature,
    };

    if (includeSessionApproval) {
      payload.sessionApproval = sessionState.approval;
      payload.sessionSignature = sessionState.signature;
    }

    return {
      x402Version,
      payload,
    };
  }

  private buildReceipt(
    paymentRequirements: PaymentRequirements,
    extras: ReturnType<typeof parseOdpDeferredExtras>,
    nonce: bigint,
  ): OdpDeferredReceipt {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const expiry = BigInt(extras.expiry);
    const timeout = BigInt(paymentRequirements.maxTimeoutSeconds);
    const deadline = now + timeout > expiry ? expiry : now + timeout;

    return {
      sessionId: extras.sessionId,
      nonce: nonce.toString(),
      amount: paymentRequirements.amount,
      deadline: deadline.toString(),
      requestHash: normalizeRequestHash(extras.requestHash),
    };
  }

  private ensureSessionMatchesRequirements(
    approval: OdpDeferredSessionApproval,
    paymentRequirements: PaymentRequirements,
    extras: ReturnType<typeof parseOdpDeferredExtras>,
  ): void {
    if (
      getAddress(approval.payee) !== getAddress(paymentRequirements.payTo) ||
      getAddress(approval.asset) !== getAddress(paymentRequirements.asset)
    ) {
      throw new Error("Session approval does not match payment requirements");
    }

    const expectedHash = hashAuthorizedProcessors(extras.authorizedProcessors);
    if (approval.authorizedProcessorsHash !== expectedHash) {
      throw new Error("Session approval does not match authorized processors");
    }

    if (
      approval.sessionId !== extras.sessionId ||
      approval.startNonce !== extras.startNonce ||
      approval.maxSpend !== extras.maxSpend ||
      approval.expiry !== extras.expiry
    ) {
      throw new Error("Session approval does not match session parameters");
    }
  }

  private async signSessionApproval(
    approval: OdpDeferredSessionApproval,
    chainId: number,
    settlementContract: `0x${string}`,
  ): Promise<`0x${string}`> {
    return this.signer.signTypedData({
      domain: {
        name: "x402-odp-deferred",
        version: "1",
        chainId,
        verifyingContract: settlementContract,
      },
      types: odpSessionApprovalTypes,
      primaryType: "SessionApproval",
      message: {
        payer: getAddress(approval.payer),
        payee: getAddress(approval.payee),
        asset: getAddress(approval.asset),
        maxSpend: BigInt(approval.maxSpend),
        expiry: BigInt(approval.expiry),
        sessionId: approval.sessionId,
        startNonce: BigInt(approval.startNonce),
        authorizedProcessorsHash: approval.authorizedProcessorsHash,
      },
    });
  }

  private async signReceipt(
    receipt: OdpDeferredReceipt,
    chainId: number,
    settlementContract: `0x${string}`,
  ): Promise<`0x${string}`> {
    return this.signer.signTypedData({
      domain: {
        name: "x402-odp-deferred",
        version: "1",
        chainId,
        verifyingContract: settlementContract,
      },
      types: odpReceiptTypes,
      primaryType: "Receipt",
      message: {
        sessionId: receipt.sessionId,
        nonce: BigInt(receipt.nonce),
        amount: BigInt(receipt.amount),
        deadline: BigInt(receipt.deadline),
        requestHash: receipt.requestHash,
      },
    });
  }

  private getChainId(network: string): number {
    const [, chainIdString] = network.split(":");
    const chainId = Number(chainIdString);
    if (!Number.isFinite(chainId)) {
      throw new Error(`Invalid network for odp-deferred: ${network}`);
    }
    return chainId;
  }
}
