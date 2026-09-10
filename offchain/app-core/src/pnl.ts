import { getAddress, type Address } from "viem";
import { sameAddress } from "./contracts.js";
import { pnlSchema, type LedgerFact, type Pnl } from "./ledger-contracts.js";
import { feeCategory } from "./fees.js";

type Lot = {
  market: Address;
  outcomeId: string;
  units: bigint;
  escrow: bigint;
  cost: bigint;
  complete: boolean;
  lossSettled: boolean;
};
type Disposal = { cost: bigint; complete: boolean; reason: string | null };
export interface PnlOptions {
  coverageComplete: boolean;
  from?: bigint;
  to?: bigint;
  markets?: ReadonlySet<string>;
}
const owns = (a: string | null, b: Address) => a !== null && sameAddress(a, b);
const integer = (value: unknown): bigint | null =>
  typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
export function financialOrder(a: LedgerFact, b: LedgerFact): number {
  const blockA = BigInt(a.blockNumber),
    blockB = BigInt(b.blockNumber);
  return blockA < blockB
    ? -1
    : blockA > blockB
      ? 1
      : a.transactionIndex - b.transactionIndex ||
        a.logIndex - b.logIndex ||
        a.factIndex - b.factIndex;
}

/** The same integer reducer serves live reads, historical replay and leaderboard snapshots. */
export function computePnl(
  address: Address,
  input: readonly LedgerFact[],
  options: PnlOptions,
): Pnl {
  const owner = getAddress(address),
    lots = new Map<string, Lot>(),
    seen = new Set<string>(),
    reasons = new Set<string>();
  const bonds = new Map<string, { amount: bigint; settled: boolean }>();
  const resolved = new Map<string, string>();
  const entries: Pnl["entries"] = [];
  let creatorIncome = 0n,
    creatorClaimed = 0n,
    bondLocked = 0n,
    bondCredited = 0n,
    bondClaimed = 0n,
    bondSlashed = 0n,
    paymentIn = 0n,
    paymentOut = 0n,
    gasCost = 0n;
  if (!options.coverageComplete) reasons.add("history_coverage_incomplete");
  const included = (f: LedgerFact) =>
    (options.from === undefined || BigInt(f.timestamp) >= options.from) &&
    (options.to === undefined || BigInt(f.timestamp) < options.to) &&
    (options.markets === undefined ||
      (f.market !== null && options.markets.has(f.market.toLowerCase())));
  const relevantMarket = (f: LedgerFact) =>
    options.markets === undefined ||
    (f.market !== null && options.markets.has(f.market.toLowerCase()));
  const getLot = (market: Address, outcomeId: string): Lot => {
    const key = `${market.toLowerCase()}:${outcomeId}`;
    let lot = lots.get(key);
    if (!lot) {
      lot = {
        market,
        outcomeId,
        units: 0n,
        escrow: 0n,
        cost: 0n,
        complete: true,
        lossSettled: false,
      };
      lots.set(key, lot);
    }
    return lot;
  };
  const missing = (f: LedgerFact, reason: string) => {
    if (relevantMarket(f)) reasons.add(`${reason}:${f.market ?? "account"}`);
  };
  const record = (
    f: LedgerFact,
    proceeds: bigint,
    disposal: Disposal,
    outcomeId = f.outcomeId,
  ) => {
    if (!f.market || !included(f)) return;
    if (!disposal.complete) missing(f, disposal.reason ?? "unknown_cost");
    entries.push({
      factId: f.id,
      market: f.market,
      outcomeId,
      kind: f.kind,
      timestamp: f.timestamp,
      amount: disposal.complete ? (proceeds - disposal.cost).toString() : null,
      proceeds: proceeds.toString(),
      allocatedCost: disposal.cost.toString(),
      complete: disposal.complete,
      reason: disposal.reason,
    });
  };
  const dispose = (
    f: LedgerFact,
    lot: Lot,
    units: bigint,
    escrow = false,
  ): Disposal => {
    const sufficient =
      units <= lot.units &&
      units <= (escrow ? lot.escrow : lot.units - lot.escrow);
    const available = units < lot.units ? units : lot.units;
    const cost =
      lot.units === 0n
        ? 0n
        : available === lot.units
          ? lot.cost
          : (lot.cost * available) / lot.units;
    const complete = sufficient && lot.complete;
    lot.units -= available;
    lot.cost -= cost;
    if (escrow)
      lot.escrow = lot.escrow > available ? lot.escrow - available : 0n;
    if (lot.escrow > lot.units) lot.escrow = lot.units;
    if (!sufficient) missing(f, "share_balance_gap");
    if (lot.units === 0n) {
      lot.complete = true;
      lot.lossSettled = false;
    }
    return {
      cost,
      complete,
      reason: complete
        ? null
        : sufficient
          ? "unknown_acquisition_cost"
          : "share_balance_gap",
    };
  };
  const acquire = (
    f: LedgerFact,
    lot: Lot,
    units: bigint,
    cost: bigint | null,
  ) => {
    lot.units += units;
    lot.cost += cost ?? 0n;
    lot.complete &&= cost !== null;
    lot.lossSettled = false;
    const winner = resolved.get(lot.market.toLowerCase());
    if (winner !== undefined && winner !== lot.outcomeId) {
      record(
        f,
        0n,
        {
          cost: lot.cost,
          complete: lot.complete,
          reason: lot.complete ? null : "unknown_acquisition_cost",
        },
        lot.outcomeId,
      );
      lot.cost = 0n;
      lot.lossSettled = true;
    }
  };
  for (const f of [...input].sort(financialOrder)) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    if (options.to !== undefined && BigInt(f.timestamp) >= options.to) continue;
    const mine = owns(f.owner, owner),
      other = owns(f.counterparty, owner),
      value = BigInt(f.amount ?? "0"),
      units = BigInt(f.units ?? "0");
    const lot =
      f.market !== null && f.outcomeId !== null
        ? getLot(f.market, f.outcomeId)
        : null;
    if (f.kind === "coverage-gap" && (mine || other))
      missing(
        f,
        typeof f.extra.reason === "string" ? f.extra.reason : "event_gap",
      );
    if (f.kind === "primary-buy" && mine && lot) acquire(f, lot, units, value);
    if (f.kind === "listing-created" && mine && lot) {
      lot.escrow += units;
      if (lot.escrow > lot.units) {
        lot.complete = false;
        missing(f, "escrow_balance_gap");
      }
    }
    if (
      (f.kind === "listing-cancelled" || f.kind === "listing-returned") &&
      mine &&
      lot
    ) {
      if (lot.escrow < units) {
        lot.complete = false;
        missing(f, "escrow_balance_gap");
      }
      lot.escrow = lot.escrow >= units ? lot.escrow - units : 0n;
    }
    if (f.kind === "listing-filled" && lot) {
      const proceeds = integer(f.extra.sellerProceeds);
      if (mine && other) {
        // No beneficial ownership change in a self-fill. Only the actual fees leave the account.
        if (lot.escrow < units) missing(f, "escrow_balance_gap");
        lot.escrow = lot.escrow >= units ? lot.escrow - units : 0n;
        record(f, proceeds ?? 0n, {
          cost: value,
          complete: proceeds !== null,
          reason: proceeds === null ? "seller_net_missing" : null,
        });
      } else {
        if (other) {
          const d = dispose(f, lot, units, true);
          record(f, proceeds ?? 0n, {
            ...d,
            complete: d.complete && proceeds !== null,
            reason: proceeds === null ? "seller_net_missing" : d.reason,
          });
        }
        if (mine) acquire(f, lot, units, value);
      }
    }
    if (f.kind === "share-transfer" && lot && !(mine && other)) {
      if (mine) dispose(f, lot, units); // Transfer of cost basis is not a trading loss.
      if (other) acquire(f, lot, units, null);
    }
    if (f.kind === "market-resolved" && f.market && f.outcomeId !== null) {
      resolved.set(f.market.toLowerCase(), f.outcomeId);
      for (const holding of lots.values())
        if (
          sameAddress(holding.market, f.market) &&
          holding.outcomeId !== f.outcomeId &&
          holding.units > 0n &&
          !holding.lossSettled
        ) {
          record(
            f,
            0n,
            {
              cost: holding.cost,
              complete: holding.complete,
              reason: holding.complete ? null : "unknown_acquisition_cost",
            },
            holding.outcomeId,
          );
          holding.cost = 0n;
          holding.lossSettled = true;
        }
    }
    if (
      (f.kind === "winner-claimed" ||
        f.kind === "refunded" ||
        f.kind === "losing-burned") &&
      mine &&
      f.market
    ) {
      const consumed = Array.isArray(f.extra.consumed)
        ? f.extra.consumed
        : f.outcomeId !== null
          ? [{ outcomeId: f.outcomeId, units: f.units }]
          : [];
      let cost = 0n,
        burned = 0n,
        complete = true,
        reason: string | null = null;
      for (const part of consumed) {
        if (typeof part !== "object" || part === null || Array.isArray(part)) {
          complete = false;
          continue;
        }
        const outcome = integer(part.outcomeId),
          quantity = integer(part.units);
        if (outcome === null || quantity === null) {
          complete = false;
          continue;
        }
        const d = dispose(f, getLot(f.market, outcome.toString()), quantity);
        burned += quantity;
        cost += d.cost;
        complete &&= d.complete;
        reason ??= d.reason;
      }
      if (burned !== units) {
        complete = false;
        reason = "burn_movement_missing";
      }
      // Terminal loss is already realized. A later housekeeping burn cannot charge it again.
      if (f.kind !== "losing-burned")
        record(f, value, { cost, complete, reason });
      else if (cost > 0n || !complete)
        missing(f, "terminal_loss_history_missing");
    }
    if (
      (f.kind === "early-bird-claimed" || f.kind === "timeout-claimed") &&
      mine
    )
      record(f, value, { cost: 0n, complete: true, reason: null });
    if (mine && f.kind === "bond-locked" && f.market) {
      bonds.set(f.market.toLowerCase(), { amount: value, settled: false });
      bondLocked += value;
    }
    if (f.kind === "bond-credited" && mine && f.market) {
      const bond = bonds.get(f.market.toLowerCase());
      if (!bond?.settled) {
        bondCredited += value;
        if (bond) {
          bond.settled = true;
          bondLocked -= bond.amount;
        }
      }
    }
    if (f.kind === "bond-timeout-funded" && f.market) {
      const bond = bonds.get(f.market.toLowerCase());
      if (bond && !bond.settled) {
        bond.settled = true;
        bondLocked -= bond.amount;
        bondSlashed += value;
      }
    }
    if (mine && f.kind === "bond-claimed") bondClaimed += value;
    if (
      mine &&
      f.kind === "fee-accrued" &&
      included(f) &&
      feeCategory(f.extra.feeKind) === "creator"
    )
      creatorIncome += value;
    if (mine && f.kind === "fee-claimed" && included(f))
      creatorClaimed += value;
    if (f.kind === "payment-transfer" && included(f)) {
      if (mine && !other) paymentOut += value;
      if (other && !mine) paymentIn += value;
    }
    if (mine && f.kind === "user-operation" && included(f)) gasCost += value;
  }
  const selectedLots = [...lots.values()].filter(
    (l) =>
      options.markets === undefined ||
      options.markets.has(l.market.toLowerCase()),
  );
  for (const lot of selectedLots)
    if (lot.units > 0n && !lot.complete)
      reasons.add(`unknown_acquisition_cost:${lot.market}`);
  const knownRealizedNet = entries
      .reduce((total, e) => total + BigInt(e.amount ?? "0"), 0n)
      .toString(),
    complete = reasons.size === 0;
  return pnlSchema.parse({
    owner,
    realizedNet: complete ? knownRealizedNet : null,
    knownRealizedNet,
    complete,
    missingReasons: [...reasons].sort(),
    lots: selectedLots
      .filter((l) => l.units > 0n)
      .map((l) => ({
        market: l.market,
        outcomeId: l.outcomeId,
        units: l.units.toString(),
        escrowUnits: l.escrow.toString(),
        knownCost: l.cost.toString(),
        costComplete: l.complete,
      })),
    entries,
    creatorIncome: creatorIncome.toString(),
    creatorClaimed: creatorClaimed.toString(),
    bondLocked: bondLocked.toString(),
    bondCredited: bondCredited.toString(),
    bondClaimed: bondClaimed.toString(),
    bondSlashed: bondSlashed.toString(),
    paymentIn: paymentIn.toString(),
    paymentOut: paymentOut.toString(),
    gasCost: gasCost.toString(),
  });
}
