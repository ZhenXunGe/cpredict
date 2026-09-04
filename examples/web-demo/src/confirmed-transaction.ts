import type { TransactionResult } from "../../../offchain/sdk/src/client.js";

/** A failed read after confirmation must not turn a successful write into a retry. */
export async function refreshConfirmedTransaction<T extends TransactionResult>(
  result: T,
  refresh: () => Promise<void>,
): Promise<{ result: T; refreshError: unknown | null }> {
  try {
    await refresh();
    return { result, refreshError: null };
  } catch (refreshError: unknown) {
    return { result, refreshError };
  }
}
