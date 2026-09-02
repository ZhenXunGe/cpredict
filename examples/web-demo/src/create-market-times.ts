const SECONDS_PER_MINUTE = 60n;
const MAX_MARKET_DURATION_MINUTES = 90 * 24 * 60;

export const MARKET_CREATION_MINING_BUFFER_SECONDS = 10n * 60n;
export const MIN_MARKET_DURATION_MINUTES = Number(MARKET_CREATION_MINING_BUFFER_SECONDS / SECONDS_PER_MINUTE) + 1;
export { MAX_MARKET_DURATION_MINUTES };

export function buildCreateMarketTimes(nowSeconds: bigint, durationMinutes: number) {
  if (
    !Number.isSafeInteger(durationMinutes)
    || durationMinutes < MIN_MARKET_DURATION_MINUTES
    || durationMinutes > MAX_MARKET_DURATION_MINUTES
  ) {
    throw new RangeError(`市场期限必须在 ${MIN_MARKET_DURATION_MINUTES}–${MAX_MARKET_DURATION_MINUTES} 分钟`);
  }

  const closeAt = nowSeconds + BigInt(durationMinutes) * SECONDS_PER_MINUTE;
  const earlyBirdStart = nowSeconds + MARKET_CREATION_MINING_BUFFER_SECONDS;
  if (earlyBirdStart >= closeAt) throw new RangeError("市场期限不足以容纳链上确认缓冲");

  return { closeAt, earlyBirdStart };
}
