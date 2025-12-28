export type ExactEIP3009Payload = {
  signature?: `0x${string}`;
  authorization: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
};

export type ExactEvmPayloadV1 = ExactEIP3009Payload;

export type ExactEvmPayloadV2 = ExactEIP3009Payload;

export type OdpDeferredSessionApproval = {
  payer: `0x${string}`;
  payee: `0x${string}`;
  asset: `0x${string}`;
  maxSpend: string;
  expiry: string;
  sessionId: `0x${string}`;
  startNonce: string;
  authorizedProcessorsHash: `0x${string}`;
};

export type OdpDeferredReceipt = {
  sessionId: `0x${string}`;
  nonce: string;
  amount: string;
  deadline: string;
  requestHash: `0x${string}`;
};

export type OdpDeferredEvmPayloadV2 = {
  sessionApproval?: OdpDeferredSessionApproval;
  sessionSignature?: `0x${string}`;
  receipt: OdpDeferredReceipt;
  receiptSignature: `0x${string}`;
};
