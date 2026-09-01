import { describe, expect, it } from "vitest";
import { marketDisplayState } from "../src/protocol.js";

describe("market display state", () => {
  it("keeps an unexpired open market tradable", () => {
    expect(marketDisplayState({ marketState: 0, observedAt: 99n, closeAt: 100n })).toEqual({
      label: "OPEN",
      primaryBuyOpen: true,
    });
  });

  it("closes primary trading exactly at closeAt even before settlement", () => {
    expect(marketDisplayState({ marketState: 0, observedAt: 100n, closeAt: 100n })).toEqual({
      label: "已截止，待结算",
      primaryBuyOpen: false,
    });
  });

  it("keeps terminal markets closed regardless of closeAt", () => {
    expect(marketDisplayState({ marketState: 1, observedAt: 99n, closeAt: 100n })).toEqual({
      label: "RESOLVED",
      primaryBuyOpen: false,
    });
  });
});
