import { orderbookAbi } from "../../sdk/src/orderbook.js";
import {
  encodeFunctionData,
  parseAbi,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import {
  discoverEntitlements,
  hydrateEntitlements,
} from "../../app-core/src/entitlements.js";
import { computePnl } from "../../app-core/src/pnl.js";
import { PostgresFinancialLedger } from "../../indexer/src/financial-store.js";
import {
  OnchainRightsReader,
  rightsAbi,
} from "../../indexer/src/rights-reader.js";
import { marketplaceAbi } from "../../sdk/src/abis.js";
import type { AutomaticAction, AutomationSource } from "./automatic-claims.js";
import type { PostgresAutomaticStore } from "./automatic-store.js";
export const automaticAbi = parseAbi([
  "function claimWinningsFor(address owner) returns(uint256)",
  "function claimEarlyBirdFor(address owner) returns(uint256)",
  "function refundFor(address owner) returns(uint256)",
  "function claimTimeoutBonusFor(address owner) returns(uint256)",
  "function claimFor(address owner) returns(uint256)",
  "function settleBond(address market) returns(uint256)",
  "function voidAfterDeadline()",
  "function resolutionDeadline() view returns(uint256)",
]);
/** Discovery includes on-chain beneficiaries who have never registered a web account. */
export class LedgerAutomaticSource implements AutomationSource {
  private fingerprint = "";
  private readonly idleUntil = new Map<string, bigint>();
  constructor(
    readonly ledger: PostgresFinancialLedger,
    readonly client: PublicClient,
    readonly preferences: PostgresAutomaticStore,
  ) {}
  async stillEligible(action: AutomaticAction): Promise<boolean> {
    // A timeout affects the whole market. Re-discover the triggering holder on the
    // latest chain state, including when a prepared transaction survives a restart.
    if (action.kind !== "void-timeout") return true;
    for await (const current of this.candidates(true))
      if (current.key === action.key) return true;
    return false;
  }
  async *candidates(force = false): AsyncIterable<AutomaticAction> {
    const snapshot = await this.ledger.snapshot();
    if (!snapshot.complete)
      throw new Error("automatic_claims_index_incomplete");
    const head = await this.client.getBlock();
    if (head.number - BigInt(snapshot.blockNumber) > 120n)
      throw new Error("automatic_claims_index_lag");
    const indexed = await this.client.getBlock({
      blockNumber: BigInt(snapshot.blockNumber),
    });
    if (indexed.hash.toLowerCase() !== snapshot.blockHash.toLowerCase())
      throw new Error("automatic_claims_reorg");
    // Business events wake every affected historical holder, including owner-less
    // market resolution events. Reorg epoch invalidates even equal-sized ledgers.
    const changes = await this.ledger
      .sql`SELECT count(*)::text AS count, max(block_number)::text AS latest FROM ledger_facts WHERE block_number<=${snapshot.blockNumber}`;
    const fingerprint = `${snapshot.epoch}:${changes[0]?.count}:${changes[0]?.latest}`;
    if (fingerprint !== this.fingerprint) {
      this.idleUntil.clear();
      this.fingerprint = fingerprint;
    }
    // Only identical reads at this single pinned head share results; no stale RPC cache.
    const contractReads = new Map<string, Promise<unknown>>();
    const readClient = new Proxy(this.client, {
      get: (target, property) =>
        property === "readContract"
          ? (args: unknown) => {
              const key = JSON.stringify(args, (_, value) =>
                typeof value === "bigint" ? value.toString() : value,
              );
              let result = contractReads.get(key);
              if (!result) {
                result = target.readContract(args as never);
                contractReads.set(key, result);
              }
              return result;
            }
          : Reflect.get(target, property),
    });
    const env = this.ledger.environment,
      d = env.deployment;
    const excluded = new Set(
      [zeroAddress, d.marketplace, d.factory, d.bondEscrow, d.feeVault].map(
        (a) => a.toLowerCase(),
      ),
    );
    const marketRows = await this.ledger
      .sql`SELECT DISTINCT market FROM ledger_facts WHERE market IS NOT NULL`;
    for (const r of marketRows) excluded.add(r.market.toLowerCase());
    const owners = await this.ledger
      .sql`SELECT owner FROM (SELECT owner FROM ledger_facts UNION SELECT counterparty AS owner FROM ledger_facts) a WHERE owner IS NOT NULL ORDER BY owner`;
    const emitted = new Set<string>();
    for (const r of owners) {
      const owner = r.owner as Address;
      if (excluded.has(owner.toLowerCase())) continue;
      if (!(await this.preferences.enabled(owner))) {
        this.idleUntil.delete(owner);
        continue;
      }
      if (!force && (this.idleUntil.get(owner) ?? 0n) > head.timestamp)
        continue;
      let nextWake = head.timestamp + 600n;
      let hasAction = false;
      const facts = await this.ledger.accountFacts(owner, snapshot);
      const candidates = discoverEntitlements(
        owner,
        facts,
        computePnl(owner, facts, { coverageComplete: snapshot.complete }),
      );
      const reader = new OnchainRightsReader(readClient, env, head.number);
      const reads = new Map<string, ReturnType<typeof reader.market>>();
      const readMarket = reader.market.bind(reader);
      reader.market = (market, account) => {
        const key = `${market}:${account}`.toLowerCase();
        let value = reads.get(key);
        if (!value) {
          value = readMarket(market, account);
          reads.set(key, value);
        }
        return value;
      };
      const markets = [
        ...new Set(candidates.flatMap((e) => (e.market ? [e.market] : []))),
      ];
      const action = async (
        target: Address,
        kind: string,
        data: AutomaticAction["data"],
      ): Promise<AutomaticAction> => {
        await this.ledger.assertSnapshot(snapshot);
        hasAction = true;
        return {
          key: `${kind}:${target.toLowerCase()}:${owner.toLowerCase()}`,
          owner,
          kind,
          target,
          data,
          requiresClaimPreference: true,
        };
      };
      // Market-level timeout/maintenance requires at least one enabled real rights holder.
      for (const market of markets) {
        const rights = await reader.market(market, owner);
        const bond = await readClient.readContract({
          address: d.bondEscrow,
          abi: rightsAbi,
          functionName: "bondOf",
          args: [market],
          blockNumber: head.number,
        });
        let escrowHeld = false;
        for (const e of candidates.filter(
          (e) =>
            e.market?.toLowerCase() === market.toLowerCase() &&
            e.kind === "escrow" &&
            e.listingId &&
            BigInt(e.units ?? "0") > 0n,
        )) {
          if ((await reader.listing(e.listingId!, owner)).units > 0n)
            escrowHeld = true;
        }
        const holds =
          escrowHeld ||
          rights.balances.some((n) => n > 0n) ||
          rights.ownerEarlyScore > 0n ||
          rights.ownerTimeoutUnits > 0n ||
          (bond[0].toLowerCase() === owner.toLowerCase() && bond[1] > 0n);
        if (!holds) continue;
        if (rights.state === 0) {
          const deadline = await readClient.readContract({
            address: market,
            abi: automaticAbi,
            functionName: "resolutionDeadline",
            blockNumber: head.number,
          });
          if (deadline > head.timestamp && deadline < nextWake)
            nextWake = deadline;
          if (head.timestamp >= deadline && !emitted.has(`void:${market}`)) {
            emitted.add(`void:${market}`);
            yield await action(
              market,
              "void-timeout",
              encodeFunctionData({
                abi: automaticAbi,
                functionName: "voidAfterDeadline",
              }),
            );
          }
        } else if (!bond[2] && !emitted.has(`bond:${market}`)) {
          emitted.add(`bond:${market}`);
          yield await action(
            d.bondEscrow,
            `settle-bond:${market.toLowerCase()}`,
            encodeFunctionData({
              abi: automaticAbi,
              functionName: "settleBond",
              args: [market],
            }),
          );
        }
      }
      const hydrated = await hydrateEntitlements(owner, candidates, reader);
      // Return terminal escrow BEFORE winner/refund claims. Ordinary live asks are not cancelled.
      const ordered = [
        ...hydrated.filter((e) => e.kind === "escrow"),
        ...hydrated.filter((e) => e.kind !== "escrow"),
      ];
      for (const e of ordered) {
        if (
          e.kind === "escrow" &&
          e.listingId &&
          e.reason === "return_terminal_listing" &&
          BigInt(e.units ?? "0") > 0n
        ) {
          yield await action(
            d.marketplace,
            `return-listing:${e.listingId}`,
            d.marketplaceVersion === "orderbook-v2"
              ? encodeFunctionData({
                  abi: orderbookAbi,
                  functionName: "releaseOrder",
                  args: [BigInt(e.listingId)],
                })
              : encodeFunctionData({
                  abi: marketplaceAbi,
                  functionName: "returnTerminalListing",
                  args: [e.listingId],
                }),
          );
          continue;
        }
        if (e.status !== "claimable" || BigInt(e.amount ?? "0") <= 0n) continue;
        const fn =
          e.kind === "winner"
            ? "claimWinningsFor"
            : e.kind === "early-bird"
              ? "claimEarlyBirdFor"
              : e.kind === "refund"
                ? "refundFor"
                : e.kind === "timeout-bonus"
                  ? "claimTimeoutBonusFor"
                  : e.market === null &&
                      (e.kind === "fees" || e.kind === "bond")
                    ? "claimFor"
                    : undefined;
        if (!fn) continue;
        const target =
          e.market ?? (e.kind === "fees" ? d.feeVault : d.bondEscrow);
        yield await action(
          target,
          e.kind,
          encodeFunctionData({
            abi: automaticAbi,
            functionName: fn,
            args: [owner],
          }),
        );
      }
      await this.ledger.assertSnapshot(snapshot);
      // Generator cancellation after a yielded action must never put that owner to sleep.
      if (!force && !hasAction) {
        this.idleUntil.set(owner, nextWake);
        if (this.idleUntil.size > 10_000)
          this.idleUntil.delete(this.idleUntil.keys().next().value!);
      } else this.idleUntil.delete(owner);
    }
  }
}
