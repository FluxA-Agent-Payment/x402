import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";

export const decodePaymentRequired = (header: string): PaymentRequired =>
  JSON.parse(Buffer.from(header, "base64").toString("utf-8")) as PaymentRequired;

export const encodePaymentPayload = (payload: PaymentPayload): string =>
  Buffer.from(JSON.stringify(payload)).toString("base64");

export const getFirstRequirement = (
  paymentRequired: PaymentRequired,
): PaymentRequirements => {
  const accepts = paymentRequired.accepts;
  if (Array.isArray(accepts)) {
    if (!accepts[0]) {
      throw new Error("No payment requirements returned");
    }
    return accepts[0];
  }
  return accepts as PaymentRequirements;
};

export const nowMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

export const average = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
};

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  if (tasks.length === 0) {
    return [];
  }

  const results: T[] = [];
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }).map(async () => {
    while (index < tasks.length) {
      const current = tasks[index];
      index += 1;
      if (!current) {
        continue;
      }
      const result = await current();
      results.push(result);
    }
  });

  await Promise.all(workers);
  return results;
}
