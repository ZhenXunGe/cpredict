import { describe, expect, it } from "vitest";
import {
  buildCreateMarketTimes,
  MARKET_CREATION_MINING_BUFFER_SECONDS,
} from "../src/create-market-times.js";

describe("buildCreateMarketTimes", () => {
  it("keeps earlyBirdStart valid when the transaction is mined after submission", () => {
    const submittedAt = 1_000_000n;
    const minedAt = submittedAt + 8n;

    const times = buildCreateMarketTimes(submittedAt, 1);

    expect(times.earlyBirdStart).toBe(submittedAt + MARKET_CREATION_MINING_BUFFER_SECONDS);
    expect(times.earlyBirdStart).toBeGreaterThanOrEqual(minedAt);
    expect(times.earlyBirdStart).toBeLessThan(times.closeAt);
  });

  it("preserves the requested duration for the 90-day boundary", () => {
    const submittedAt = 1_000_000n;

    expect(buildCreateMarketTimes(submittedAt, 90).closeAt).toBe(submittedAt + 90n * 86_400n);
  });

  it.each([0, 91, 1.5])("rejects an invalid duration of %s days", (durationDays) => {
    expect(() => buildCreateMarketTimes(1_000_000n, durationDays)).toThrow(RangeError);
  });
});
