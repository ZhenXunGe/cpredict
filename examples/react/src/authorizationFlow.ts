import type { TransactionResult } from "../../../offchain/sdk/src/index.js";

export function authorizationRequired(
  current: bigint | null | undefined,
  required: bigint,
): boolean {
  if (required < 0n) throw new RangeError("required authorization cannot be negative");
  return current === null || current === undefined || current < required;
}

/**
 * Runs a confirmed authorization before the requested operation only when it is
 * required. A rejected or unknown authorization result rejects the sequence, so
 * the economic operation is never submitted automatically after that failure.
 */
export async function authorizeThenExecute<T extends TransactionResult>(
  required: boolean,
  authorize: () => Promise<TransactionResult>,
  execute: () => Promise<T>,
): Promise<T> {
  if (required) await authorize();
  return execute();
}
