import { ContractFunctionRevertedError } from "viem";
import { describe, expect, it } from "vitest";
import { marketVaultAbi } from "../src/abis.js";
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

describe("protocol revert copy", () => {
  it("maps a decoded vault resolve revert to a readable settlement reason", () => {
    const result = classifyProtocolError(
      new ContractFunctionRevertedError({
        abi: marketVaultAbi,
        data: "0x89da025b",
        functionName: "resolve",
      }),
    );

    expect(result).toMatchObject({
      kind: "expected-race",
      retryableAfterRefresh: true,
      errorName: "ResolutionWindowExpired",
      selector: "0x89da025b",
      message:
        "结算窗口已过，无法再 Creator Resolve 或 Creator void。请改用超时作废。",
    });
    expect(result.message).not.toMatch(/0x89da025b/i);
    expect(result.message).not.toMatch(/signature/i);
  });

  it("does not show an unknown revert selector to the operator", () => {
    const result = classifyProtocolError(
      new ContractFunctionRevertedError({
        abi: [],
        data: "0xeab571a2",
        functionName: "resolve",
      }),
    );

    expect(result.kind).toBe("unknown");
    expect(result.selector).toBe("0xeab571a2");
    expect(result.message).toBe(
      "链上模拟已拒绝，交易未发送。请刷新市场状态后重试。",
    );
    expect(result.message).not.toMatch(/0xeab571a2/i);
    expect(result.message).not.toMatch(/signature/i);
  });
});
