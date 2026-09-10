import type { Address } from "viem";
import { sameAddress, type AppAccount } from "./contracts.js";
import { computePnl } from "./pnl.js";
import type { LedgerFact } from "./ledger-contracts.js";
import type {
  LeaderboardPeriod,
  LeaderboardSnapshot,
} from "./report-contracts.js";

/** Cost history predates the score window; only realizations inside each declared market window count. */
export function scoreLeaderboard(
  period: LeaderboardPeriod,
  accounts: readonly AppAccount[],
  facts: readonly LedgerFact[],
  creators: ReadonlyMap<string, Address>,
  complete: ReadonlySet<string>,
): Pick<LeaderboardSnapshot, "entries" | "excluded"> {
  const values: {
      account: Address;
      realizedNet: string;
      marketCount: number;
    }[] = [],
    excluded: LeaderboardSnapshot["excluded"] = [];
  const controls = new Map(
    accounts.map((a) => [a.address.toLowerCase(), a.controller.toLowerCase()]),
  );
  for (const account of accounts) {
    const eligible = period.markets.filter((m) => {
      const creator = creators.get(m.market.toLowerCase());
      if (!creator) return false;
      const creatorControl =
        controls.get(creator.toLowerCase()) ?? creator.toLowerCase();
      return (
        !sameAddress(creator, account.address) &&
        creatorControl !== account.controller.toLowerCase() &&
        creatorControl !== account.address.toLowerCase()
      );
    });
    const participated = eligible.filter((m) =>
      facts.some(
        (f) =>
          [
            "primary-buy",
            "listing-filled",
            "share-transfer",
            "winner-claimed",
            "early-bird-claimed",
            "refunded",
            "timeout-claimed",
          ].includes(f.kind) &&
          BigInt(f.timestamp) < BigInt(period.endsAt) &&
          f.market &&
          sameAddress(f.market, m.market) &&
          ((f.owner && sameAddress(f.owner, account.address)) ||
            (f.counterparty && sameAddress(f.counterparty, account.address))),
      ),
    );
    if (!participated.length) continue;
    let total = 0n;
    const reasons = new Set<string>();
    for (const market of participated) {
      const pnl = computePnl(account.address, facts, {
        coverageComplete: complete.has(account.address.toLowerCase()),
        from: BigInt(market.startsAt),
        to: BigInt(period.endsAt),
        markets: new Set([market.market.toLowerCase()]),
      });
      if (!pnl.complete) pnl.missingReasons.forEach((r) => reasons.add(r));
      total += BigInt(pnl.knownRealizedNet);
    }
    if (reasons.size)
      excluded.push({ account: account.address, reasons: [...reasons].sort() });
    else
      values.push({
        account: account.address,
        realizedNet: total.toString(),
        marketCount: participated.length,
      });
  }
  values.sort((a, b) =>
    BigInt(a.realizedNet) > BigInt(b.realizedNet)
      ? -1
      : BigInt(a.realizedNet) < BigInt(b.realizedNet)
        ? 1
        : a.account.toLowerCase().localeCompare(b.account.toLowerCase()),
  );
  let rank = 1;
  return {
    entries: values.map((v, i) => {
      if (i > 0 && v.realizedNet !== values[i - 1]?.realizedNet) rank = i + 1;
      return { ...v, rank };
    }),
    excluded: excluded.sort((a, b) =>
      a.account.toLowerCase().localeCompare(b.account.toLowerCase()),
    ),
  };
}
