import { BaseError, ContractFunctionRevertedError, type Hex } from "viem";

export type ProtocolErrorKind =
  | "expected-race"
  | "authorization"
  | "configuration"
  | "accounting-critical"
  | "transport"
  | "unknown";

export interface ProtocolErrorDetails {
  kind: ProtocolErrorKind;
  retryableAfterRefresh: boolean;
  errorName?: string;
  selector?: Hex;
  message: string;
}

const expectedRaceErrors = new Set([
  "DeadlineExpired",
  "FillBelowMinimum",
  "ListingNotActive",
  "ListingExpired",
  "MarketTerminal",
  "MarketNotOpen",
  "NothingToClaim",
  "ExposureCapExceeded",
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

/** Reduces viem errors to stable UI/telemetry categories without exposing calldata or signatures. */
export function classifyProtocolError(error: unknown): ProtocolErrorDetails {
  if (error instanceof BaseError) {
    const reverted = error.walk(
      (candidate) => candidate instanceof ContractFunctionRevertedError,
    );
    if (reverted instanceof ContractFunctionRevertedError) {
      const errorName = reverted.data?.errorName;
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
        retryableAfterRefresh: kind === "expected-race",
        ...(errorName === undefined ? {} : { errorName }),
        message: safeMessage(error.shortMessage),
      };
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

function safeMessage(message: string): string {
  return message
    .replace(/0x[0-9a-fA-F]{64,}/g, "[redacted-data]")
    .slice(0, 256);
}
