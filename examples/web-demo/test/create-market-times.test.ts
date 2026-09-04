import { describe, expect, it } from "vitest";
import {
  buildCreateMarketTimes,
  assertCreationTimingExecutable,
  parseUtcDateTime,
  formatCreatorSettlementWindow,
} from "../src/create-market-times.js";

describe("buildCreateMarketTimes", () => {
  const input = {
    closeAt: "2026-09-10T12:00",
    eventStartsAt: "2026-09-10T12:01",
    outcomeDeadlineAt: "2026-09-11T12:00",
    resolutionWindowSeconds: 900,
  };
  it("uses UTC absolute values and anchors timeout at the outcome deadline", () => {
    const times = buildCreateMarketTimes(input);
    expect(times.closeAt).toBe(
      BigInt(Date.parse("2026-09-10T12:00:00Z") / 1_000),
    );
    expect(times.resolutionDeadlineAt).toBe(times.outcomeDeadlineAt + 900n);
    expect(times).toEqual(buildCreateMarketTimes(input));
  });
  it("requires explicit null for an unknown start and still requires an outcome deadline", () => {
    expect(
      buildCreateMarketTimes({ ...input, eventStartsAt: null }).eventStartsAt,
    ).toBeNull();
    expect(() =>
      buildCreateMarketTimes({ ...input, eventStartsAt: "" }),
    ).toThrow();
    expect(() =>
      buildCreateMarketTimes({
        ...input,
        eventStartsAt: null,
        outcomeDeadlineAt: "",
      }),
    ).toThrow();
  });
  it("checks equality boundaries without adding an event or settlement waiting period", () => {
    expect(() =>
      buildCreateMarketTimes({ ...input, eventStartsAt: input.closeAt }),
    ).toThrow();
    expect(() =>
      buildCreateMarketTimes({
        ...input,
        eventStartsAt: input.outcomeDeadlineAt,
      }),
    ).not.toThrow();
    expect(() =>
      buildCreateMarketTimes({
        ...input,
        eventStartsAt: null,
        outcomeDeadlineAt: input.closeAt,
      }),
    ).not.toThrow();
  });
  it("revalidates against chain time without moving the original intent", () => {
    const times = buildCreateMarketTimes(input);
    const original = { ...times };
    for (const remaining of [300n, 90n * 86_400n])
      expect(() =>
        assertCreationTimingExecutable(times, {
          observedAt: times.closeAt - remaining,
          resolutionWindow: 900n,
        }),
      ).not.toThrow();
    for (const remaining of [299n, 90n * 86_400n + 1n])
      expect(() =>
        assertCreationTimingExecutable(times, {
          observedAt: times.closeAt - remaining,
          resolutionWindow: 900n,
        }),
      ).toThrow(/重新确认/);
    expect(() =>
      assertCreationTimingExecutable(times, {
        observedAt: times.closeAt - 600n,
        resolutionWindow: 1_800n,
      }),
    ).toThrow(/不一致/);
    expect(times).toEqual(original);
  });
  it.each([null, undefined, 899, 30 * 86_400 + 1])(
    "requires a verified frozen window: %s",
    (resolutionWindowSeconds) => {
      expect(() =>
        buildCreateMarketTimes({ ...input, resolutionWindowSeconds }),
      ).toThrow();
    },
  );
  it.each([
    "",
    "2026-02-30T12:00",
    "2026-09-10T24:00",
    "2026-09-10T12:00+08:00",
  ])("rejects malformed/normalized dates: %s", (value) => {
    expect(() => parseUtcDateTime(value, "时间")).toThrow();
  });
});

describe("formatCreatorSettlementWindow", () => {
  it("formats whole-minute factory windows used by the live demo", () => {
    expect(formatCreatorSettlementWindow(900)).toBe("15 分钟");
    expect(formatCreatorSettlementWindow(86_400)).toBe("1 天");
    expect(formatCreatorSettlementWindow(null)).toBe("Factory 配置的结算窗口");
  });
});
