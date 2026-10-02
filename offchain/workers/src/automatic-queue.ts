import type { Sql, TransactionSql } from "postgres";
import type { Address } from "viem";
import type { LedgerSnapshot } from "../../app-core/src/ledger-contracts.js";
import type { AutomaticAction } from "./automatic-claims.js";

export interface ClaimScope {
  owner: Address;
  scope: string;
  version: string;
  epoch: string;
  trigger_at: Date;
  indexed_at: Date;
  attempts: number;
}
export interface ClaimWake {
  owner: Address;
  scope: string;
  triggerAt: Date;
  indexedAt?: Date | undefined;
}
export const retrySeconds = (attempts: number) =>
  [2, 5, 15, 30, 60][Math.min(Math.max(attempts, 0), 4)]!;
export function claimPriority(kind: string): number {
  if (kind === "void-timeout" || kind.startsWith("settle-bond:")) return 0;
  if (kind.startsWith("return-listing:")) return 1;
  return kind === "winner" || kind === "refund" ? 2 : 3;
}
const json = (a: AutomaticAction) => JSON.parse(JSON.stringify(a));
/** Unsigned work only. The existing sender journal owns every signed transaction. */
export class PostgresClaimQueue {
  constructor(
    readonly sql: Sql,
    readonly chainId: number,
    readonly deploymentId: string,
  ) {}
  async ready(): Promise<void> {
    await this.sql`SELECT cursor_block FROM automation_discovery LIMIT 0`;
    await this.sql`SELECT job_key FROM automation_claim_candidates LIMIT 0`;
    await this.sql`SELECT version FROM automation_claim_scopes LIMIT 0`;
  }
  async exclusive<T>(work: () => Promise<T>): Promise<T | undefined> {
    const db = await this.sql.reserve(),
      key = `claims-discovery:${this.chainId}:${this.deploymentId}`;
    try {
      const [r] =
        await db`SELECT pg_try_advisory_lock(hashtextextended(${key},0)) AS acquired`;
      if (!r?.acquired) return;
      try {
        return await work();
      } finally {
        await db`SELECT pg_advisory_unlock(hashtextextended(${key},0))`;
      }
    } finally {
      db.release();
    }
  }
  async progress(
    snapshot: LedgerSnapshot,
    deploymentBlock: string,
    invalidate = false,
  ) {
    return this.sql.begin(async (db) => {
      await db`INSERT INTO automation_discovery(chain_id,deployment_id,epoch,cursor_block)
        VALUES(${this.chainId},${this.deploymentId},${snapshot.epoch},${(BigInt(deploymentBlock) - 1n).toString()}) ON CONFLICT DO NOTHING`;
      const [r] =
        await db`SELECT * FROM automation_discovery WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} FOR UPDATE`;
      if (!r) throw new Error("claims_discovery_unavailable");
      // A rollback to the old worker may finish a signed journal without touching
      // the new tables. Reconcile links before recovering unsigned queue work.
      await db`UPDATE automation_claim_candidates c SET state=CASE WHEN t.state='confirmed' THEN 'done' WHEN t.state='cancelled' THEN 'discarded' ELSE 'deferred' END,transaction_id=NULL,reason=CASE WHEN t.state='reverted' THEN 'transaction_reverted' ELSE NULL END,next_attempt_at=now(),updated_at=now() FROM automation_transactions t WHERE c.chain_id=${this.chainId} AND c.deployment_id=${this.deploymentId} AND c.transaction_id=t.id AND c.state='inflight' AND t.state IN ('confirmed','reverted','cancelled')`;
      if (
        invalidate ||
        String(r.epoch) !== snapshot.epoch ||
        BigInt(r.cursor_block) > BigInt(snapshot.blockNumber)
      ) {
        await db`UPDATE automation_claim_candidates SET state='discarded',reason='rechecking_after_reorg',updated_at=now() WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND state IN ('ready','deferred')`;
        await db`DELETE FROM automation_claim_scopes WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId}`;
        const [reset] =
          await db`UPDATE automation_discovery SET epoch=${snapshot.epoch},cursor_block=${(BigInt(deploymentBlock) - 1n).toString()},cursor_hash=NULL,backstop_owner=NULL,backstop_due=now(),reason='rechecking_after_reorg',updated_at=now() WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} RETURNING *`;
        return reset!;
      }
      return r;
    });
  }
  private async wakeWith(
    db: Sql | TransactionSql,
    wake: ClaimWake,
    epoch: string,
    priority = 0,
  ) {
    // A future deadline with no failed validation is dormant work. A new event
    // starts its latency clock; retry backoffs retain the original clock. An
    // already queued candidate retains its earlier origin in discovered().
    await db`INSERT INTO automation_claim_scopes(chain_id,deployment_id,owner,scope,epoch,due_at,priority,trigger_at,indexed_at)
      VALUES(${this.chainId},${this.deploymentId},${wake.owner.toLowerCase()},${wake.scope.toLowerCase()},${epoch},now(),${priority},${wake.triggerAt},${wake.indexedAt ?? new Date()})
      ON CONFLICT(chain_id,deployment_id,owner,scope) DO UPDATE SET version=automation_claim_scopes.version+1,epoch=EXCLUDED.epoch,due_at=now(),priority=LEAST(automation_claim_scopes.priority,EXCLUDED.priority),trigger_at=CASE WHEN automation_claim_scopes.due_at IS NULL OR (automation_claim_scopes.due_at>now() AND automation_claim_scopes.attempts=0) THEN EXCLUDED.trigger_at ELSE LEAST(automation_claim_scopes.trigger_at,EXCLUDED.trigger_at) END,indexed_at=CASE WHEN automation_claim_scopes.due_at IS NULL OR (automation_claim_scopes.due_at>now() AND automation_claim_scopes.attempts=0) THEN EXCLUDED.indexed_at ELSE LEAST(automation_claim_scopes.indexed_at,EXCLUDED.indexed_at) END,attempts=0,reason=NULL,updated_at=now()`;
  }
  async ingest(
    epoch: string,
    previous: string,
    block: string,
    hash: string,
    wakes: ClaimWake[],
  ) {
    return this.sql.begin(async (db) => {
      const [r] =
        await db`SELECT epoch,cursor_block FROM automation_discovery WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} FOR UPDATE`;
      if (
        !r ||
        String(r.epoch) !== epoch ||
        BigInt(r.cursor_block) !== BigInt(previous)
      )
        return false;
      for (const wake of wakes) await this.wakeWith(db, wake, epoch);
      await db`UPDATE automation_discovery SET cursor_block=${block},cursor_hash=${hash},reason=NULL,updated_at=now() WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId}`;
      return true;
    });
  }
  async backstop(
    epoch: string,
    owners: Address[],
    after: string | null,
    complete: boolean,
  ) {
    await this.sql.begin(async (db) => {
      const [r] =
        await db`SELECT epoch FROM automation_discovery WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} FOR UPDATE`;
      if (!r || String(r.epoch) !== epoch) return;
      for (const owner of owners)
        await this.wakeWith(
          db,
          { owner, scope: "*", triggerAt: new Date() },
          epoch,
          1,
        );
      await db`UPDATE automation_discovery SET backstop_owner=${complete ? null : after},backstop_due=CASE WHEN ${complete} THEN now()+interval '5 minutes' ELSE now() END WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId}`;
    });
  }
  async dueScopes(): Promise<ClaimScope[]> {
    const rows = await this
      .sql`SELECT owner,scope,version::text,epoch::text,trigger_at,indexed_at,attempts FROM automation_claim_scopes WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND due_at<=now() ORDER BY priority,due_at,owner,scope LIMIT 4`;
    return rows.map((r) => ({ ...r, owner: r.owner as Address }) as ClaimScope);
  }
  async discovered(
    scope: ClaimScope,
    actions: AutomaticAction[],
    nextWake: Date | null,
  ) {
    await this.sql.begin(async (db) => {
      const [r] =
        await db`SELECT version::text,epoch::text FROM automation_claim_scopes WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND owner=${scope.owner.toLowerCase()} AND scope=${scope.scope} FOR UPDATE`;
      if (!r || r.version !== scope.version || r.epoch !== scope.epoch) return;
      const keys = actions.map((a) => a.key);
      await db`UPDATE automation_claim_candidates SET state='discarded',reason='no_entitlement',updated_at=now() WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND owner=${scope.owner.toLowerCase()} AND (${scope.scope}='*' OR scope=${scope.scope}) AND state IN ('ready','deferred') AND NOT(job_key=ANY(${keys}::text[]))`;
      for (const a of actions) {
        // Ready candidates must not be resurrected while a durable transaction is in flight,
        // including journals created before this queue existed.
        await db`INSERT INTO automation_claim_candidates(chain_id,deployment_id,job_key,owner,scope,kind,action,epoch,priority,state,trigger_at,indexed_at)
          SELECT ${this.chainId},${this.deploymentId},${a.key},${a.owner.toLowerCase()},${scope.scope},${a.kind},${db.json(json(a))},${scope.epoch},${claimPriority(a.kind)},'ready',${scope.trigger_at},${scope.indexed_at}
          WHERE NOT EXISTS(SELECT 1 FROM automation_transactions WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND job_key=${a.key} AND state IN ('prepared','broadcasting','unknown'))
          ON CONFLICT(chain_id,deployment_id,job_key) DO UPDATE SET action=EXCLUDED.action,epoch=EXCLUDED.epoch,scope=EXCLUDED.scope,state='ready',transaction_id=NULL,reason=NULL,attempts=0,next_attempt_at=now(),trigger_at=CASE WHEN automation_claim_candidates.state IN ('done','discarded') THEN EXCLUDED.trigger_at ELSE LEAST(automation_claim_candidates.trigger_at,EXCLUDED.trigger_at) END,indexed_at=CASE WHEN automation_claim_candidates.state IN ('done','discarded') THEN EXCLUDED.indexed_at ELSE automation_claim_candidates.indexed_at END,queued_at=CASE WHEN automation_claim_candidates.state IN ('done','discarded') THEN now() ELSE automation_claim_candidates.queued_at END,updated_at=now()
          WHERE automation_claim_candidates.state<>'inflight'`;
      }
      await db`UPDATE automation_claim_scopes SET due_at=${nextWake},attempts=0,reason=NULL,updated_at=now() WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND owner=${scope.owner.toLowerCase()} AND scope=${scope.scope}`;
    });
  }
  async failedScope(scope: ClaimScope, reason: string) {
    await this
      .sql`UPDATE automation_claim_scopes SET attempts=attempts+1,reason=${reason},due_at=now()+${retrySeconds(scope.attempts)}*interval '1 second',updated_at=now() WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND owner=${scope.owner.toLowerCase()} AND scope=${scope.scope} AND version=${scope.version} AND epoch=${scope.epoch}`;
  }
  async error(reason: string) {
    await this
      .sql`UPDATE automation_discovery SET reason=${reason},updated_at=now() WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId}`;
  }
  async *candidates(): AsyncIterable<AutomaticAction> {
    const rows = await this.sql`WITH ready AS (
      SELECT c.*,row_number() OVER(PARTITION BY c.owner ORDER BY c.priority,c.trigger_at,c.queued_at,c.job_key) AS turn
      FROM automation_claim_candidates c JOIN automation_discovery d USING(chain_id,deployment_id)
      WHERE c.chain_id=${this.chainId} AND c.deployment_id=${this.deploymentId} AND c.epoch=d.epoch AND c.state IN ('ready','deferred') AND c.next_attempt_at<=now()
    ) SELECT c.action FROM ready c LEFT JOIN LATERAL (
      SELECT max(t.created_at) AS served FROM automation_transactions t WHERE t.chain_id=c.chain_id AND t.deployment_id=c.deployment_id AND t.owner=c.owner
    ) history ON true
    ORDER BY CASE WHEN c.priority<2 THEN c.priority ELSE 2 END,date_trunc('minute',c.trigger_at),c.turn,history.served NULLS FIRST,c.priority,c.trigger_at,c.queued_at,c.job_key LIMIT 20`;
    for (const r of rows) yield r.action as AutomaticAction;
  }
  async reject(action: AutomaticAction, reason: string) {
    const discard = ["no_entitlement", "owner_opted_out"].includes(reason);
    await this
      .sql`UPDATE automation_claim_candidates SET state=${discard ? "discarded" : "deferred"},reason=${reason},next_attempt_at=now()+CASE attempts WHEN 0 THEN 2 WHEN 1 THEN 5 WHEN 2 THEN 15 WHEN 3 THEN 30 ELSE 60 END*interval '1 second',attempts=attempts+1,updated_at=now() WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND job_key=${action.key} AND state IN ('ready','deferred')`;
  }
  async workPending(): Promise<boolean> {
    const [r] = await this
      .sql`SELECT EXISTS(SELECT 1 FROM automation_claim_candidates WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND state IN ('ready','deferred') AND next_attempt_at<=now()) OR EXISTS(SELECT 1 FROM automation_claim_scopes WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND due_at<=now()) AS busy`;
    return r?.busy === true;
  }
  async summary(owner: Address, blocked: string | null = null) {
    const empty = {
      state: "unavailable" as const,
      readyCount: 0,
      inFlightCount: 0,
      deferredCount: 0,
      oldestQueuedAt: null,
      updatedAt: null,
      reason: "queue_status_unavailable",
    };
    try {
      const [d] = await this
        .sql`SELECT reason,updated_at FROM automation_discovery WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId}`;
      if (!d || Date.now() - new Date(d.updated_at).getTime() > 120000)
        return empty;
      const [c] = await this
        .sql`SELECT count(*) FILTER(WHERE state='ready')::int AS ready,count(*) FILTER(WHERE state='deferred')::int AS deferred,min(queued_at) FILTER(WHERE state IN ('ready','deferred')) AS oldest FROM automation_claim_candidates WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND owner=${owner.toLowerCase()} AND (kind IN ('winner','early-bird','refund','timeout-bonus','fees','bond','release-order') OR kind LIKE 'return-listing:%')`;
      const [t] = await this
        .sql`SELECT count(*) FILTER(WHERE state IN ('broadcasting','unknown'))::int AS inflight,count(*) FILTER(WHERE state='prepared')::int AS prepared,min(created_at) FILTER(WHERE state='prepared') AS oldest FROM automation_transactions WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND owner=${owner.toLowerCase()} AND requires_claim_preference AND state IN ('prepared','broadcasting','unknown') AND (kind IN ('winner','early-bird','refund','timeout-bonus','fees','bond','release-order') OR kind LIKE 'return-listing:%')`;
      const [scope] = await this
        .sql`SELECT reason FROM automation_claim_scopes WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND owner=${owner.toLowerCase()} AND (due_at<=now() OR attempts>0) ORDER BY reason NULLS LAST LIMIT 1`;
      const [failure] = await this
        .sql`SELECT reason FROM automation_claim_candidates WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND owner=${owner.toLowerCase()} AND state='deferred' ORDER BY updated_at DESC LIMIT 1`;
      const [globalPause] = await this
        .sql`SELECT s.reason FROM automation_transactions t JOIN automation_lane_status s ON s.chain_id=t.chain_id AND s.deployment_id=t.deployment_id AND s.lane='claims' AND (s.owner=t.owner OR s.owner='0x0000000000000000000000000000000000000000') WHERE t.chain_id=${this.chainId} AND t.deployment_id=${this.deploymentId} AND t.state='prepared' AND t.requires_claim_preference AND s.reason IN ('daily_gas_budget_exhausted','per_transaction_gas_cap_exceeded','gas_balance_insufficient','submission_rpc_unavailable') ORDER BY s.updated_at DESC LIMIT 1`;
      const reason =
        blocked ??
        globalPause?.reason ??
        d.reason ??
        scope?.reason ??
        failure?.reason ??
        null;
      const state =
        blocked || globalPause
          ? "paused"
          : t?.inflight
            ? "confirming"
            : reason
              ? "paused"
              : c?.ready || t?.prepared
                ? "queued"
                : scope
                  ? "discovering"
                  : c?.deferred
                    ? "queued"
                    : "idle";
      const oldest = [c?.oldest, t?.oldest]
        .filter(Boolean)
        .map((time) => new Date(time).getTime());
      return {
        state,
        readyCount: (c?.ready ?? 0) + (t?.prepared ?? 0),
        inFlightCount: t?.inflight ?? 0,
        deferredCount: c?.deferred ?? 0,
        oldestQueuedAt: oldest.length
          ? new Date(Math.min(...oldest)).toISOString()
          : null,
        updatedAt: new Date(d.updated_at).toISOString(),
        reason,
      };
    } catch {
      return empty;
    }
  }
}
