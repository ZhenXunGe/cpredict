import { describe, expect, it } from "vitest";
import {
  TRANSACTION_DEADLINE_WINDOW_SECONDS,
  transactionDeadline,
  unixTimeSeconds,
} from "../../react/src/transactionTiming.js";

describe("transaction timing", () => {
  it("allows 30 minutes for wallet confirmation", () => {
    const nowMilliseconds = 1_900_000_000_999;

    expect(TRANSACTION_DEADLINE_WINDOW_SECONDS).toBe(1_800n);
    expect(transactionDeadline(nowMilliseconds)).toBe(1_900_001_800n);
  });

  it("floors milliseconds to whole Unix seconds", () => {
    expect(unixTimeSeconds(1_999)).toBe(1n);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "rejects invalid current time %s",
    (nowMilliseconds) => {
      expect(() => unixTimeSeconds(nowMilliseconds)).toThrow(RangeError);
    },
  );
});
