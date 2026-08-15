import { describe, expect, it } from "vitest";
import { classifyProtocolError } from "../src/errors.js";

describe("protocol error redaction", () => {
  it("does not expose signatures or calldata from unknown providers", () => {
    const secret = `0x${"ab".repeat(65)}`;
    const result = classifyProtocolError(
      new Error(`provider rejected ${secret}`),
    );

    expect(result.message).toContain("[redacted-data]");
    expect(result.message).not.toContain(secret);
  });
});
