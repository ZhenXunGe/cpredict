import { describe, it, expect } from "vitest";
import { scoreLeaderboard } from "../src/leaderboard.js";
import { leaderboardPeriodSchema } from "../src/report-contracts.js";
import { ledgerFactSchema, type LedgerFact } from "../src/ledger-contracts.js";
import { A, H, appAccount } from "./fixtures.js";
const period = leaderboardPeriodSchema.parse({
    id: "first",
    startsAt: "100",
    endsAt: "200",
    publishedAt: "50",
    markets: [{ market: A(101), startsAt: "100" }],
  }),
  accounts = [
    appAccount,
    {
      ...appAccount,
      id: "10000000-0000-4000-8000-000000000002",
      controller: A(20),
      address: A(21),
    },
    {
      ...appAccount,
      id: "10000000-0000-4000-8000-000000000003",
      controller: A(30),
      address: A(31),
    },
  ];
function fact(
  n: number,
  kind: LedgerFact["kind"],
  patch: Partial<LedgerFact> = {},
): LedgerFact {
  return ledgerFactSchema.parse({
    id: `fact-${n}`,
    kind,
    blockNumber: String(n),
    blockHash: H(n),
    transactionHash: H(n),
    transactionIndex: 0,
    logIndex: 0,
    factIndex: 0,
    timestamp: "150",
    market: A(101),
    owner: appAccount.address,
    counterparty: null,
    outcomeId: "0",
    listingId: null,
    units: null,
    amount: null,
    extra: {},
    ...patch,
  });
}
const complete = new Set(accounts.map((a) => a.address.toLowerCase())),
  creators = new Map([[A(101).toLowerCase(), A(90)]]);
describe("curated realized test leaderboard", () => {
  it("loads pre-period acquisition cost, excludes unrealized holdings and the half-open end boundary", () => {
    const result = scoreLeaderboard(
      period,
      accounts,
      [
        fact(1, "primary-buy", {
          units: "100",
          amount: "100",
          timestamp: "80",
        }),
        fact(2, "refunded", {
          units: "100",
          amount: "120",
          extra: { consumed: [{ outcomeId: "0", units: "100" }] },
        }),
        fact(3, "early-bird-claimed", { amount: "999", timestamp: "200" }),
      ],
      creators,
      complete,
    );
    expect(result.entries[0]).toMatchObject({ realizedNet: "20", rank: 1 });
  });
  it("uses tied competition ranks and address ordering, and excludes unknown acquisition cost", () => {
    const result = scoreLeaderboard(
      period,
      accounts,
      [
        fact(1, "early-bird-claimed", { amount: "5" }),
        fact(2, "early-bird-claimed", { owner: A(21), amount: "5" }),
        fact(3, "share-transfer", {
          owner: A(99),
          counterparty: A(31),
          units: "10",
        }),
        fact(4, "winner-claimed", {
          owner: A(31),
          units: "10",
          amount: "99",
          extra: { consumed: [{ outcomeId: "0", units: "10" }] },
        }),
      ],
      creators,
      complete,
    );
    expect(result.entries.map((e) => [e.account, e.rank])).toEqual([
      [A(11), 1],
      [A(21), 1],
    ]);
    expect(result.excluded[0]?.account).toBe(A(31));
  });
  it("excludes creator-controlled accounts from their own market and ignores non-roster markets", () => {
    const matching = [
      accounts[0]!,
      { ...accounts[1]!, controller: accounts[0]!.controller },
    ];
    const result = scoreLeaderboard(
      period,
      matching,
      [
        fact(1, "early-bird-claimed", { amount: "5" }),
        fact(2, "early-bird-claimed", { owner: A(21), amount: "9" }),
        fact(3, "early-bird-claimed", {
          owner: A(21),
          market: A(102),
          amount: "999",
        }),
      ],
      new Map([[A(101).toLowerCase(), A(11)]]),
      complete,
    );
    expect(result.entries).toEqual([]);
  });
  it("rejects late roster publication and duplicate markets, and excludes incomplete coverage", () => {
    expect(
      leaderboardPeriodSchema.safeParse({ ...period, publishedAt: "101" })
        .success,
    ).toBe(false);
    expect(
      leaderboardPeriodSchema.safeParse({
        ...period,
        markets: [...period.markets, ...period.markets],
      }).success,
    ).toBe(false);
    const result = scoreLeaderboard(
      period,
      accounts,
      [fact(1, "early-bird-claimed", { amount: "5" })],
      creators,
      new Set(),
    );
    expect(result.entries).toEqual([]);
    expect(result.excluded[0]?.reasons).toContain(
      "history_coverage_incomplete",
    );
  });
});
