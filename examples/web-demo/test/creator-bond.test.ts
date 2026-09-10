import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { toEventSelector, toFunctionSelector } from "viem";
import {
  bondDisposition,
  bondStorageKey,
  creatorBondAbi,
  parseBondSubmission,
  readBondReceipt,
  readCreatorBond,
  type CreatorBondIdentity,
} from "../src/creator-bond.js";
import { refreshConfirmedTransaction } from "../src/confirmed-transaction.js";
import { BOND_ESCROW, createBondFixture } from "./bond-fixtures.js";
import { UX_MARKET } from "./ux-fixtures.js";

const identity: CreatorBondIdentity = {
  chainId: 421614,
  market: UX_MARKET.address,
  creator: UX_MARKET.creator,
  escrow: BOND_ESCROW,
  wallet: UX_MARKET.creator,
};
const resolved = { ...UX_MARKET, marketState: 1, totalPrincipal: 2_000_000n };

describe("creator bond read projection", () => {
  it("uses only existing generated contract getters/events", async () => {
    const artifacts = await Promise.all(
      ["BondEscrowV1", "FullMarketVaultV1"].map(async (name) =>
        JSON.parse(await readFile(`generated/abi/${name}.json`, "utf8")),
      ),
    );
    const abi = artifacts.flatMap((artifact) =>
      Array.isArray(artifact) ? artifact : artifact.abi,
    );
    for (const entry of creatorBondAbi) {
      const found = abi.find(
        (item) => item.type === entry.type && item.name === entry.name,
      );
      expect(found, entry.name).toBeDefined();
      if (entry.type === "function")
        expect(toFunctionSelector(entry)).toBe(toFunctionSelector(found));
      else expect(toEventSelector(entry)).toBe(toEventSelector(found));
    }
  });

  it("pins every field to one block and preserves exact USDC units", async () => {
    const fixture = createBondFixture(resolved);
    fixture.state.credit = 12_345_678n;
    const multicall = vi.spyOn(fixture.rpc, "multicall");
    const snapshot = await readCreatorBond(fixture.rpc, identity);
    expect(snapshot).toMatchObject({
      amount: 5_000_000n,
      credit: 12_345_678n,
      blockNumber: 100n,
    });
    expect(multicall).toHaveBeenCalledWith(
      expect.objectContaining({ allowFailure: false, blockNumber: 100n }),
    );
  });

  it.each([
    [0, 0, 2_000_000n, false, "locked"],
    [1, 0, 2_000_000n, false, "return-pending"],
    [2, 1, 2_000_000n, false, "return-pending"],
    [2, 2, 2_000_000n, false, "return-pending"],
    [2, 3, 0n, false, "return-pending"],
    [2, 3, 2_000_000n, false, "timeout-pending"],
    [2, 3, 2_000_000n, true, "timeout-funded"],
    [1, 0, 2_000_000n, true, "credited"],
  ] as const)(
    "classifies state %s/reason %s/principal %s/settled %s",
    async (marketState, voidReason, totalPrincipal, settled, expected) => {
      const fixture = createBondFixture({
        ...resolved,
        marketState,
        voidReason,
        totalPrincipal,
        observedAt: resolved.resolutionDeadline + 100_000n,
      });
      fixture.state.settled = settled;
      expect(
        bondDisposition(await readCreatorBond(fixture.rpc, identity)),
      ).toBe(expected);
    },
  );

  it("rejects unknown/mismatched state instead of inventing a zero or an entitlement", async () => {
    const fixture = createBondFixture(resolved);
    fixture.state.readError = true;
    await expect(readCreatorBond(fixture.rpc, identity)).rejects.toThrow("RPC");
    fixture.state.readError = false;
    await expect(readCreatorBond(fixture.rpc, identity, 101n)).rejects.toThrow(
      "尚未同步",
    );
    await expect(
      readCreatorBond(fixture.rpc, { ...identity, chainId: 1 }),
    ).rejects.toThrow("网络");
    await expect(
      readCreatorBond(fixture.rpc, {
        ...identity,
        creator: UX_MARKET.creatorTreasury,
      }),
    ).rejects.toThrow("不匹配");
    fixture.state.market.voidReason = 3;
    await expect(readCreatorBond(fixture.rpc, identity)).rejects.toThrow();
  });
});

describe("creator bond receipts and recovery", () => {
  it("separates release credit from actual aggregate payment, using event amount not preview", async () => {
    const fixture = createBondFixture(resolved);
    fixture.state.credit = 3_000_000n;
    const release = await fixture.submit("release", identity.wallet);
    await expect(
      readBondReceipt(fixture.rpc, identity, {
        action: "release",
        hash: release.hash,
        afterBlock: "100",
      }),
    ).resolves.toMatchObject({ status: "released", amount: 5_000_000n });
    fixture.state.amountAddedBeforeClaim = 1n;
    const claim = await fixture.submit("claim", identity.wallet);
    const submission = {
      action: "claim",
      hash: claim.hash,
      afterBlock: "101",
    } as const;
    await expect(
      readBondReceipt(fixture.rpc, identity, submission),
    ).resolves.toMatchObject({ status: "claimed", amount: 8_000_001n });
    await expect(
      readBondReceipt(
        fixture.rpc,
        { ...identity, creator: UX_MARKET.creatorTreasury },
        submission,
      ),
    ).rejects.toThrow("尚未核对");
    await expect(
      readBondReceipt(
        fixture.rpc,
        { ...identity, wallet: UX_MARKET.creatorTreasury },
        submission,
      ),
    ).rejects.toThrow("发送者");
    await expect(
      readBondReceipt(
        fixture.rpc,
        { ...identity, escrow: UX_MARKET.address },
        submission,
      ),
    ).rejects.toThrow("目标");
    await expect(
      readBondReceipt(fixture.rpc, identity, {
        ...submission,
        afterBlock: "103",
      }),
    ).rejects.toThrow("早于");
  });

  it("does not treat missing receipts, missing events or a revert as payment", async () => {
    const fixture = createBondFixture(resolved);
    const result = await fixture.submit("release", identity.wallet);
    const submission = {
      action: "release",
      hash: result.hash,
      afterBlock: "100",
    } as const;
    fixture.state.receiptPending = true;
    await expect(
      readBondReceipt(fixture.rpc, identity, submission),
    ).rejects.toThrow();
    fixture.state.receiptPending = false;
    const receipt = fixture.receipts.get(result.hash)!;
    fixture.receipts.set(result.hash, { ...receipt, logs: [] });
    await expect(
      readBondReceipt(fixture.rpc, identity, submission),
    ).rejects.toThrow("尚未核对");
    fixture.receipts.set(result.hash, { ...receipt, status: "reverted" });
    await expect(
      readBondReceipt(fixture.rpc, identity, submission),
    ).resolves.toMatchObject({ status: "reverted" });
  });

  it("separates pending identities by account, chain, market, escrow and creator", () => {
    const key = bondStorageKey(identity);
    for (const field of ["market", "creator", "wallet", "escrow"] as const) {
      expect(
        bondStorageKey({
          ...identity,
          [field]: "0x000000000000000000000000000000000000ffff",
        }),
      ).not.toBe(key);
    }
    expect(bondStorageKey({ ...identity, chainId: 1 })).not.toBe(key);
    const pending = {
      action: "claim",
      hash: `0x${"12".repeat(32)}`,
      afterBlock: "100",
    };
    expect(parseBondSubmission(JSON.stringify(pending))).toEqual(pending);
    expect(
      parseBondSubmission(JSON.stringify({ ...pending, hash: null })),
    ).toEqual({ ...pending, hash: null });
    expect(parseBondSubmission(null)).toBeNull();
    expect(() => parseBondSubmission("{}")).toThrow();
    expect(() =>
      parseBondSubmission(
        JSON.stringify({ ...pending, afterBlock: "invalid" }),
      ),
    ).toThrow();
  });

  it("preserves the confirmed transaction when refresh fails", async () => {
    const result = {
      hash: `0x${"12".repeat(32)}` as const,
      gasUsed: 1n,
      blockNumber: 101n,
    };
    const refreshError = new Error("RPC refresh failed");
    const refresh = vi.fn(async () => {
      throw refreshError;
    });
    await expect(refreshConfirmedTransaction(result, refresh)).resolves.toEqual(
      { result, refreshError },
    );
    expect(refresh).toHaveBeenCalledOnce();
    await expect(
      refreshConfirmedTransaction(result, async () => {}),
    ).resolves.toEqual({ result, refreshError: null });
  });
});
