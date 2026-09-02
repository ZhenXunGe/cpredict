import { BaseError, ContractFunctionRevertedError, type Hex } from "viem";
import { GasPolicyError } from "./transaction-policy.js";

export type ProtocolErrorKind =
  | "expected-race"
  | "authorization"
  | "configuration"
  | "accounting-critical"
  | "transport"
  | "gas-safety"
  | "unknown";

export interface ProtocolErrorDetails {
  kind: ProtocolErrorKind;
  retryableAfterRefresh: boolean;
  errorName?: string;
  selector?: Hex;
  message: string;
}

interface ProtocolErrorCopy {
  name: string;
  kind: ProtocolErrorKind;
  message: string;
}

/** Selectors from `generated/registries/errors.json`; do not depend on provider strings. */
const PROTOCOL_ERROR_BY_SELECTOR = {
  "0x560ff900": {
    name: "AlreadySettled",
    kind: "expected-race",
    message: "该项已领取或已处理，不能重复领取。请刷新市场状态。",
  },
  "0x1f2c89f0": {
    name: "Insolvent",
    kind: "accounting-critical",
    message: "市场资金覆盖不足，结算已拒绝。",
  },
  "0xcc25fc42": {
    name: "InvalidOutcome",
    kind: "configuration",
    message: "结果编号越界，请核对 Winning outcome 后重试。",
  },
  "0xa8a9eb69": {
    name: "MarketNotClosed",
    kind: "expected-race",
    message: "市场尚未截止，不能结算。请等待 closeAt 之后刷新再试。",
  },
  "0xc02d38cc": {
    name: "MarketNotOpen",
    kind: "expected-race",
    message: "市场未开放，无法完成该操作。请刷新市场状态。",
  },
  "0xcd652fe2": {
    name: "MarketTerminal",
    kind: "expected-race",
    message: "市场已终局，不能再次结算或作废。请刷新市场状态。",
  },
  "0x969bf728": {
    name: "NothingToClaim",
    kind: "expected-race",
    message: "当前账户没有可领取或可退还的金额。请刷新后确认资格。",
  },
  "0xbdf16b93": {
    name: "PauseActive",
    kind: "authorization",
    message: "协议暂停中，写操作已拒绝。",
  },
  "0x89da025b": {
    name: "ResolutionWindowExpired",
    kind: "expected-race",
    message:
      "结算窗口已过，无法再 Creator Resolve 或 Creator void。请改用超时作废。",
  },
  "0x9b0056ac": {
    name: "TimeoutNotReached",
    kind: "expected-race",
    message:
      "结算窗口尚未结束，不能执行超时作废。请等待 resolutionDeadline 之后再试。",
  },
  "0x8e4a23d6": {
    name: "Unauthorized",
    kind: "authorization",
    message: "当前钱包不是该市场 Creator，无法执行此操作。",
  },
  "0xe8327997": {
    name: "WinningOutcomeHasNoSupply",
    kind: "configuration",
    message: "所选获胜结果没有份额，不能结算到该结果。请改选有持仓的 outcome。",
  },
} as const satisfies Record<string, ProtocolErrorCopy>;

const PROTOCOL_ERROR_BY_NAME: Record<string, ProtocolErrorCopy> =
  Object.fromEntries(
    Object.values(PROTOCOL_ERROR_BY_SELECTOR).map((entry) => [
      entry.name,
      entry,
    ]),
  );

const expectedRaceErrors = new Set([
  "AlreadySettled",
  "DeadlineExpired",
  "FillBelowMinimum",
  "ListingNotActive",
  "ListingExpired",
  "MarketNotClosed",
  "MarketTerminal",
  "MarketNotOpen",
  "NothingToClaim",
  "ExposureCapExceeded",
  "ResolutionWindowExpired",
  "TimeoutNotReached",
]);
const authorizationErrors = new Set([
  "Unauthorized",
  "Permit2Disabled",
  "PauseActive",
]);
const accountingErrors = new Set([
  "Insolvent",
  "InexactTokenTransfer",
  "BondStateMismatch",
]);

const UNKNOWN_REVERT_MESSAGE =
  "链上模拟已拒绝，交易未发送。请刷新市场状态后重试。";

/** Reduces viem errors to stable UI/telemetry categories without exposing calldata or signatures. */
export function classifyProtocolError(error: unknown): ProtocolErrorDetails {
  if (error instanceof GasPolicyError) {
    return {
      kind: "gas-safety",
      retryableAfterRefresh: true,
      message: safeMessage(error.message),
    };
  }
  if (error instanceof BaseError) {
    const reverted = error.walk(
      (candidate) => candidate instanceof ContractFunctionRevertedError,
    );
    if (reverted instanceof ContractFunctionRevertedError) {
      return classifyRevertedError(reverted);
    }
    return {
      kind: "transport",
      retryableAfterRefresh: true,
      message: safeMessage(error.shortMessage),
    };
  }
  return {
    kind: "unknown",
    retryableAfterRefresh: false,
    message: safeMessage(
      error instanceof Error ? error.message : "unknown protocol error",
    ),
  };
}

function classifyRevertedError(
  reverted: ContractFunctionRevertedError,
): ProtocolErrorDetails {
  const selector = revertSelector(reverted);
  const decodedName = reverted.data?.errorName;
  const copy =
    (decodedName === undefined
      ? undefined
      : PROTOCOL_ERROR_BY_NAME[decodedName]) ??
    (selector === undefined
      ? undefined
      : PROTOCOL_ERROR_BY_SELECTOR[
          selector as keyof typeof PROTOCOL_ERROR_BY_SELECTOR
        ]);
  if (copy !== undefined) {
    return {
      kind: copy.kind,
      retryableAfterRefresh: copy.kind === "expected-race",
      errorName: copy.name,
      ...(selector === undefined ? {} : { selector }),
      message: copy.message,
    };
  }
  const errorName = decodedName;
  const kind =
    errorName === undefined
      ? "unknown"
      : expectedRaceErrors.has(errorName)
        ? "expected-race"
        : authorizationErrors.has(errorName)
          ? "authorization"
          : accountingErrors.has(errorName)
            ? "accounting-critical"
            : "configuration";
  return {
    kind,
    retryableAfterRefresh: kind === "expected-race" || kind === "unknown",
    ...(errorName === undefined ? {} : { errorName }),
    ...(selector === undefined ? {} : { selector }),
    message: UNKNOWN_REVERT_MESSAGE,
  };
}

function revertSelector(
  reverted: ContractFunctionRevertedError,
): Hex | undefined {
  if (isErrorSelector(reverted.signature))
    return normalizeSelector(reverted.signature);
  if (isErrorSelector(reverted.raw))
    return normalizeSelector(reverted.raw.slice(0, 10));
  const match = `${reverted.shortMessage}\n${reverted.message}`.match(
    /signature:\s*(0x[0-9a-fA-F]{8})\b/i,
  );
  const captured = match?.[1];
  return captured === undefined ? undefined : normalizeSelector(captured);
}

function isErrorSelector(value: string | undefined): value is Hex {
  return value !== undefined && /^0x[0-9a-fA-F]{8}$/.test(value);
}

function normalizeSelector(value: string): Hex {
  return value.toLowerCase() as Hex;
}

function safeMessage(message: string): string {
  return message
    .replace(/0x[0-9a-fA-F]{64,}/g, "[redacted-data]")
    .replace(
      /signature:\s*0x[0-9a-fA-F]{8}\b/gi,
      "signature: [redacted-selector]",
    )
    .slice(0, 256);
}
