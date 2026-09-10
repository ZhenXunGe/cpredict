import { describe, expect, it } from "vitest";
import {
  encodeMarketRules,
  marketRulesMatchTimes,
  type MarketRules,
} from "../src/market-rules.js";

const rules: MarketRules = {
  version: "cpredict-rules-v2",
  question: "Will the observable event occur before the deadline?",
  outcomes: ["Yes", "No"],
  closeAt: 1_900_000_000,
  eventStartsAt: null,
  outcomeDeadlineAt: 1_900_000_000,
  resolutionDeadlineAt: 1_900_000_000 + 86_400,
  resolutionSource: "https://example.invalid/source",
  resolutionCriteria:
    "The source must explicitly report that the event occurred before closeAt.",
  cancellationPolicy:
    "If the source is unavailable or the event is cancelled, void and refund.",
};

describe("market rules commitment", () => {
  it("commits every absolute time and explicit unknown instead of silently accepting v1", () => {
    const base = encodeMarketRules(rules);
    expect(base.canonicalJson).toContain('"eventStartsAt":null');
    for (const changed of [
      { closeAt: rules.closeAt - 1 },
      {
        eventStartsAt: rules.closeAt + 1,
        outcomeDeadlineAt: rules.outcomeDeadlineAt + 1,
      },
      { outcomeDeadlineAt: rules.outcomeDeadlineAt + 1 },
      { resolutionDeadlineAt: rules.resolutionDeadlineAt + 1 },
    ])
      expect(encodeMarketRules({ ...rules, ...changed }).rulesHash).not.toBe(
        base.rulesHash,
      );
    expect(() =>
      encodeMarketRules({ ...rules, version: "cpredict-rules-v1" } as never),
    ).toThrow();
    expect(() =>
      encodeMarketRules({ ...rules, eventStartsAt: undefined } as never),
    ).toThrow();
    expect(() => encodeMarketRules({ ...rules, eventStartsAt: 0 })).toThrow();
  });
  it("does not trust a matching close when the other chain times differ", () => {
    const times = {
      closeAt: BigInt(rules.closeAt),
      eventStartsAt: null,
      outcomeDeadlineAt: BigInt(rules.outcomeDeadlineAt),
      resolutionDeadlineAt: BigInt(rules.resolutionDeadlineAt),
    };
    expect(marketRulesMatchTimes(rules, times)).toBe(true);
    for (const change of [
      { eventStartsAt: 1n },
      { outcomeDeadlineAt: 2n },
      { resolutionDeadlineAt: 3n },
      { outcomeDeadlineAt: null },
    ])
      expect(marketRulesMatchTimes(rules, { ...times, ...change })).toBe(false);
  });
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
