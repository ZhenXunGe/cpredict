/** Only fixed reason labels and numeric RPC codes may leave a provider error.
 * Messages can contain credentials, URLs or signed transaction bytes. */
export interface SubmissionFailure {
  reason:
    | "timeout"
    | "rate_limit"
    | "quota"
    | "insufficient_funds"
    | "nonce_conflict"
    | "gas_limit"
    | "writer_unavailable"
    | "hash_mismatch"
    | "fee_too_low"
    | "nonce_changed"
    | "intent_mismatch"
    | "no_entitlement"
    | "rpc_unavailable"
    | "evidence_conflict"
    | "transaction_present"
    | "owner_opted_out"
    | "budget_exceeded"
    | "already_attempted"
    | "approval_mismatch"
    | "lane_busy"
    | "rejected"
    | "unknown";
  rpcCode?: number;
}

/** An unsigned/pre-broadcast rejection is safe to reprepare; it is never unknown. */
export class FinalValidationError extends Error {
  constructor(readonly reason: SubmissionFailure["reason"]) {
    super(reason);
  }
}

export function submissionFailure(error: unknown): SubmissionFailure {
  if (error instanceof FinalValidationError) return { reason: error.reason };
  let current: unknown = error;
  let rpcCode: number | undefined;
  let reason: SubmissionFailure["reason"] = "unknown";
  for (
    let depth = 0;
    depth < 8 && current && typeof current === "object";
    depth++
  ) {
    const item = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (
      typeof item.code === "number" &&
      Number.isSafeInteger(item.code) &&
      item.code >= -2147483648 &&
      item.code <= 2147483647
    )
      rpcCode = item.code;
    const message =
      typeof item.message === "string" ? item.message.toLowerCase() : "";
    if (/submission_rpc_unavailable/.test(message))
      reason = "writer_unavailable";
    else if (/broadcast_hash_mismatch/.test(message)) reason = "hash_mismatch";
    else if (/insufficient funds/.test(message)) reason = "insufficient_funds";
    else if (
      /nonce too low|nonce too high|replacement transaction underpriced/.test(
        message,
      )
    )
      reason = "nonce_conflict";
    else if (/out of gas|intrinsic gas|gas required exceeds/.test(message))
      reason = "gas_limit";
    else if (/quota|compute units|monthly|free plan/.test(message))
      reason = "quota";
    else if (/rate limit|too many requests|429/.test(message))
      reason = "rate_limit";
    else if (/timeout|timed out/.test(message)) reason = "timeout";
    else if (reason === "unknown" && typeof item.code === "number")
      reason = "rejected";
    current = item.cause;
  }
  return rpcCode === undefined ? { reason } : { reason, rpcCode };
}
