import {
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { encodePacked, getAddress, isAddressEqual, keccak256 } from "viem";
import { FacilitatorEvmSigner } from "../../signer";
import {
  OdpDeferredEvmPayloadV2,
  OdpDeferredReceipt,
  OdpDeferredSessionApproval,
} from "../../types";
import { odpReceiptTypes, odpSessionApprovalTypes } from "../constants";
import { InMemoryOdpDeferredStore, OdpDeferredStore } from "../store";
import {
  hashAuthorizedProcessors,
  normalizeRequestHash,
  parseOdpDeferredExtras,
} from "../utils";

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
    name: "withdrawDelaySeconds",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "delay", type: "uint256" }],
  },
] as const;

const settlementWalletAbi = [
  {
    type: "function",
    name: "settleSession",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "approval",
        type: "tuple",
        components: [
          { name: "payer", type: "address" },
          { name: "payee", type: "address" },
          { name: "asset", type: "address" },
          { name: "maxSpend", type: "uint256" },
          { name: "expiry", type: "uint256" },
          { name: "sessionId", type: "bytes32" },
          { name: "startNonce", type: "uint256" },
          { name: "authorizedProcessorsHash", type: "bytes32" },
        ],
      },
      { name: "sessionSignature", type: "bytes" },
      { name: "startNonce", type: "uint256" },
      { name: "endNonce", type: "uint256" },
      { name: "totalAmount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

type OdpDeferredLogger = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

const noopLogger: OdpDeferredLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface OdpDeferredEvmSchemeConfig {
  settlementContract: `0x${string}`;
  debitWallet: `0x${string}`;
  withdrawDelaySeconds: string;
  settlementMode?: "synthetic" | "onchain";
  authorizedProcessors?: `0x${string}`[];
  maxReceiptsPerSettlement?: number;
  store?: OdpDeferredStore;
  logger?: OdpDeferredLogger;
}

export class OdpDeferredEvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "odp-deferred";
  readonly caipFamily = "eip155:*";
  private readonly config: OdpDeferredEvmSchemeConfig;
  private readonly store: OdpDeferredStore;
  private readonly logger: OdpDeferredLogger;

  constructor(private readonly signer: FacilitatorEvmSigner, config: OdpDeferredEvmSchemeConfig) {
    this.config = {
      settlementContract: getAddress(config.settlementContract),
      debitWallet: getAddress(config.debitWallet),
      withdrawDelaySeconds: config.withdrawDelaySeconds,
      settlementMode: config.settlementMode ?? "synthetic",
      authorizedProcessors: config.authorizedProcessors?.map(address => getAddress(address)),
      maxReceiptsPerSettlement: config.maxReceiptsPerSettlement,
      store: config.store,
    };
    this.store = config.store ?? new InMemoryOdpDeferredStore();
    this.logger = config.logger ?? noopLogger;
  }

  getExtra(_: string): Record<string, unknown> | undefined {
    return {
      settlementContract: this.config.settlementContract,
      debitWallet: this.config.debitWallet,
      withdrawDelaySeconds: this.config.withdrawDelaySeconds,
      authorizedProcessors: this.config.authorizedProcessors,
    };
  }

  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const odpPayload = payload.payload as OdpDeferredEvmPayloadV2;

    if (payload.accepted.scheme !== this.scheme || requirements.scheme !== this.scheme) {
      return {
        isValid: false,
        invalidReason: "unsupported_scheme",
      };
    }

    if (payload.accepted.network !== requirements.network) {
      return {
        isValid: false,
        invalidReason: "network_mismatch",
      };
    }

    let extras;
    try {
      extras = parseOdpDeferredExtras(requirements.extra);
    } catch (error) {
      return {
        isValid: false,
        invalidReason: error instanceof Error ? error.message : "invalid_requirements_extra",
      };
    }

    if (!odpPayload?.receipt) {
      return {
        isValid: false,
        invalidReason: "invalid_odp_payload_missing_receipt",
      };
    }

    if (!odpPayload.receiptSignature) {
      return {
        isValid: false,
        invalidReason: "missing_receipt_signature",
      };
    }

    if (odpPayload.receipt.sessionId !== extras.sessionId) {
      return {
        isValid: false,
        invalidReason: "session_id_mismatch",
      };
    }

    if (getAddress(extras.settlementContract) !== this.config.settlementContract) {
      return {
        isValid: false,
        invalidReason: "settlement_contract_mismatch",
      };
    }

    if (getAddress(extras.debitWallet) !== this.config.debitWallet) {
      return {
        isValid: false,
        invalidReason: "debit_wallet_mismatch",
      };
    }

    if (extras.withdrawDelaySeconds !== this.config.withdrawDelaySeconds) {
      return {
        isValid: false,
        invalidReason: "withdraw_delay_mismatch",
      };
    }

    const receipt = odpPayload.receipt as OdpDeferredReceipt;
    const sessionId = receipt.sessionId;
    const chainId = this.getChainId(requirements.network);

    let sessionRecord = this.store.getSession(sessionId);
    let approval: OdpDeferredSessionApproval | undefined = sessionRecord?.approval;

    if (odpPayload.sessionApproval) {
      if (!odpPayload.sessionSignature) {
        return {
          isValid: false,
          invalidReason: "missing_session_signature",
        };
      }

      const sessionApproval = odpPayload.sessionApproval as OdpDeferredSessionApproval;
      const sessionSignature = odpPayload.sessionSignature;
      const expectedHash = hashAuthorizedProcessors(extras.authorizedProcessors);

      if (sessionApproval.authorizedProcessorsHash !== expectedHash) {
        return {
          isValid: false,
          invalidReason: "authorized_processors_hash_mismatch",
        };
      }

      const approvalValid = await this.verifySessionApproval(
        sessionApproval,
        odpPayload.sessionSignature,
        chainId,
        extras.settlementContract,
      );

      if (!approvalValid) {
        return {
          isValid: false,
          invalidReason: "invalid_session_signature",
        };
      }

      if (
        getAddress(sessionApproval.payee) !== getAddress(requirements.payTo) ||
        getAddress(sessionApproval.asset) !== getAddress(requirements.asset) ||
        sessionApproval.sessionId !== extras.sessionId ||
        sessionApproval.startNonce !== extras.startNonce ||
        sessionApproval.maxSpend !== extras.maxSpend ||
        sessionApproval.expiry !== extras.expiry
      ) {
        return {
          isValid: false,
          invalidReason: "session_approval_mismatch",
        };
      }

      approval = sessionApproval;

      if (!sessionRecord) {
        sessionRecord = {
          approval: sessionApproval,
          sessionSignature,
          settlementContract: extras.settlementContract,
          nextNonce: BigInt(sessionApproval.startNonce),
          spent: 0n,
          receipts: [],
          settling: false,
        };
      } else if (
        sessionRecord.approval.sessionId !== sessionApproval.sessionId ||
        sessionRecord.approval.startNonce !== sessionApproval.startNonce ||
        sessionRecord.approval.maxSpend !== sessionApproval.maxSpend ||
        sessionRecord.approval.expiry !== sessionApproval.expiry ||
        !isAddressEqual(sessionRecord.approval.payee, sessionApproval.payee) ||
        !isAddressEqual(sessionRecord.approval.asset, sessionApproval.asset) ||
        sessionRecord.approval.authorizedProcessorsHash !== sessionApproval.authorizedProcessorsHash
      ) {
        return {
          isValid: false,
          invalidReason: "session_approval_mismatch",
        };
      }

      if (sessionSignature) {
        sessionRecord.sessionSignature = sessionSignature;
      }
    }

    if (!approval || !sessionRecord) {
      return {
        isValid: false,
        invalidReason: "missing_session_approval",
      };
    }

    if (sessionRecord.settlementContract !== extras.settlementContract) {
      return {
        isValid: false,
        invalidReason: "settlement_contract_mismatch",
        payer: approval.payer,
      };
    }

    if (
      approval.sessionId !== extras.sessionId ||
      approval.startNonce !== extras.startNonce ||
      approval.maxSpend !== extras.maxSpend ||
      approval.expiry !== extras.expiry ||
      !isAddressEqual(approval.payee, getAddress(requirements.payTo)) ||
      !isAddressEqual(approval.asset, getAddress(requirements.asset))
    ) {
      return {
        isValid: false,
        invalidReason: "requirements_session_mismatch",
      };
    }

    if (!this.isAuthorizedProcessor(extras.authorizedProcessors)) {
      return {
        isValid: false,
        invalidReason: "unauthorized_processor",
      };
    }

    const debitWalletState = await this.getDebitWalletState(
      extras.debitWallet,
      approval.payer,
      approval.asset,
    );

    if (debitWalletState.withdrawDelaySeconds !== BigInt(extras.withdrawDelaySeconds)) {
      return {
        isValid: false,
        invalidReason: "debit_wallet_withdraw_delay_mismatch",
        payer: approval.payer,
      };
    }

    if (receipt.sessionId !== approval.sessionId) {
      return {
        isValid: false,
        invalidReason: "session_id_mismatch",
        payer: approval.payer,
      };
    }

    const receiptSignatureValid = await this.verifyReceipt(
      receipt,
      odpPayload.receiptSignature,
      approval.payer,
      chainId,
      extras.settlementContract,
    );

    if (!receiptSignatureValid) {
      return {
        isValid: false,
        invalidReason: "invalid_receipt_signature",
        payer: approval.payer,
      };
    }

    if (receipt.nonce !== sessionRecord.nextNonce.toString()) {
      return {
        isValid: false,
        invalidReason: "receipt_nonce_mismatch",
        payer: approval.payer,
      };
    }

    if (receipt.amount !== requirements.amount) {
      return {
        isValid: false,
        invalidReason: "receipt_amount_mismatch",
        payer: approval.payer,
      };
    }

    if (extras.maxAmountPerReceipt) {
      if (BigInt(receipt.amount) > BigInt(extras.maxAmountPerReceipt)) {
        return {
          isValid: false,
          invalidReason: "receipt_amount_exceeds_max",
          payer: approval.payer,
        };
      }
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const deadline = BigInt(receipt.deadline);
    const expiry = BigInt(approval.expiry);
    const timeoutLimit = now + BigInt(requirements.maxTimeoutSeconds);

    if (deadline < now || deadline > timeoutLimit || deadline > expiry) {
      return {
        isValid: false,
        invalidReason: "receipt_deadline_invalid",
        payer: approval.payer,
      };
    }

    if (expiry < now) {
      return {
        isValid: false,
        invalidReason: "session_expired",
        payer: approval.payer,
      };
    }

    const requiredRequestHash = normalizeRequestHash(extras.requestHash);
    if (receipt.requestHash !== requiredRequestHash) {
      return {
        isValid: false,
        invalidReason: "request_hash_mismatch",
        payer: approval.payer,
      };
    }

    const nextSpend = sessionRecord.spent + BigInt(receipt.amount);
    if (nextSpend > BigInt(approval.maxSpend)) {
      return {
        isValid: false,
        invalidReason: "session_max_spend_exceeded",
        payer: approval.payer,
      };
    }

    if (nextSpend > debitWalletState.balance) {
      return {
        isValid: false,
        invalidReason: "insufficient_debit_wallet_balance",
        payer: approval.payer,
      };
    }

    sessionRecord.spent = nextSpend;
    sessionRecord.nextNonce = sessionRecord.nextNonce + 1n;
    sessionRecord.receipts.push(receipt);

    this.store.setSession(sessionId, sessionRecord);

    return {
      isValid: true,
      payer: approval.payer,
    };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const odpPayload = payload.payload as OdpDeferredEvmPayloadV2;

    if (!odpPayload?.receipt) {
      return {
        success: false,
        errorReason: "invalid_odp_payload_missing_receipt",
        transaction: "",
        network: payload.accepted.network,
      };
    }

    const receipt = odpPayload.receipt as OdpDeferredReceipt;

    let extras;
    try {
      extras = parseOdpDeferredExtras(requirements.extra);
    } catch (error) {
      return {
        success: false,
        errorReason: error instanceof Error ? error.message : "invalid_requirements_extra",
        transaction: "",
        network: payload.accepted.network,
      };
    }

    if (!this.isAuthorizedProcessor(extras.authorizedProcessors)) {
      return {
        success: false,
        errorReason: "unauthorized_processor",
        transaction: "",
        network: payload.accepted.network,
      };
    }

    if (getAddress(extras.debitWallet) !== this.config.debitWallet) {
      return {
        success: false,
        errorReason: "debit_wallet_mismatch",
        transaction: "",
        network: payload.accepted.network,
      };
    }

    if (extras.withdrawDelaySeconds !== this.config.withdrawDelaySeconds) {
      return {
        success: false,
        errorReason: "withdraw_delay_mismatch",
        transaction: "",
        network: payload.accepted.network,
      };
    }

    const sessionRecord = this.store.getSession(receipt.sessionId);
    if (!sessionRecord) {
      return {
        success: false,
        errorReason: "session_not_found",
        transaction: "",
        network: payload.accepted.network,
      };
    }

    if (sessionRecord.settling) {
      return {
        success: false,
        errorReason: "settlement_in_progress",
        transaction: "",
        network: payload.accepted.network,
        payer: sessionRecord.approval.payer,
      };
    }

    sessionRecord.settling = true;
    this.store.setSession(receipt.sessionId, sessionRecord);

    try {
      const receiptsSnapshot = [...sessionRecord.receipts];
      const maxReceiptsPerSettlement =
        this.config.maxReceiptsPerSettlement && this.config.maxReceiptsPerSettlement > 0
          ? this.config.maxReceiptsPerSettlement
          : undefined;
      const batchReceipts = maxReceiptsPerSettlement
        ? receiptsSnapshot.slice(0, maxReceiptsPerSettlement)
        : receiptsSnapshot;

      if (batchReceipts.length === 0) {
        return {
          success: false,
          errorReason: "no_receipts",
          transaction: "",
          network: payload.accepted.network,
          payer: sessionRecord.approval.payer,
        };
      }

      const debitWalletState = await this.getDebitWalletState(
        extras.debitWallet,
        sessionRecord.approval.payer,
        sessionRecord.approval.asset,
      );

      if (debitWalletState.withdrawDelaySeconds !== BigInt(extras.withdrawDelaySeconds)) {
        return {
          success: false,
          errorReason: "debit_wallet_withdraw_delay_mismatch",
          transaction: "",
          network: payload.accepted.network,
          payer: sessionRecord.approval.payer,
        };
      }

      const total = batchReceipts.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);

      if (total > debitWalletState.balance) {
        return {
          success: false,
          errorReason: "insufficient_debit_wallet_balance",
          transaction: "",
          network: payload.accepted.network,
          payer: sessionRecord.approval.payer,
        };
      }

      const startNonce = BigInt(batchReceipts[0].nonce);
      const endNonce = BigInt(batchReceipts[batchReceipts.length - 1].nonce);

      for (let i = 0; i < batchReceipts.length; i += 1) {
        const expected = startNonce + BigInt(i);
        if (BigInt(batchReceipts[i].nonce) !== expected) {
          return {
            success: false,
            errorReason: "receipt_nonce_gap",
            transaction: "",
            network: payload.accepted.network,
            payer: sessionRecord.approval.payer,
          };
        }
      }

      if (this.config.settlementMode === "onchain") {
        if (!sessionRecord.sessionSignature) {
          return {
            success: false,
            errorReason: "missing_session_signature",
            transaction: "",
            network: payload.accepted.network,
            payer: sessionRecord.approval.payer,
          };
        }

        const approvalArgs = {
          payer: sessionRecord.approval.payer,
          payee: sessionRecord.approval.payee,
          asset: sessionRecord.approval.asset,
          maxSpend: BigInt(sessionRecord.approval.maxSpend),
          expiry: BigInt(sessionRecord.approval.expiry),
          sessionId: sessionRecord.approval.sessionId,
          startNonce: BigInt(sessionRecord.approval.startNonce),
          authorizedProcessorsHash: sessionRecord.approval.authorizedProcessorsHash,
        };

        try {
          this.logger.info("Submitting on-chain settlement", {
            sessionId: sessionRecord.approval.sessionId,
            payer: sessionRecord.approval.payer,
            startNonce: startNonce.toString(),
            endNonce: endNonce.toString(),
            total: total.toString(),
          });

          const txHash = await this.signer.writeContract({
            address: this.config.settlementContract,
            abi: settlementWalletAbi,
            functionName: "settleSession",
            args: [approvalArgs, sessionRecord.sessionSignature, startNonce, endNonce, total],
          });

          this.logger.info("On-chain settlement submitted", {
            sessionId: sessionRecord.approval.sessionId,
            txHash,
          });

          const receiptResult = await this.signer.waitForTransactionReceipt({ hash: txHash });
          this.logger.info("On-chain settlement receipt", {
            sessionId: sessionRecord.approval.sessionId,
            txHash,
            status: receiptResult.status,
          });

          if (receiptResult.status !== "success") {
            return {
              success: false,
              errorReason: "settlement_transaction_failed",
              transaction: txHash,
              network: payload.accepted.network,
              payer: sessionRecord.approval.payer,
            };
          }

          sessionRecord.receipts = sessionRecord.receipts.filter(entry => {
            const nonce = BigInt(entry.nonce);
            return nonce < startNonce || nonce > endNonce;
          });

          return {
            success: true,
            transaction: txHash,
            network: payload.accepted.network,
            payer: sessionRecord.approval.payer,
          };
        } catch (error) {
          this.logger.error("On-chain settlement error", {
            sessionId: sessionRecord.approval.sessionId,
            error,
          });
          return {
            success: false,
            errorReason: error instanceof Error ? error.message : "settlement_transaction_failed",
            transaction: "",
            network: payload.accepted.network,
            payer: sessionRecord.approval.payer,
          };
        }
      }

      const txHash = keccak256(
        encodePacked(
          ["bytes32", "uint256", "uint256", "uint256"],
          [receipt.sessionId, startNonce, endNonce, total],
        ),
      );

      sessionRecord.receipts = sessionRecord.receipts.filter(entry => {
        const nonce = BigInt(entry.nonce);
        return nonce < startNonce || nonce > endNonce;
      });

      return {
        success: true,
        transaction: txHash,
        network: payload.accepted.network,
        payer: sessionRecord.approval.payer,
      };
    } finally {
      sessionRecord.settling = false;
      this.store.setSession(receipt.sessionId, sessionRecord);
    }
  }

  private async verifySessionApproval(
    approval: OdpDeferredSessionApproval,
    signature: `0x${string}`,
    chainId: number,
    settlementContract: `0x${string}`,
  ): Promise<boolean> {
    try {
      return await this.signer.verifyTypedData({
        address: approval.payer,
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
        signature,
      });
    } catch {
      return false;
    }
  }

  private async verifyReceipt(
    receipt: OdpDeferredReceipt,
    signature: `0x${string}`,
    payer: `0x${string}`,
    chainId: number,
    settlementContract: `0x${string}`,
  ): Promise<boolean> {
    try {
      return await this.signer.verifyTypedData({
        address: payer,
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
        signature,
      });
    } catch {
      return false;
    }
  }

  private async getDebitWalletState(
    debitWallet: `0x${string}`,
    payer: `0x${string}`,
    asset: `0x${string}`,
  ): Promise<{ balance: bigint; withdrawDelaySeconds: bigint }> {
    const [balance, withdrawDelaySeconds] = await Promise.all([
      this.signer.readContract({
        address: debitWallet,
        abi: debitWalletAbi,
        functionName: "balanceOf",
        args: [getAddress(payer), getAddress(asset)],
      }),
      this.signer.readContract({
        address: debitWallet,
        abi: debitWalletAbi,
        functionName: "withdrawDelaySeconds",
      }),
    ]);

    return {
      balance: BigInt(balance as bigint),
      withdrawDelaySeconds: BigInt(withdrawDelaySeconds as bigint),
    };
  }

  private isAuthorizedProcessor(authorizedProcessors?: readonly `0x${string}`[]): boolean {
    if (!authorizedProcessors || authorizedProcessors.length === 0) {
      return true;
    }

    const signers = this.signer.getAddresses().map(address => getAddress(address));

    return authorizedProcessors.some(allowed =>
      signers.some(signer => isAddressEqual(signer, allowed)),
    );
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
