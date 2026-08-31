const SECONDS_PER_DAY = 86_400n;

export const MARKET_CREATION_MINING_BUFFER_SECONDS = 10n * 60n;

export function buildCreateMarketTimes(nowSeconds: bigint, durationDays: number) {
  if (!Number.isSafeInteger(durationDays) || durationDays < 1 || durationDays > 90) {
    throw new RangeError("市场期限必须在 1–90 天");
  }

  const closeAt = nowSeconds + BigInt(durationDays) * SECONDS_PER_DAY;
  const earlyBirdStart = nowSeconds + MARKET_CREATION_MINING_BUFFER_SECONDS;
  if (earlyBirdStart >= closeAt) throw new RangeError("市场期限不足以容纳链上确认缓冲");

  return { closeAt, earlyBirdStart };
}
