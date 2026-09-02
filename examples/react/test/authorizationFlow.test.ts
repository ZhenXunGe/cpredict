import { describe, expect, it, vi } from "vitest";
import type { TransactionResult } from "../../../offchain/sdk/src/index.js";
import {
  authorizationRequired,
  authorizeThenExecute,
} from "../src/authorizationFlow.js";

const result = (byte: string): TransactionResult => ({
  hash: `0x${byte.repeat(64)}` as `0x${string}`,
  blockNumber: 1n,
  gasUsed: 1n,
});

describe("authorization flow", () => {
  it("requires authorization only when allowance is unknown or insufficient", () => {
    expect(authorizationRequired(null, 10n)).toBe(true);
    expect(authorizationRequired(undefined, 10n)).toBe(true);
    expect(authorizationRequired(9n, 10n)).toBe(true);
    expect(authorizationRequired(10n, 10n)).toBe(false);
    expect(authorizationRequired(11n, 10n)).toBe(false);
  });

  it("confirms authorization before the requested operation", async () => {
    const order: string[] = [];
    const authorize = vi.fn(async () => {
      order.push("authorize");
      return result("1");
    });
    const execute = vi.fn(async () => {
      order.push("execute");
      return result("2");
    });

    await expect(
      authorizeThenExecute(true, authorize, execute),
    ).resolves.toEqual(result("2"));
    expect(order).toEqual(["authorize", "execute"]);
  });

  it("does not submit the requested operation after authorization fails", async () => {
    const authorize = vi.fn(async () => {
      throw new Error("authorization outcome unknown");
    });
    const execute = vi.fn(async () => result("2"));

    await expect(
      authorizeThenExecute(true, authorize, execute),
    ).rejects.toThrow("authorization outcome unknown");
    expect(execute).not.toHaveBeenCalled();
  });

  it("skips authorization when the existing allowance is sufficient", async () => {
    const authorize = vi.fn(async () => result("1"));
    const execute = vi.fn(async () => result("2"));

    await authorizeThenExecute(false, authorize, execute);
    expect(authorize).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });
});
