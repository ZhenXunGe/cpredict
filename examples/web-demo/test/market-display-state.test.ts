import { describe, expect, it } from "vitest";
import { marketDisplayState } from "../src/protocol.js";

describe("market display state", () => {
  it("keeps an unexpired open market tradable", () => {
    expect(
      marketDisplayState({ marketState: 0, observedAt: 99n, closeAt: 100n }),
    ).toEqual({
      label: "进行中",
      primaryBuyOpen: true,
    });
  });

  it("closes primary trading exactly at closeAt even before settlement", () => {
    expect(
      marketDisplayState({ marketState: 0, observedAt: 100n, closeAt: 100n }),
    ).toEqual({
      label: "已截止，待结算",
      primaryBuyOpen: false,
    });
  });

  it("labels an expired resolution window as timeout-void pending", () => {
    expect(
      marketDisplayState({
        marketState: 0,
        observedAt: 200n,
        closeAt: 100n,
        resolutionDeadline: 200n,
      }),
    ).toEqual({
      label: "结算窗口已过，待超时作废",
      primaryBuyOpen: false,
    });
  });

  it("keeps terminal markets closed regardless of closeAt", () => {
    expect(
      marketDisplayState({ marketState: 1, observedAt: 99n, closeAt: 100n }),
    ).toEqual({
      label: "已结算",
      primaryBuyOpen: false,
    });
    expect(
      marketDisplayState({ marketState: 2, observedAt: 99n, closeAt: 100n }),
    ).toEqual({
      label: "创建者作废",
      primaryBuyOpen: false,
    });
    expect(
      marketDisplayState({ marketState: 3, observedAt: 99n, closeAt: 100n }),
    ).toEqual({
      label: "超时作废",
      primaryBuyOpen: false,
    });
  });
});
