import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import { buildBusinessCalls, type AdmissionReader } from "../src/calls.js";
import {
  environmentSchema,
  intentSchema,
  siteConfigSchema,
} from "../src/contracts.js";
import {
  bondEscrowAbi,
  marketVaultAbi,
  marketFactoryAbi,
} from "../../sdk/src/abis.js";
import { A, H, env } from "./fixtures.js";

const reader: AdmissionReader = {
  async registeredMarket() {
    return true;
  },
  async verifiedRules() {
    return true;
  },
  async listing() {
    return { market: A(20), seller: A(21), active: true };
  },
  async creationPayment() {
    return 10n;
  },
};
describe("public site business intent boundary", () => {
  it("encodes exact bounded approval + purchase + approval removal atomically", async () => {
    const calls = await buildBusinessCalls(
      env,
      A(10),
      {
        kind: "buy",
        market: A(20),
        outcomeId: "1",
        units: "100",
        minUnits: "80",
        maxPayment: "100",
        deadline: "1200",
      },
      reader,
      1000n,
    );
    expect(calls).toHaveLength(4);
    expect(
      decodeFunctionData({ abi: erc20Abi, data: calls[1]!.data }),
    ).toMatchObject({ functionName: "approve", args: [A(20), 100n] });
    expect(
      decodeFunctionData({ abi: marketVaultAbi, data: calls[2]!.data }),
    ).toMatchObject({
      functionName: "buy",
      args: [1n, 100n, 80n, 100n, 1200n],
    });
    expect(
      decodeFunctionData({ abi: erc20Abi, data: calls[3]!.data }),
    ).toMatchObject({ functionName: "approve", args: [A(20), 0n] });
    expect(calls.every((c) => c.value === "0")).toBe(true);
  });
  it("blocks unverifiable exposure and retains owned-asset exits", async () => {
    const unverified = {
      ...reader,
      async verifiedRules() {
        return false;
      },
    };
    await expect(
      buildBusinessCalls(
        env,
        A(10),
        {
          kind: "buy",
          market: A(20),
          outcomeId: "0",
          units: "1",
          minUnits: "1",
          maxPayment: "1",
          deadline: "1200",
        },
        unverified,
        1000n,
      ),
    ).rejects.toMatchObject({ code: "rules_unverified" });
    const calls = await buildBusinessCalls(
      { ...env, features: { ...env.features, newExposure: false } },
      A(10),
      { kind: "refund", market: A(20) },
      unverified,
      1000n,
    );
    expect(
      decodeFunctionData({ abi: marketVaultAbi, data: calls[0]!.data }),
    ).toMatchObject({ functionName: "refundFor", args: [A(10)] });
  });
  it("settles and withdraws a returnable creator bond in one operation", async () => {
    const calls = await buildBusinessCalls(
      env,
      A(10),
      { kind: "settle-bond-and-claim", market: A(20) },
      reader,
      1000n,
    );
    expect(calls).toHaveLength(2);
    expect(
      decodeFunctionData({ abi: bondEscrowAbi, data: calls[0]!.data }),
    ).toMatchObject({ functionName: "settleBond", args: [A(20)] });
    expect(
      decodeFunctionData({ abi: bondEscrowAbi, data: calls[1]!.data }),
    ).toMatchObject({ functionName: "claimFor", args: [A(10)] });
  });
  it("denies arbitrary methods, unrelated receivers and wrong listing control", async () => {
    expect(
      intentSchema.safeParse({ kind: "upgrade", to: A(10), data: "0x" })
        .success,
    ).toBe(false);
    expect(
      intentSchema.safeParse({ kind: "refund", market: A(20), owner: A(22) })
        .success,
    ).toBe(false);
    await expect(
      buildBusinessCalls(
        env,
        A(10),
        { kind: "cancel-listing", listingId: H(3) },
        reader,
        1000n,
      ),
    ).rejects.toMatchObject({ code: "listing_owner_mismatch" });
  });
  it("rejects environment/account derivation collisions and USDC minting", () => {
    expect(
      siteConfigSchema.safeParse({
        version: 1,
        defaultEnvironment: env.id,
        environments: [env, { ...env, id: "other" }],
      }).success,
    ).toBe(false);
    expect(environmentSchema.safeParse({ ...env, asset: "USDC" }).success).toBe(
      false,
    );
  });
});

it("binds per-market platform rates to signed creation calldata and keeps legacy calls intact", async () => {
  const base = {
    kind: "create-market",
    userSalt: H(70),
    maxPayment: "100",
    params: {
      rulesHash: H(71),
      metadataURI: "https://example.com/rules.json",
      resolutionSourceHash: H(72),
      resolutionSourceURI: "https://example.com/source",
      outcomeCount: 2,
      closeAt: "2000",
      eventStartsAt: "0",
      outcomeDeadlineAt: "3000",
      creatorTreasury: A(10),
      deploymentMode: 0,
      featureFlags: "0",
      creatorRakeBps: 500,
      creatorC2CFeeBps: 50,
      perUserPrimaryCap: "1000000",
      marketPrimaryCap: "20000000",
      minimumPrimaryUnits: "10000",
      minimumC2CUnits: "10000",
      creatorBond: "10000000",
    },
  };
  for (const platformFees of [
    undefined,
    { rakeShareBps: 1000, c2cFeeBps: 75 },
    { rakeShareBps: 0, c2cFeeBps: 0 },
  ]) {
    const intent = intentSchema.parse({
      ...base,
      ...(platformFees ? { platformFees } : {}),
    });
    const calls = await buildBusinessCalls(env, A(10), intent, reader, 1000n);
    const tx = calls.find(
      (c) => c.to.toLowerCase() === env.deployment.factory.toLowerCase(),
    )!;
    const decoded = decodeFunctionData({
      abi: marketFactoryAbi,
      data: tx.data,
    });
    expect(decoded.functionName).toBe(
      platformFees ? "createMarketWithPlatformFees" : "createMarket",
    );
    if (platformFees)
      expect(decoded.args?.slice(-2)).toEqual([
        platformFees.rakeShareBps,
        platformFees.c2cFeeBps,
      ]);
  }
});
