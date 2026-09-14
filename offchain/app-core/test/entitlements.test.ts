import { describe, it, expect } from "vitest";
import {
  discoverEntitlements,
  hydrateEntitlements,
  type MarketRights,
  type RightsReader,
} from "../src/entitlements.js";
import { computePnl } from "../src/pnl.js";
import { ledgerFactSchema, type LedgerFact } from "../src/ledger-contracts.js";
import { A, H } from "./fixtures.js";
const owner = A(11),
  market = A(101),
  fact = (
    n: number,
    kind: LedgerFact["kind"],
    patch: Partial<LedgerFact> = {},
  ): LedgerFact =>
    ledgerFactSchema.parse({
      id: `f${n}`,
      kind,
      blockNumber: String(n),
      blockHash: H(n),
      transactionHash: H(n),
      transactionIndex: 0,
      logIndex: 0,
      factIndex: 0,
      timestamp: String(n),
      market,
      owner,
      counterparty: null,
      outcomeId: "0",
      listingId: null,
      units: null,
      amount: null,
      extra: {},
      ...patch,
    });
const state: MarketRights = {
  state: 1,
  voidReason: 0,
  winningOutcome: 0n,
  balances: [0n, 0n],
  winnerPool: 90n,
  winningUnits: 60n,
  earlyPool: 5n,
  earlyScore: 30n,
  ownerEarlyScore: 30n,
  timeoutFunded: false,
  timeoutPool: 20n,
  timeoutTotalUnits: 10n,
  ownerTimeoutUnits: 10n,
};
const reader = (patch: Partial<MarketRights> = {}): RightsReader => ({
  async market() {
    return { ...state, ...patch };
  },
  async listing() {
    return { units: 20n, active: true, terminal: true };
  },
  async bond() {
    return {
      amount: 100n,
      settled: false,
      terminal: true,
      returnable: true,
    };
  },
  async credit() {
    return 70n;
  },
});
const candidates = (facts: LedgerFact[]) =>
  discoverEntitlements(
    owner,
    facts,
    computePnl(owner, facts, { coverageComplete: true }),
  );
describe("all beneficial entitlements", () => {
  it("finds early-bird rights for an original buyer whose current shares are zero", async () => {
    const facts = [
      fact(1, "primary-buy", {
        units: "100",
        amount: "100",
        extra: { score: "30" },
      }),
      fact(2, "share-transfer", { counterparty: A(12), units: "100" }),
    ];
    const result = await hydrateEntitlements(
      owner,
      candidates(facts),
      reader(),
    );
    expect(result.find((r) => r.kind === "early-bird")).toMatchObject({
      status: "claimable",
      amount: "5",
    });
    expect(result.some((r) => r.kind === "holding")).toBe(false);
  });
  it("omits early-bird rewards when the creator voids the market", async () => {
    const facts = [
      fact(1, "primary-buy", {
        units: "100",
        amount: "100",
        extra: { score: "30" },
      }),
    ];
    const result = await hydrateEntitlements(
      owner,
      candidates(facts),
      reader({ state: 2, voidReason: 1 }),
    );
    expect(result.some((r) => r.kind === "early-bird")).toBe(false);
  });
  it("retains escrow shares and separates a market bond settlement from aggregate withdrawals", async () => {
    const facts = [
      fact(1, "primary-buy", { units: "20", amount: "20" }),
      fact(2, "listing-created", { units: "20", listingId: H(10) }),
      fact(3, "bond-locked", { amount: "100" }),
      fact(4, "fee-accrued", { amount: "9" }),
    ];
    const result = await hydrateEntitlements(
      owner,
      candidates(facts),
      reader(),
    );
    expect(result.find((r) => r.kind === "escrow")).toMatchObject({
      units: "20",
      status: "claimable",
      reason: "return_terminal_listing",
    });
    expect(result.find((r) => r.kind === "bond")).toMatchObject({
      market,
      status: "claimable",
      reason: "settle_and_claim_bond",
    });
    expect(result.find((r) => r.kind === "fees")).toMatchObject({
      market: null,
      amount: "70",
    });
  });
  it("does not batch a slashed timeout bond with a creator withdrawal", async () => {
    const facts = [fact(1, "bond-locked", { amount: "100" })];
    const result = await hydrateEntitlements(
      owner,
      candidates(facts),
      reader(),
    );
    const slashedReader: RightsReader = {
      ...reader(),
      async bond() {
        return {
          amount: 100n,
          settled: false,
          terminal: true,
          returnable: false,
        };
      },
    };
    const slashed = await hydrateEntitlements(
      owner,
      candidates(facts),
      slashedReader,
    );
    expect(result.find((r) => r.kind === "bond")?.reason).toBe(
      "settle_and_claim_bond",
    );
    expect(slashed.find((r) => r.kind === "bond")).toMatchObject({
      amount: "0",
      status: "conditional",
      reason: "bond_slashed_pending_timeout_funding",
    });
    const funded = await hydrateEntitlements(owner, candidates(facts), {
      ...slashedReader,
      async bond(market, owner) {
        return { ...(await slashedReader.bond(market, owner)), settled: true };
      },
    });
    expect(funded.find((r) => r.kind === "bond")).toMatchObject({
      amount: "0",
      status: "claimed",
      reason: "bond_slashed_into_timeout_pool",
    });
    const indexed = candidates([
      ...facts,
      fact(2, "bond-timeout-funded", { owner: null, amount: "100" }),
    ]);
    expect(indexed.find((r) => r.kind === "bond")).toMatchObject({
      amount: "0",
      status: "claimed",
      reason: "bond_slashed_into_timeout_pool",
    });
  });
  it("does not call timeout compensation claimable before the separate funding stage", async () => {
    const facts = [
      fact(1, "refunded", {
        units: "10",
        amount: "10",
        extra: { timeoutEligibilityRecorded: true },
      }),
    ];
    const pending = await hydrateEntitlements(
      owner,
      candidates(facts),
      reader({ state: 2, voidReason: 3 }),
    );
    expect(pending.find((r) => r.kind === "timeout-bonus")).toMatchObject({
      status: "conditional",
      reason: "waiting_for_timeout_bond_funding",
    });
    const funded = await hydrateEntitlements(
      owner,
      candidates(facts),
      reader({ state: 2, voidReason: 3, timeoutFunded: true }),
    );
    expect(funded.find((r) => r.kind === "timeout-bonus")).toMatchObject({
      status: "claimable",
      amount: "20",
    });
  });
  it("shows timeout compensation alongside principal before refunding, then enables the same right", async () => {
    const purchase = fact(1, "primary-buy", { units: "10", amount: "10" });
    const discovered = candidates([purchase]);
    const before = await hydrateEntitlements(
      owner,
      discovered,
      reader({
        state: 2,
        voidReason: 3,
        balances: [10n, 0n],
        ownerTimeoutUnits: 0n,
        timeoutFunded: true,
        timeoutTotalUnits: 20n,
        timeoutPool: 10n,
      }),
    );
    expect(before.find((r) => r.kind === "refund")).toMatchObject({
      status: "claimable",
      amount: "10",
    });
    const bonus = before.find((r) => r.kind === "timeout-bonus");
    expect(bonus).toMatchObject({
      status: "conditional",
      units: "10",
      amount: "5",
      reason: "refund_before_timeout_compensation",
    });
    const after = await hydrateEntitlements(
      owner,
      candidates([
        purchase,
        fact(2, "refunded", {
          units: "10",
          amount: "10",
          extra: { timeoutEligibilityRecorded: true },
        }),
      ]),
      reader({
        state: 2,
        voidReason: 3,
        timeoutFunded: true,
        timeoutTotalUnits: 20n,
        timeoutPool: 10n,
      }),
    );
    expect(after.find((r) => r.kind === "timeout-bonus")).toMatchObject({
      id: bonus!.id,
      status: "claimable",
      units: "10",
      amount: "5",
      reason: null,
    });
    const pending = await hydrateEntitlements(
      owner,
      discovered,
      reader({
        state: 2,
        voidReason: 3,
        balances: [10n, 0n],
        ownerTimeoutUnits: 0n,
      }),
    );
    expect(pending.find((r) => r.kind === "timeout-bonus")).toMatchObject({
      status: "conditional",
      reason: "refund_and_funding_before_timeout_compensation",
    });
  });
  it.each([
    [0, 0],
    [1, 0],
    [2, 1],
    [2, 2],
  ])(
    "omits timeout compensation outside timeout voids (%s, %s)",
    async (state, voidReason) => {
      const result = await hydrateEntitlements(
        owner,
        candidates([fact(1, "primary-buy", { units: "10", amount: "10" })]),
        reader({
          state,
          voidReason,
          balances: [10n, 0n],
          ownerTimeoutUnits: 0n,
        }),
      );
      expect(result.some((r) => r.kind === "timeout-bonus")).toBe(false);
    },
  );
  it("only quotes registered units when an earlier refund is already claimable", async () => {
    const result = await hydrateEntitlements(
      owner,
      candidates([
        fact(1, "primary-buy", { units: "20", amount: "20" }),
        fact(2, "refunded", {
          units: "10",
          amount: "10",
          extra: { timeoutEligibilityRecorded: true },
        }),
      ]),
      reader({
        state: 2,
        voidReason: 3,
        balances: [10n, 0n],
        timeoutFunded: true,
        timeoutTotalUnits: 40n,
        timeoutPool: 20n,
      }),
    );
    expect(result.find((r) => r.kind === "timeout-bonus")).toMatchObject({
      status: "claimable",
      units: "10",
      amount: "5",
    });
  });
  it("retains completed timeout compensation after all shares are refunded", async () => {
    const result = await hydrateEntitlements(
      owner,
      candidates([
        fact(1, "primary-buy", { units: "10", amount: "10" }),
        fact(2, "refunded", {
          units: "10",
          amount: "10",
          extra: { timeoutEligibilityRecorded: true },
        }),
        fact(3, "timeout-claimed", { units: "10", amount: "5" }),
      ]),
      reader({
        state: 2,
        voidReason: 3,
        ownerTimeoutUnits: 0n,
        timeoutFunded: true,
      }),
    );
    expect(result.find((r) => r.kind === "timeout-bonus")).toMatchObject({
      status: "claimed",
      amount: "5",
    });
  });
  it("retains claimed records and marks unavailable on-chain reads unknown", async () => {
    const facts = [
      fact(1, "primary-buy", {
        units: "100",
        amount: "100",
        extra: { score: "30" },
      }),
      fact(2, "early-bird-claimed", { amount: "5" }),
    ];
    const broken = {
      ...reader(),
      async market(): Promise<MarketRights> {
        throw new Error("rpc unavailable");
      },
    };
    const result = await hydrateEntitlements(owner, candidates(facts), broken);
    expect(result.find((r) => r.kind === "early-bird")).toMatchObject({
      status: "claimed",
      amount: "5",
    });
    expect(result.find((r) => r.kind === "winner")).toMatchObject({
      status: "unknown",
      amount: null,
    });
  });
});
