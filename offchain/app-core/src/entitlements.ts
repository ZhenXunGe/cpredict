import { type Address } from "viem";
import { sameAddress } from "./contracts.js";
import {
  type Entitlement,
  type LedgerFact,
  type Pnl,
} from "./ledger-contracts.js";
import { financialOrder } from "./pnl.js";

/** Candidate discovery includes original buyers and beneficiaries even after their share balance becomes zero. */
export function discoverEntitlements(
  owner: Address,
  facts: readonly LedgerFact[],
  pnl: Pnl,
): Entitlement[] {
  const items = new Map<string, Entitlement>();
  const mine = (a: string | null) => a !== null && sameAddress(a, owner);
  const candidate = (
    market: Address | null,
    kind: Entitlement["kind"],
    patch: Partial<Entitlement> = {},
  ) => {
    const id = `${market?.toLowerCase() ?? "aggregate"}:${kind}:${patch.listingId ?? patch.outcomeId ?? "all"}`;
    const old = items.get(id);
    const item: Entitlement = {
      id,
      market,
      kind,
      outcomeId: null,
      listingId: null,
      units: null,
      amount: null,
      status: "unknown",
      reason: "chain_state_pending",
      ...old,
      ...patch,
    };
    items.set(id, item);
    return item;
  };
  const seen = new Set<string>();
  for (const f of [...facts].sort(financialOrder)) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    if (f.market && mine(f.owner)) {
      if (
        f.kind === "primary-buy" &&
        BigInt(typeof f.extra.score === "string" ? f.extra.score : "0") > 0n
      )
        candidate(f.market, "early-bird");
      if (f.kind === "listing-created" && f.listingId)
        candidate(f.market, "escrow", {
          outcomeId: f.outcomeId,
          listingId: f.listingId,
          units: f.units,
        });
      if (
        (f.kind === "listing-cancelled" || f.kind === "listing-returned") &&
        f.listingId
      )
        candidate(f.market, "escrow", {
          outcomeId: f.outcomeId,
          listingId: f.listingId,
          units: "0",
          status: "claimed",
          reason: null,
        });
      if (f.kind === "bond-locked")
        candidate(f.market, "bond", { amount: f.amount });
      if (f.kind === "bond-credited") {
        candidate(f.market, "bond", {
          amount: f.amount,
          status: "claimed",
          reason: "credited_to_aggregate_balance",
        });
        candidate(null, "bond");
      }
      if (f.kind === "refunded" && f.extra.timeoutEligibilityRecorded === true)
        candidate(f.market, "timeout-bonus", {
          status: "unknown",
          reason: "chain_state_pending",
          amount: null,
        });
      const claimed: Partial<Record<LedgerFact["kind"], Entitlement["kind"]>> =
        {
          "winner-claimed": "winner",
          "early-bird-claimed": "early-bird",
          refunded: "refund",
          "timeout-claimed": "timeout-bonus",
        };
      if (claimed[f.kind])
        candidate(f.market, claimed[f.kind]!, {
          amount: f.amount,
          status: "claimed",
          reason: null,
        });
    }
    if (
      f.kind === "listing-filled" &&
      mine(f.counterparty) &&
      f.market &&
      f.listingId
    ) {
      const item = candidate(f.market, "escrow", {
        outcomeId: f.outcomeId,
        listingId: f.listingId,
      });
      item.units =
        typeof f.extra.remainingUnits === "string"
          ? f.extra.remainingUnits
          : null;
      if (item.units === "0") {
        item.status = "claimed";
        item.reason = null;
      }
    }
    if ((f.kind === "fee-accrued" || f.kind === "fee-claimed") && mine(f.owner))
      candidate(null, "fees");
    if (f.kind === "bond-claimed" && mine(f.owner)) candidate(null, "bond");
  }
  for (const lot of pnl.lots) {
    const held = BigInt(lot.units) - BigInt(lot.escrowUnits);
    if (held > 0n) {
      candidate(lot.market, "holding", {
        outcomeId: lot.outcomeId,
        units: held.toString(),
      });
      candidate(lot.market, "winner", {
        status: "unknown",
        reason: "chain_state_pending",
        amount: null,
      });
      candidate(lot.market, "refund", {
        status: "unknown",
        reason: "chain_state_pending",
        amount: null,
      });
    }
  }
  // A timeout-funded bond event omits creator, so resolve it through the preceding locked bond.
  for (const f of facts)
    if (f.kind === "bond-timeout-funded" && f.market) {
      const item = items.get(`${f.market.toLowerCase()}:bond:all`);
      if (item) {
        item.status = "claimed";
        item.reason = "bond_slashed_into_timeout_pool";
      }
    }
  return [...items.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface MarketRights {
  state: number;
  voidReason: number;
  winningOutcome: bigint;
  balances: readonly bigint[];
  winnerPool: bigint;
  winningUnits: bigint;
  earlyPool: bigint;
  earlyScore: bigint;
  ownerEarlyScore: bigint;
  timeoutFunded: boolean;
  timeoutPool: bigint;
  timeoutTotalUnits: bigint;
  ownerTimeoutUnits: bigint;
}
export interface RightsReader {
  market(market: Address, owner: Address): Promise<MarketRights>;
  listing(
    listingId: `0x${string}`,
    owner: Address,
  ): Promise<{ units: bigint; terminal: boolean; active: boolean }>;
  bond(
    market: Address,
    owner: Address,
  ): Promise<{ amount: bigint; settled: boolean; terminal: boolean }>;
  credit(kind: "fees" | "bond", owner: Address): Promise<bigint>;
}
const shareOfPool = (units: bigint, total: bigint, pool: bigint) =>
  total === 0n || units > total
    ? null
    : units === total
      ? pool
      : (pool * units) / total;
export async function hydrateEntitlements(
  owner: Address,
  candidates: readonly Entitlement[],
  reader: RightsReader,
): Promise<Entitlement[]> {
  const marketReads = new Map<string, Promise<MarketRights>>();
  const read = (a: Address) => {
    let promise = marketReads.get(a);
    if (!promise) {
      promise = reader.market(a, owner);
      marketReads.set(a, promise);
    }
    return promise;
  };
  // Bounded sequential claims avoid unbounded RPC fan-out for accounts with extensive history.
  const output: Entitlement[] = [];
  for (const candidate of candidates) {
    const e = { ...candidate };
    if (e.status === "claimed") {
      output.push(e);
      continue;
    }
    try {
      e.reason = null;
      if (e.market === null && (e.kind === "fees" || e.kind === "bond")) {
        const amount = await reader.credit(e.kind, owner);
        e.amount = amount.toString();
        e.status = amount > 0n ? "claimable" : "conditional";
      } else if (e.kind === "escrow" && e.listingId) {
        const listing = await reader.listing(e.listingId, owner);
        e.units = listing.units.toString();
        e.status = listing.units === 0n ? "claimed" : "claimable";
        e.reason = listing.terminal
          ? "return_terminal_listing"
          : "cancel_listing_to_recover_shares";
      } else if (e.kind === "bond" && e.market) {
        const bond = await reader.bond(e.market, owner);
        e.amount = bond.amount.toString();
        e.status = bond.settled
          ? "claimed"
          : bond.terminal
            ? "claimable"
            : "conditional";
        e.reason = bond.settled
          ? "settled_see_aggregate_credit_or_timeout_pool"
          : "settle_bond_before_claiming_credit";
      } else if (e.market) {
        const m = await read(e.market);
        let amount: bigint | null = null,
          eligible = false;
        if (e.kind === "holding") {
          e.units = (m.balances[Number(e.outcomeId)] ?? 0n).toString();
          e.status = "conditional";
          e.reason =
            m.state === 1 && BigInt(e.outcomeId ?? "0") !== m.winningOutcome
              ? "losing_outcome_terminal"
              : null;
        }
        if (e.kind === "winner") {
          const units = m.balances[Number(m.winningOutcome)] ?? 0n;
          e.units = units.toString();
          eligible = m.state === 1 && units > 0n;
          amount = eligible
            ? shareOfPool(units, m.winningUnits, m.winnerPool)
            : 0n;
        }
        if (e.kind === "refund") {
          const units = m.balances.reduce((a, b) => a + b, 0n);
          e.units = units.toString();
          eligible = m.state === 2 && units > 0n;
          amount = eligible ? units : 0n;
          e.reason =
            m.voidReason === 3
              ? "principal_first_then_timeout_compensation"
              : null;
        }
        if (e.kind === "early-bird") {
          eligible =
            m.state === 1 && m.ownerEarlyScore > 0n && m.earlyPool > 0n;
          amount = eligible
            ? shareOfPool(m.ownerEarlyScore, m.earlyScore, m.earlyPool)
            : 0n;
        }
        if (e.kind === "timeout-bonus") {
          eligible = m.timeoutFunded && m.ownerTimeoutUnits > 0n;
          amount = eligible
            ? shareOfPool(
                m.ownerTimeoutUnits,
                m.timeoutTotalUnits,
                m.timeoutPool,
              )
            : 0n;
          e.reason = m.timeoutFunded
            ? null
            : "waiting_for_timeout_bond_funding";
        }
        if (e.kind !== "holding") {
          e.amount = amount?.toString() ?? null;
          e.status =
            amount === null
              ? "unknown"
              : eligible
                ? "claimable"
                : "conditional";
        }
      }
    } catch {
      e.status = "unknown";
      e.reason = "chain_read_unavailable";
      e.amount = null;
    }
    output.push(e);
  }
  return output;
}
