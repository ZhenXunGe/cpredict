import { describe, expect, it } from "vitest";
import {
  buildCreateMarketTimes,
  formatCreatorSettlementWindow,
  MAX_MARKET_DURATION_MINUTES,
  MARKET_CREATION_MINING_BUFFER_SECONDS,
  MIN_MARKET_DURATION_MINUTES,
} from "../src/create-market-times.js";

describe("buildCreateMarketTimes", () => {
  it("keeps earlyBirdStart valid when the transaction is mined after submission", () => {
    const submittedAt = 1_000_000n;
    const minedAt = submittedAt + 8n;

    const times = buildCreateMarketTimes(submittedAt, 15);

    expect(times.earlyBirdStart).toBe(
      submittedAt + MARKET_CREATION_MINING_BUFFER_SECONDS,
    );
    expect(times.earlyBirdStart).toBeGreaterThanOrEqual(minedAt);
    expect(times.earlyBirdStart).toBeLessThan(times.closeAt);
  });

  it("preserves a requested 15-minute duration", () => {
    const submittedAt = 1_000_000n;

    expect(buildCreateMarketTimes(submittedAt, 15).closeAt).toBe(
      submittedAt + 15n * 60n,
    );
  });

  it("preserves the 90-day maximum boundary", () => {
    const submittedAt = 1_000_000n;

    expect(
      buildCreateMarketTimes(submittedAt, MAX_MARKET_DURATION_MINUTES).closeAt,
    ).toBe(submittedAt + 90n * 86_400n);
  });

  it.each([
    MIN_MARKET_DURATION_MINUTES - 1,
    MAX_MARKET_DURATION_MINUTES + 1,
    15.5,
  ])("rejects an invalid duration of %s minutes", (durationMinutes) => {
    expect(() => buildCreateMarketTimes(1_000_000n, durationMinutes)).toThrow(
      RangeError,
    );
  });
});

describe("formatCreatorSettlementWindow", () => {
  it("formats whole-minute factory windows used by the live demo", () => {
    expect(formatCreatorSettlementWindow(900)).toBe("15 分钟");
    expect(formatCreatorSettlementWindow(86_400)).toBe("1 天");
    expect(formatCreatorSettlementWindow(null)).toBe("Factory 配置的结算窗口");
  });
});
