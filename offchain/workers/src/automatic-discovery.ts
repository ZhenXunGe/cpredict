import { zeroAddress, type Address } from "viem";
import type { LedgerSnapshot } from "../../app-core/src/ledger-contracts.js";
import type { PostgresFinancialLedger } from "../../indexer/src/financial-store.js";
import type { LedgerAutomaticSource } from "./automatic-source.js";
import { PostgresClaimQueue, type ClaimWake } from "./automatic-queue.js";
import { submissionFailure } from "./automatic-diagnostics.js";

const marketEvents = [
  "market-resolved",
  "market-voided",
  "timeout-funded",
  "bond-timeout-funded",
];
const ignoredEvents = new Set([
  "payment-transfer",
  "user-operation",
  "market-metadata",
  "coverage-gap",
]);
export function discoveryFailure(e: unknown): string {
  const message = e instanceof Error ? e.message : "";
  for (const reason of [
    "automatic_claims_index_incomplete",
    "automatic_claims_index_lag",
    "automatic_claims_reorg",
    "snapshot_invalidated",
    "history_capacity_exceeded",
    "automatic_claims_read_unavailable",
  ])
    if (message === reason) return reason;
  return `chain_check_${submissionFailure(e).reason}`;
}
/** Read ledger facts, then atomically persist wakeups and the completed-block cursor. */
export class AutomaticClaimDiscovery {
  constructor(
    readonly queue: PostgresClaimQueue,
    readonly ledger: PostgresFinancialLedger,
    readonly source: LedgerAutomaticSource,
    readonly report: (
      phase: string,
      seconds: number,
      counts: Record<string, number>,
    ) => void = () => {},
  ) {}
  private observe(
    phase: string,
    seconds: number,
    counts: Record<string, number>,
  ): void {
    try {
      this.report(phase, seconds, counts);
    } catch {}
  }
  async assertCurrent(): Promise<LedgerSnapshot> {
    const snapshot = await this.ledger.snapshot();
    if (!snapshot.complete)
      throw new Error("automatic_claims_index_incomplete");
    const head = await this.source.client.getBlock();
    if (head.number - BigInt(snapshot.blockNumber) > 120n)
      throw new Error("automatic_claims_index_lag");
    if (
      (
        await this.source.client.getBlock({
          blockNumber: BigInt(snapshot.blockNumber),
        })
      ).hash.toLowerCase() !== snapshot.blockHash.toLowerCase()
    )
      throw new Error("automatic_claims_reorg");
    this.observe(
      "index-lag",
      Math.max(0, Number(head.timestamp - BigInt(snapshot.timestamp))),
      {},
    );
    return snapshot;
  }
  async tick(): Promise<void> {
    await this.queue.exclusive(async () => {
      const started = performance.now();
      try {
        const snapshot = await this.assertCurrent(),
          d = this.ledger.environment.deployment;
        let progress = await this.queue.progress(snapshot, d.deploymentBlock);
        if (progress.cursor_hash) {
          const [anchor] = await this.ledger
            .sql`SELECT block_hash FROM canonical_blocks WHERE chain_id=${d.chainId} AND block_number=${String(progress.cursor_block)}`;
          if (anchor?.block_hash !== progress.cursor_hash)
            progress = await this.queue.progress(
              snapshot,
              d.deploymentBlock,
              true,
            );
        }
        const blocks = await this.ledger
          .sql`SELECT DISTINCT block_number FROM ledger_facts WHERE chain_id=${d.chainId} AND block_number>${String(progress.cursor_block)} AND block_number<=${snapshot.blockNumber} ORDER BY block_number LIMIT 100`;
        const through =
          blocks.length === 100
            ? String(blocks.at(-1)!.block_number)
            : snapshot.blockNumber;
        const facts = await this.ledger
          .sql`SELECT f.kind,f.owner,f.counterparty,f.market,f.occurred_at,e.observed_at FROM ledger_facts f LEFT JOIN chain_events e ON e.chain_id=f.chain_id AND e.transaction_hash=f.transaction_hash AND e.log_index=f.log_index WHERE f.chain_id=${d.chainId} AND f.block_number>${String(progress.cursor_block)} AND f.block_number<=${through} ORDER BY f.block_number,f.transaction_index,f.log_index,f.fact_index`;
        const excluded = new Set(
          [zeroAddress, d.factory, d.marketplace, d.bondEscrow, d.feeVault].map(
            (a) => a.toLowerCase(),
          ),
        );
        const wakes = new Map<string, ClaimWake>();
        const wake = (
          owner: string | null,
          scope: string,
          trigger: Date,
          indexedAt?: Date,
        ) => {
          if (!owner || excluded.has(owner.toLowerCase())) return;
          const key = `${owner.toLowerCase()}:${scope.toLowerCase()}`,
            old = wakes.get(key);
          wakes.set(key, {
            owner: owner.toLowerCase() as Address,
            scope: scope.toLowerCase(),
            triggerAt: old && old.triggerAt < trigger ? old.triggerAt : trigger,
            indexedAt:
              old?.indexedAt && indexedAt && old.indexedAt < indexedAt
                ? old.indexedAt
                : indexedAt,
          });
        };
        for (const f of facts) {
          if (ignoredEvents.has(f.kind)) continue;
          const trigger = new Date(Number(f.occurred_at) * 1000),
            scope = f.market ?? "aggregate";
          wake(f.owner, scope, trigger, f.observed_at);
          wake(f.counterparty, scope, trigger, f.observed_at);
          if (f.market && marketEvents.includes(f.kind)) {
            const holders = await this.ledger
              .sql`SELECT owner FROM (SELECT owner FROM ledger_facts WHERE chain_id=${d.chainId} AND market=${f.market} AND block_number<=${through} UNION SELECT counterparty AS owner FROM ledger_facts WHERE chain_id=${d.chainId} AND market=${f.market} AND block_number<=${through}) a WHERE owner IS NOT NULL`;
            for (const h of holders)
              wake(h.owner, f.market, trigger, f.observed_at);
          }
        }
        await this.ledger.assertSnapshot(snapshot);
        const [anchor] = await this.ledger
          .sql`SELECT block_hash FROM canonical_blocks WHERE chain_id=${d.chainId} AND block_number=${through}`;
        if (!anchor) throw new Error("automatic_claims_index_incomplete");
        await this.queue.ingest(
          snapshot.epoch,
          String(progress.cursor_block),
          through,
          anchor.block_hash,
          [...wakes.values()],
        );
        this.observe("discovery", (performance.now() - started) / 1000, {
          cursor: Number(through),
          events: facts.length,
          accounts: new Set([...wakes.values()].map((w) => w.owner)).size,
          markets: new Set([...wakes.values()].map((w) => w.scope)).size,
        });
        // Historical work is paged and cannot occupy the hot scanner while ready work exists.
        if (
          new Date(progress.backstop_due).getTime() <= Date.now() &&
          !(await this.queue.workPending())
        ) {
          const owners = await this.ledger
            .sql`SELECT owner FROM (SELECT owner FROM ledger_facts WHERE chain_id=${d.chainId} UNION SELECT counterparty AS owner FROM ledger_facts WHERE chain_id=${d.chainId}) a WHERE owner IS NOT NULL AND (${progress.backstop_owner ?? null}::text IS NULL OR owner>${progress.backstop_owner ?? null}) ORDER BY owner LIMIT 25`;
          const filtered = owners.filter(
            (r) => !excluded.has(r.owner.toLowerCase()),
          );
          await this.queue.backstop(
            snapshot.epoch,
            filtered.map((r) => r.owner as Address),
            owners.at(-1)?.owner ?? null,
            owners.length < 25,
          );
        }
        const sharedReads = new Map<string, Promise<unknown>>();
        for (const scope of await this.queue.dueScopes()) {
          let deadline: Date | null = null;
          const checked = performance.now();
          try {
            const actions = [];
            for await (const a of this.source.candidates(
              true,
              scope,
              sharedReads,
              (t) => {
                deadline = new Date(Number(t) * 1000);
              },
            ))
              actions.push(a);
            await this.ledger.assertSnapshot(snapshot);
            await this.queue.discovered(scope, actions, deadline);
            this.observe("validation", (performance.now() - checked) / 1000, {
              accounts: 1,
              candidates: actions.length,
            });
          } catch (e) {
            await this.queue.failedScope(scope, discoveryFailure(e));
          }
        }
      } catch (e) {
        await this.queue.error(discoveryFailure(e));
        throw e;
      }
    });
  }
}
