import { describe, expect, it } from "vitest";
import {
  formatShareUnits,
  formatUsdc,
  parseShareUnits,
  parseUsdc,
} from "../src/units.js";

describe("exact units", () => {
  it("round-trips USDC and share units", () => {
    expect(parseUsdc("1.000001")).toBe(1_000_001n);
    expect(formatUsdc(1_000_001n)).toBe("1.000001");
    expect(parseShareUnits("3.5")).toBe(3_500_000n);
    expect(formatShareUnits(3_500_000n)).toBe("3.5");
  });

  it("rejects implicit rounding and exponent notation", () => {
    expect(() => parseUsdc("0.0000001")).toThrow(RangeError);
    expect(() => parseUsdc("1e6")).toThrow(TypeError);
    expect(() => parseUsdc("-1")).toThrow(TypeError);
  });
});
