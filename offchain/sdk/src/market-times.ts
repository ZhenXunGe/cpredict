export interface MarketTimes {
  closeAt: bigint;
  eventStartsAt: bigint | null;
  outcomeDeadlineAt: bigint;
  resolutionDeadlineAt?: bigint;
}

/** Zero is only an ABI sentinel. Product/rules callers must use explicit null. */
export function assertMarketTimes(times: MarketTimes): void {
  if (times.closeAt <= 0n || times.outcomeDeadlineAt < times.closeAt)
    throw new RangeError("结果判断截止不得早于封盘时间");
  if (
    times.eventStartsAt !== null &&
    (times.eventStartsAt <= times.closeAt ||
      times.eventStartsAt > times.outcomeDeadlineAt)
  )
    throw new RangeError("必须满足：封盘 < 事件开始 ≤ 结果判断截止");
  if (
    times.resolutionDeadlineAt !== undefined &&
    times.resolutionDeadlineAt <= times.outcomeDeadlineAt
  )
    throw new RangeError("结算超时必须晚于结果判断截止");
}
