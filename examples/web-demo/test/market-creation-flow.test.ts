import { getAddress, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { CreateMarketResult } from "../../../offchain/sdk/src/index.js";
import { completeMarketCreation } from "../src/market-creation-flow.js";

describe("created market navigation flow", () => {
  it("selects, exposes and loads the emitted Vault in order", async () => {
    const result: CreateMarketResult = {
      market: "0xb3c7c04fbbea7873bcfc1ea5b5288601486ec9a3",
      hash: `0x${"34".repeat(32)}`,
      blockNumber: 30_431_583n,
      gasUsed: 5_487_223n,
    };
    const expected = getAddress(result.market);
    const calls: string[] = [];
    let selected: Address | null = null;

    const market = await completeMarketCreation(result, {
      selectMarket: (address) => { selected = address; calls.push(`select:${address}`); },
      navigateToMarket: () => { calls.push("navigate"); },
      recordMarketVault: (address, hash) => { calls.push(`receipt:${address}:${hash}`); },
      loadMarket: vi.fn(async (address) => { calls.push(`load:${address}`); }),
    });

    expect(market).toBe(expected);
    expect(selected).toBe(expected);
    expect(calls).toEqual([
      `select:${expected}`,
      "navigate",
      `receipt:${expected}:${result.hash}`,
      `load:${expected}`,
    ]);
  });
});
