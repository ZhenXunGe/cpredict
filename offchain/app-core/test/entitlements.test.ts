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
    return { amount: 100n, settled: false, terminal: true };
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
    });
    expect(result.find((r) => r.kind === "fees")).toMatchObject({
      market: null,
      amount: "70",
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
