import { describe, expect, it } from "vitest";
import { submissionFailure } from "../src/automatic-diagnostics.js";

describe("safe submission failure diagnostics", () => {
  it.each([
    ["request timed out", "timeout"],
    ["429 Too Many Requests", "rate_limit"],
    ["You reached free plan rate limit", "quota"],
    ["insufficient funds", "insufficient_funds"],
    ["replacement transaction underpriced", "nonce_conflict"],
    ["gas required exceeds allowance", "gas_limit"],
    ["submission_rpc_unavailable", "writer_unavailable"],
    ["broadcast_hash_mismatch", "hash_mismatch"],
  ])("classifies %s without publishing its message", (message, reason) => {
    expect(submissionFailure(new Error(message))).toEqual({ reason });
  });
  it("traverses wrapped RPC errors but never returns URL, bytes or arbitrary fields", () => {
    const cause = {
      code: -32000,
      message: "insufficient funds https://private.test/credential 0xdeadbeef",
      data: "private bytes",
    };
    expect(submissionFailure({ message: "HTTP failure", cause })).toEqual({
      reason: "insufficient_funds",
      rpcCode: -32000,
    });
    expect(
      submissionFailure({ code: NaN, message: "arbitrary", secret: "private" }),
    ).toEqual({ reason: "rejected" });
    expect(submissionFailure("secret")).toEqual({ reason: "unknown" });
  });
  it("bounds cyclic causes", () => {
    const error: { cause?: unknown; message: string } = {
      message: "request timed out",
    };
    error.cause = error;
    expect(submissionFailure(error)).toEqual({ reason: "timeout" });
  });
});
