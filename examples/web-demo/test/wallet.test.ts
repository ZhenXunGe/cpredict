import { describe, expect, it } from "vitest";
import { arbitrumSepolia } from "../src/wallet.js";

describe("Arbitrum Sepolia chain configuration", () => {
  it("uses viem's canonical Multicall3 deployment", () => {
    expect(arbitrumSepolia.id).toBe(421_614);
    expect(arbitrumSepolia.contracts.multicall3).toEqual({
      address: "0xca11bde05977b3631167028862be2a173976ca11",
      blockCreated: 81_930,
    });
  });
});
