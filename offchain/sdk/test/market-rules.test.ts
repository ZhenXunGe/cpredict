import { describe, expect, it } from "vitest";
import { encodeMarketRules, type MarketRules } from "../src/market-rules.js";

const rules: MarketRules = {
  version: "cpredict-rules-v1",
  question: "Will the observable event occur before the deadline?",
  outcomes: ["Yes", "No"],
  closesAt: 1_900_000_000,
  resolutionSource: "https://example.invalid/source",
  resolutionCriteria:
    "The source must explicitly report that the event occurred before closesAt.",
  cancellationPolicy:
    "If the source is unavailable or the event is cancelled, void and refund.",
};

describe("market rules commitment", () => {
  it("is deterministic and commits the cancellation policy", () => {
    const first = encodeMarketRules(rules);
    const second = encodeMarketRules({ ...rules });
    expect(first).toEqual(second);
    expect(first.canonicalJson).toContain("cancellationPolicy");
    expect(
      encodeMarketRules({
        ...rules,
        cancellationPolicy: `${rules.cancellationPolicy} `,
      }).rulesHash,
    ).toBe(first.rulesHash);
    expect(
      encodeMarketRules({
        ...rules,
        cancellationPolicy: "A different valid cancellation rule.",
      }).rulesHash,
    ).not.toBe(first.rulesHash);
  });

  it("rejects missing source/rules and duplicate outcome labels", () => {
    expect(() =>
      encodeMarketRules({ ...rules, resolutionSource: "" }),
    ).toThrow();
    expect(() =>
      encodeMarketRules({ ...rules, cancellationPolicy: "" }),
    ).toThrow();
    expect(() =>
      encodeMarketRules({ ...rules, outcomes: ["Yes", "yes"] }),
    ).toThrow("unique");
  });
});
