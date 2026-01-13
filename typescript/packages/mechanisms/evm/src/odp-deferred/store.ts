import { OdpDeferredReceipt, OdpDeferredSessionApproval } from "../types";

export type OdpDeferredSessionRecord = {
  approval: OdpDeferredSessionApproval;
  sessionSignature?: `0x${string}`;
  settlementContract: `0x${string}`;
  nextNonce: bigint;
  spent: bigint;
  receipts: OdpDeferredReceipt[];
  settling: boolean;
};

export interface OdpDeferredStore {
  getSession(sessionId: `0x${string}`): OdpDeferredSessionRecord | undefined;
  setSession(sessionId: `0x${string}`, record: OdpDeferredSessionRecord): void;
  deleteSession(sessionId: `0x${string}`): void;
}

export class InMemoryOdpDeferredStore implements OdpDeferredStore {
  private sessions = new Map<string, OdpDeferredSessionRecord>();

  getSession(sessionId: `0x${string}`): OdpDeferredSessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  setSession(sessionId: `0x${string}`, record: OdpDeferredSessionRecord): void {
    this.sessions.set(sessionId, record);
  }

  deleteSession(sessionId: `0x${string}`): void {
    this.sessions.delete(sessionId);
  }
}
