import {
  assertMarketTimes,
  type MarketTimes,
} from "../../../offchain/sdk/src/market-times.js";

// Inputs are explicitly labelled UTC. Do not interpret them in the browser's timezone.
export function parseUtcDateTime(value: string, label: string): bigint {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))
    throw new RangeError(`请填写${label}（UTC）`);
  const normalized = value.length === 16 ? `${value}:00` : value;
  const milliseconds = Date.parse(`${normalized}Z`);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    new Date(milliseconds).toISOString().slice(0, 19) !== normalized
  )
    throw new RangeError(`${label}无效`);
  return BigInt(milliseconds / 1_000);
}

export function buildCreateMarketTimes(input: {
  closeAt: string;
  eventStartsAt: string | null;
  outcomeDeadlineAt: string;
  resolutionWindowSeconds: number | null | undefined;
}) {
  const window = input.resolutionWindowSeconds;
  if (
    window == null ||
    !Number.isSafeInteger(window) ||
    window < 900 ||
    window > 30 * 86_400
  )
    throw new RangeError("尚未验证 Factory 结算窗口，不能确认时间条款");
  const closeAt = parseUtcDateTime(input.closeAt, "封盘时间");
  const eventStartsAt =
    input.eventStartsAt === null
      ? null
      : parseUtcDateTime(input.eventStartsAt, "事件开始时间");
  const outcomeDeadlineAt = parseUtcDateTime(
    input.outcomeDeadlineAt,
    "结果判断截止时间",
  );
  const resolutionDeadlineAt = outcomeDeadlineAt + BigInt(window);
  const times = {
    closeAt,
    eventStartsAt,
    outcomeDeadlineAt,
    resolutionDeadlineAt,
  };
  assertMarketTimes(times);
  return times;
}

/** Check the original intent against a fresh chain observation; never rewrite it. */
export function assertCreationTimingExecutable(
  times: MarketTimes & { resolutionDeadlineAt: bigint },
  chain: {
    observedAt: bigint;
    resolutionWindow: bigint;
  },
): void {
  assertMarketTimes(times);
  if (
    times.closeAt < chain.observedAt + 300n ||
    times.closeAt > chain.observedAt + 90n * 86_400n
  )
    throw new RangeError(
      "封盘时间必须在当前链上时间的 5 分钟至 90 天内；请编辑并重新确认，不会自动延期",
    );
  if (
    times.resolutionDeadlineAt !==
    times.outcomeDeadlineAt + chain.resolutionWindow
  )
    throw new RangeError(
      "Factory 结算窗口与已确认条款不一致，请重新加载并确认",
    );
}

export function formatCreatorSettlementWindow(
  seconds: number | null | undefined,
): string {
  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isSafeInteger(seconds) ||
    seconds <= 0
  )
    return "Factory 配置的结算窗口";
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}
