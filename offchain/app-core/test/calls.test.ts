import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import { buildBusinessCalls, type AdmissionReader } from "../src/calls.js";
import {
  environmentSchema,
  intentSchema,
  siteConfigSchema,
} from "../src/contracts.js";
import { marketVaultAbi } from "../../sdk/src/abis.js";
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
