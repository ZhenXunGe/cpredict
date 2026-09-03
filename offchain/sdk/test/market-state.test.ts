import { describe, expect, it } from "vitest";
import {
  MARKET_STATE,
  VOID_REASON,
  assertMarketState,
} from "../src/market-state.js";

describe("market state invariants", () => {
  it("accepts open/resolved with no reason and voided with a known reason", () => {
    expect(() =>
      assertMarketState(MARKET_STATE.OPEN, VOID_REASON.NONE),
    ).not.toThrow();
    expect(() =>
      assertMarketState(MARKET_STATE.RESOLVED, VOID_REASON.NONE),
    ).not.toThrow();
    expect(() =>
      assertMarketState(MARKET_STATE.VOIDED, VOID_REASON.NO_WINNING_SUPPLY),
    ).not.toThrow();
  });

  it("rejects mixed or unknown terminal combinations", () => {
    expect(() =>
      assertMarketState(MARKET_STATE.OPEN, VOID_REASON.TIMEOUT),
    ).toThrow(/invalid market state\/reason/);
    expect(() =>
      assertMarketState(MARKET_STATE.VOIDED, VOID_REASON.NONE),
    ).toThrow(/invalid market state\/reason/);
    expect(() => assertMarketState(3, 0)).toThrow(
      /invalid market state\/reason/,
    );
  });
});
