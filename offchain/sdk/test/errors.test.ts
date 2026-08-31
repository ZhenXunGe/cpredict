import { describe, expect, it } from "vitest";
import { classifyProtocolError } from "../src/errors.js";
import { GasPolicyError } from "../src/transaction-policy.js";

describe("protocol error redaction", () => {
  it("does not expose signatures or calldata from unknown providers", () => {
    const secret = `0x${"ab".repeat(65)}`;
    const result = classifyProtocolError(
      new Error(`provider rejected ${secret}`),
    );

    expect(result.message).toContain("[redacted-data]");
    expect(result.message).not.toContain(secret);
  });

  it("classifies unsafe gas as a pre-signing safety block", () => {
    const result = classifyProtocolError(
      new GasPolicyError("fee-above-limit", "费用超过安全上限"),
    );

    expect(result).toEqual({
      kind: "gas-safety",
      retryableAfterRefresh: true,
      message: "费用超过安全上限",
    });
  });
});
