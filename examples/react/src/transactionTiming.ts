export const TRANSACTION_DEADLINE_WINDOW_SECONDS = 30n * 60n;

export function unixTimeSeconds(nowMilliseconds = Date.now()): bigint {
  if (!Number.isFinite(nowMilliseconds) || nowMilliseconds < 0) {
    throw new RangeError("nowMilliseconds must be a finite non-negative number");
  }
  return BigInt(Math.floor(nowMilliseconds / 1_000));
}

export function transactionDeadline(nowMilliseconds = Date.now()): bigint {
  return unixTimeSeconds(nowMilliseconds) + TRANSACTION_DEADLINE_WINDOW_SECONDS;
}
