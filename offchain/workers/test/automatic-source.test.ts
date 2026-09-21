import { describe, it, expect, vi } from "vitest";
import { decodeFunctionData, type PublicClient } from "viem";
import {
  LedgerAutomaticSource,
  automaticAbi,
} from "../src/automatic-source.js";
import type { PostgresAutomaticStore } from "../src/automatic-store.js";
import type { PostgresFinancialLedger } from "../../indexer/src/financial-store.js";
import { normalizeFinancialFacts } from "../../indexer/src/financial-facts.js";
import {
  block,
  purchase,
  raw,
  trader,
  vault,
} from "../../indexer/test/financial-fixtures.js";
import { A, H, env } from "../../app-core/test/fixtures.js";
function setup(state = 0, enabled = true, now = 2000n) {
  const facts = normalizeFinancialFacts(
    [
      ...purchase(),
      raw(
        "FeeAccrued",
        env.deployment.feeVault,
        {
          beneficiary: trader,
          amount: 1n,
          source: vault,
          feeKind: H(3),
          feeReference: H(4),
        },
        2,
        8,
      ),
    ],
    [block(2)],
    {
      environment: env,
      markets: new Set([vault.toLowerCase()]),
      listings: new Map(),
      trackedAccounts: new Set([trader.toLowerCase()]),
    },
  );
  const ledger = {
    environment: env,
    snapshot: async () => ({
      complete: true,
      blockNumber: "100",
      blockHash: H(100),
    }),
    assertSnapshot: vi.fn(async () => {}),
    accountFacts: async () => facts,
    sql: async (s: TemplateStringsArray) =>
      s.join("").includes("SELECT DISTINCT market")
        ? [{ market: vault }]
        : [{ owner: trader }],
  } as unknown as PostgresFinancialLedger;
  const values: Record<string, unknown> = {
    marketState: state,
    voidReason: state === 2 ? 3 : 0,
    winningOutcome: 0,
    outcomeCount: 2,
    remainingWinnerPool: 80n,
    remainingWinningUnits: 100n,
    remainingEarlyBirdPool: 20n,
    remainingEarlyBirdScore: 300n,
    earlyBirdScore: 300n,
    timeoutBonusFunded: true,
    remainingTimeoutBonusPool: 100n,
    remainingTimeoutBonusUnits: 100n,
    timeoutBonusUnits: state === 2 ? 100n : 0n,
    bondOf: [A(91), 10n, true],
    resolutionDeadline: 2000n,
    creditOf: 1n,
  };
  const client = {
    getBlock: vi.fn(async () => ({
      number: 100n,
      hash: H(100),
      timestamp: now,
    })),
    readContract: vi.fn(
      async ({
        functionName,
        args,
      }: {
        functionName: string;
        args?: unknown[];
      }) =>
        functionName === "balanceOf"
          ? args?.[1] === 0n
            ? 100n
            : 0n
          : values[functionName],
    ),
  } as unknown as PublicClient;
  const prefs = {
    enabled: vi.fn(async () => enabled),
  } as unknown as PostgresAutomaticStore;
  const source = new LedgerAutomaticSource(ledger, client, prefs);
  return {
    source,
    client,
    ledger,
    values,
    async actions() {
      const r = [];
      for await (const a of source.candidates()) r.push(a);
      return r;
    },
  };
}
describe("historical automatic entitlement discovery", () => {
  it("discovers an unregistered historical holder and checks exact timeout boundary", async () => {
    expect(
      (await setup(0, true, 1999n).actions()).some(
        (a) => a.kind === "void-timeout",
      ),
    ).toBe(false);
    const f = setup(0, true, 2000n);
    const actions = await f.actions();
    expect(actions.some((a) => a.kind === "void-timeout")).toBe(true);
    const timeout = actions.find((a) => a.kind === "void-timeout")!;
    expect(await f.source.stillEligible(timeout)).toBe(true);
    vi.mocked(f.client.readContract).mockImplementation(
      async ({ functionName }) =>
        functionName === "balanceOf" ? 0n : f.values[functionName],
    );
    f.values.earlyBirdScore = 0n;
    f.values.timeoutBonusUnits = 0n;
    expect(await f.source.stillEligible(timeout)).toBe(false);
    expect(await setup(0, false).actions()).toEqual([]);
  });
  it("resolves winner, early bird and recurrent fees directly for their owner", async () => {
    const f = setup(1);
    const actions = await f.actions();
    expect(actions.map((a) => a.kind)).toEqual(
      expect.arrayContaining(["winner", "early-bird", "fees"]),
    );
    for (const a of actions)
      expect(
        decodeFunctionData({ abi: automaticAbi, data: a.data }).args,
      ).toEqual([trader]);
    f.values.creditOf = 2n;
    expect((await f.actions()).some((a) => a.kind === "fees")).toBe(true);
  });
  it("voided markets discover principal refunds and funded timeout compensation", async () => {
    expect((await setup(2).actions()).map((a) => a.kind)).toEqual(
      expect.arrayContaining(["refund", "timeout-bonus", "fees"]),
    );
  });
  it("stale index or canonical hash mismatch stops discovery before any send", async () => {
    const f = setup();
    vi.mocked(f.client.getBlock).mockResolvedValue({
      number: 300n,
      hash: H(100),
      timestamp: 2000n,
    } as never);
    await expect(f.actions()).rejects.toThrow("index_lag");
    const g = setup();
    vi.mocked(g.client.getBlock).mockResolvedValue({
      number: 100n,
      hash: H(101),
      timestamp: 2000n,
    } as never);
    await expect(g.actions()).rejects.toThrow("reorg");
  });
});
