import { describe, expect, it } from "vitest";
import { createMarketInputSchema } from "../src/schemas.js";

const input = {
  factory: "0x0000000000000000000000000000000000000001",
  userSalt: `0x${"11".repeat(32)}`,
  params: {
    rulesHash: `0x${"22".repeat(32)}`,
    metadataURI: "ipfs://rules",
    resolutionSourceHash: `0x${"33".repeat(32)}`,
    resolutionSourceURI: "",
    outcomeCount: 2,
    closeAt: 1_900_000_000n,
    eventStartsAt: 0n,
    outcomeDeadlineAt: 1_900_000_000n,
    creatorTreasury: "0x0000000000000000000000000000000000000002",
    deploymentMode: 0,
    featureFlags: 1n,
    creatorRakeBps: 500,
    creatorC2CFeeBps: 0,
    perUserPrimaryCap: 100_000_000n,
    marketPrimaryCap: 100_000_000n,
    minimumPrimaryUnits: 10_000n,
    minimumC2CUnits: 10_000n,
    creatorBond: 10_000_000n,
  },
};

describe("target-version creation parameters", () => {
  it("accepts an absolute close without a client-supplied early-bird start", () => {
    expect(createMarketInputSchema.parse(input).params.closeAt).toBe(
      input.params.closeAt,
    );
  });

  it("rejects removed parameters instead of silently accepting a stale client", () => {
    expect(() =>
      createMarketInputSchema.parse({
        ...input,
        params: { ...input.params, earlyBirdStart: 1_899_999_000n },
      }),
    ).toThrow(/earlyBirdStart/);
  });
});
