export const odpSessionApprovalTypes = {
  SessionApproval: [
    { name: "payer", type: "address" },
    { name: "payee", type: "address" },
    { name: "asset", type: "address" },
    { name: "maxSpend", type: "uint256" },
    { name: "expiry", type: "uint256" },
    { name: "sessionId", type: "bytes32" },
    { name: "startNonce", type: "uint256" },
    { name: "authorizedProcessorsHash", type: "bytes32" },
  ],
} as const;

export const odpReceiptTypes = {
  Receipt: [
    { name: "sessionId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "amount", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "requestHash", type: "bytes32" },
  ],
} as const;

export const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
