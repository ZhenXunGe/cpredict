import { keccak256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import { ledgerFactSchema, type LedgerFact } from "../src/ledger-contracts.js";
import { computePnl } from "../src/pnl.js";
import { A, H } from "./fixtures.js";
const owner = A(11),
  market = A(101),
  other = A(12);
const fact = (
  n: number,
  kind: LedgerFact["kind"],
  patch: Partial<LedgerFact> = {},
): LedgerFact =>
  ledgerFactSchema.parse({
    id: `fact-${n}`,
    kind,
    blockNumber: String(n),
    blockHash: H(n),
    transactionHash: H(n),
    transactionIndex: 0,
    logIndex: 0,
    factIndex: 0,
    timestamp: String(n * 100),
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
const buy = fact(1, "primary-buy", { units: "100", amount: "100" });
const list = fact(2, "listing-created", { units: "40", listingId: H(40) });
const sale = fact(3, "listing-filled", {
  owner: other,
  counterparty: owner,
  units: "40",
  amount: "50",
  extra: { sellerProceeds: "48", platformFee: "1", creatorFee: "1" },
});
const run = (facts: LedgerFact[]) =>
  computePnl(owner, facts, { coverageComplete: true });
describe("integer moving weighted-average ledger", () => {
  it("uses seller net once and preserves the unsold cost; winner and early-bird total 43", () => {
    const partial = run([buy, list, sale]);
    expect(partial.realizedNet).toBe("8");
    expect(partial.lots[0]).toMatchObject({
      units: "60",
      escrowUnits: "0",
      knownCost: "60",
    });
    const result = run([
      buy,
      list,
      sale,
      fact(4, "market-resolved", { owner: null }),
      fact(5, "winner-claimed", { units: "60", amount: "90" }),
      fact(6, "early-bird-claimed", { amount: "5" }),
    ]);
    expect(result.entries.map((e) => e.amount)).toEqual(["8", "30", "5"]);
    expect(result.realizedNet).toBe("43");
    expect(result.lots).toEqual([]);
  });
  it("keeps cost in escrow, returns it on cancellation and realizes losing loss once", () => {
    const terminal = fact(3, "market-resolved", {
      owner: null,
      outcomeId: "1",
    });
    expect(run([buy, list]).lots[0]).toMatchObject({
      units: "100",
      escrowUnits: "40",
      knownCost: "100",
    });
    const after = run([
      buy,
      list,
      terminal,
      fact(4, "listing-returned", { units: "40" }),
      fact(5, "losing-burned", { units: "100" }),
    ]);
    expect(after.realizedNet).toBe("-100");
    expect(after.entries).toHaveLength(1);
  });
  it("profits from a discounted secondary purchase followed by principal refund", () => {
    const result = run([
      fact(1, "listing-filled", {
        counterparty: other,
        units: "100",
        amount: "70",
        extra: { sellerProceeds: "68" },
      }),
      fact(2, "market-voided", { owner: null }),
      fact(3, "refunded", { units: "100", amount: "100" }),
    ]);
    expect(result.realizedNet).toBe("30");
  });
  it("never treats an unknown-cost transfer in as free profit or complete ranking data", () => {
    const result = run([
      fact(1, "share-transfer", {
        owner: other,
        counterparty: owner,
        units: "100",
      }),
      fact(2, "winner-claimed", { units: "100", amount: "150" }),
    ]);
    expect(result.realizedNet).toBeNull();
    expect(result.knownRealizedNet).toBe("0");
    expect(result.entries[0]).toMatchObject({
      amount: null,
      proceeds: "150",
      complete: false,
    });
  });
  it("does not turn transfer-out, minting, deposits, creator fees, bonds or sponsored gas into trader PnL", () => {
    const result = run([
      buy,
      fact(2, "share-transfer", { counterparty: other, units: "40" }),
      fact(3, "payment-transfer", {
        owner: null,
        counterparty: owner,
        amount: "1000",
      }),
      fact(4, "fee-accrued", {
        amount: "50",
        extra: { feeKind: keccak256(stringToHex("CREATOR_RAKE")) },
      }),
      fact(5, "fee-claimed", { market: null, amount: "50" }),
      fact(6, "bond-locked", { amount: "100" }),
      fact(7, "bond-credited", { amount: "100" }),
      fact(8, "bond-claimed", { market: null, amount: "100" }),
      fact(9, "user-operation", { market: null, amount: "900" }),
    ]);
    expect(result).toMatchObject({
      realizedNet: "0",
      creatorIncome: "50",
      creatorClaimed: "50",
      bondLocked: "0",
      bondCredited: "100",
      bondClaimed: "100",
      gasCost: "900",
    });
    expect(result.lots[0]?.knownCost).toBe("60");
  });
  it("carries integer remainder to final disposal and excludes events at the period end", () => {
    const records = [
      fact(1, "primary-buy", { units: "3", amount: "10" }),
      fact(2, "listing-created", { units: "3" }),
      fact(3, "listing-filled", {
        owner: other,
        counterparty: owner,
        units: "1",
        amount: "5",
        extra: { sellerProceeds: "5" },
      }),
      fact(4, "listing-filled", {
        owner: other,
        counterparty: owner,
        units: "2",
        amount: "10",
        extra: { sellerProceeds: "10" },
      }),
    ];
    expect(run(records).entries.map((e) => e.allocatedCost)).toEqual([
      "3",
      "7",
    ]);
    expect(
      computePnl(owner, records, {
        coverageComplete: true,
        from: 300n,
        to: 400n,
      }).realizedNet,
    ).toBe("2");
  });
  it("is order-stable and idempotent and reports missing burn history", () => {
    expect(run([sale, list, buy, buy, sale])).toEqual(run([buy, list, sale]));
    expect(
      run([
        fact(2, "refunded", { units: "100", amount: "100", outcomeId: null }),
      ]).complete,
    ).toBe(false);
  });
  it("accounts a self-fill as its fees without disposing beneficial cost", () => {
    const result = run([buy, list, { ...sale, owner }]);
    expect(result.realizedNet).toBe("-2");
    expect(result.lots[0]).toMatchObject({
      units: "100",
      knownCost: "100",
      escrowUnits: "0",
    });
  });
});
