import { encodePacked, getAddress, keccak256 } from "viem";
import { ZERO_BYTES32 } from "./constants";

export type OdpDeferredExtras = {
  sessionId: `0x${string}`;
  startNonce: string;
  maxSpend: string;
  expiry: string;
  settlementContract: `0x${string}`;
  authorizedProcessors?: `0x${string}`[];
  requestHash?: `0x${string}`;
  maxAmountPerReceipt?: string;
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid odp-deferred extra.${field}`);
  }
  return value;
};

const optionalString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Invalid odp-deferred extra field");
  }
  return value;
};

const optionalStringArray = (value: unknown): `0x${string}`[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("Invalid odp-deferred extra.authorizedProcessors");
  }
  return value.map(item => getAddress(requireString(item, "authorizedProcessors")));
};

export const parseOdpDeferredExtras = (extra: Record<string, unknown>): OdpDeferredExtras => {
  if (!extra || typeof extra !== "object") {
    throw new Error("Missing odp-deferred extra fields");
  }

  const sessionId = requireString(extra.sessionId, "sessionId") as `0x${string}`;
  const startNonce = requireString(extra.startNonce, "startNonce");
  const maxSpend = requireString(extra.maxSpend, "maxSpend");
  const expiry = requireString(extra.expiry, "expiry");
  const settlementContract = getAddress(
    requireString(extra.settlementContract, "settlementContract"),
  );
  const authorizedProcessors = optionalStringArray(extra.authorizedProcessors);
  const requestHash = optionalString(extra.requestHash) as `0x${string}` | undefined;
  const maxAmountPerReceipt = optionalString(extra.maxAmountPerReceipt);

  return {
    sessionId,
    startNonce,
    maxSpend,
    expiry,
    settlementContract,
    authorizedProcessors,
    requestHash,
    maxAmountPerReceipt,
  };
};

export const hashAuthorizedProcessors = (
  addresses?: readonly `0x${string}`[],
): `0x${string}` => {
  if (!addresses || addresses.length === 0) {
    return ZERO_BYTES32;
  }

  const sorted = [...addresses]
    .map(address => getAddress(address).toLowerCase() as `0x${string}`)
    .sort();

  const types = sorted.map(() => "address");
  const packed = encodePacked(types as unknown as [string, ...string[]], sorted);
  return keccak256(packed);
};

export const normalizeRequestHash = (requestHash?: `0x${string}`): `0x${string}` => {
  return requestHash ?? ZERO_BYTES32;
};
