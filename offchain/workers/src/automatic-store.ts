import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { Address, Hex } from "viem";
import type {
  AutomaticAction,
  AutomationLane,
  PreparedAutomation,
  AutomationRecord,
  AutomationReceipt,
  AutomationStore,
} from "./automatic-claims.js";
import { automationEffect } from "./automatic-claims.js";
export class PostgresAutomaticStore implements AutomationStore {
  constructor(
    readonly sql: Sql,
    readonly chainId: number,
    readonly deploymentId: string,
    readonly signer: Address,
    readonly lane: AutomationLane = "claims",
  ) {}
  async exclusive<T>(work: () => Promise<T>): Promise<T | undefined> {
    const db = await this.sql.reserve();
    const key = `automatic:${this.chainId}:${this.signer.toLowerCase()}`;
    try {
      const [r] =
        await db`SELECT pg_try_advisory_lock(hashtextextended(${key},0)) AS acquired`;
      if (!r?.acquired) return undefined;
      try {
        return await work();
      } finally {
        await db`SELECT pg_advisory_unlock(hashtextextended(${key},0))`;
      }
    } finally {
      db.release();
    }
  }
  async enabled(owner: Address): Promise<boolean> {
    const [r] = await this
      .sql`SELECT enabled FROM automatic_claim_preferences WHERE chain_id=${this.chainId} AND owner=${owner.toLowerCase()}`;
    return r?.enabled !== false;
  }
  async setEnabled(owner: Address, enabled: boolean): Promise<void> {
    await this
      .sql`INSERT INTO automatic_claim_preferences(chain_id,owner,enabled) VALUES(${this.chainId},${owner.toLowerCase()},${enabled})
      ON CONFLICT(chain_id,owner) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`;
  }
  async pending(): Promise<AutomationRecord[]> {
    const rows = await this
      .sql`SELECT * FROM automation_transactions WHERE chain_id=${this.chainId} AND signer=${this.signer.toLowerCase()} AND state IN ('prepared','broadcasting','unknown') ORDER BY nonce`;
    return rows.map((r) => ({
      id: r.id,
      key: r.job_key,
      owner: r.owner as Address,
      kind: r.kind,
      target: r.target as Address,
      data: r.calldata as Hex,
      requiresClaimPreference: r.requires_claim_preference,
      raw: r.raw_transaction as Hex,
      hash: r.tx_hash as Hex,
      nonce: BigInt(r.nonce),
      maximumCost: BigInt(r.reserved_wei),
      state: r.state,
    }));
  }
  async save(
    action: AutomaticAction,
    tx: PreparedAutomation,
  ): Promise<AutomationRecord> {
    const id = randomUUID();
    await this
      .sql`INSERT INTO automation_transactions(id,chain_id,deployment_id,job_key,owner,kind,target,calldata,signer,requires_claim_preference,nonce,tx_hash,raw_transaction,state,reserved_wei)
      VALUES(${id},${this.chainId},${this.deploymentId},${action.key},${action.owner.toLowerCase()},${action.kind},${action.target.toLowerCase()},${action.data},${this.signer.toLowerCase()},${action.requiresClaimPreference},${tx.nonce.toString()},${tx.hash},${tx.raw},'prepared',${tx.maximumCost.toString()})`;
    return { ...action, ...tx, id, state: "prepared" };
  }
  async markBroadcasting(id: string): Promise<boolean> {
    const r = await this
      .sql`UPDATE automation_transactions SET state='broadcasting',broadcast_at=now(),updated_at=now() WHERE id=${id} AND state='prepared' RETURNING id`;
    return r.length === 1;
  }
  async cancelPrepared(id: string): Promise<void> {
    await this
      .sql`UPDATE automation_transactions SET state='cancelled',nonce=NULL,raw_transaction=NULL,reserved_wei=0,updated_at=now() WHERE id=${id} AND state='prepared'`;
  }
  async unknown(id: string): Promise<void> {
    await this
      .sql`UPDATE automation_transactions SET state='unknown',updated_at=now() WHERE id=${id} AND state='broadcasting'`;
  }
  async finish(id: string, r: AutomationReceipt): Promise<void> {
    const success = r.status === "success";
    await this
      .sql`UPDATE automation_transactions SET state=${success ? "confirmed" : "reverted"},receipt_block=${r.blockNumber.toString()},receipt_hash=${r.blockHash},canonical_status=${success ? "canonical" : "unchecked"},canonical_checked_at=CASE WHEN ${success} THEN now() ELSE NULL END,raw_transaction=NULL,updated_at=now() WHERE id=${id}`;
  }
  async spentToday(excludeId?: string): Promise<bigint> {
    const [r] = await this
      .sql`SELECT COALESCE(sum(reserved_wei),0)::text AS amount FROM automation_transactions
      WHERE chain_id=${this.chainId} AND signer=${this.signer.toLowerCase()} AND (${excludeId ?? null}::uuid IS NULL OR id<>${excludeId ?? null}::uuid) AND COALESCE(broadcast_at,created_at)>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
    return BigInt(r?.amount ?? "0");
  }
  async status(owner: Address, reason: string): Promise<void> {
    await this
      .sql`INSERT INTO automation_lane_status(chain_id,deployment_id,lane,owner,reason) VALUES(${this.chainId},${this.deploymentId},${this.lane},${owner.toLowerCase()},${reason})
      ON CONFLICT(chain_id,deployment_id,lane,owner) DO UPDATE SET reason=EXCLUDED.reason,updated_at=now()`;
  }
  async auditCanonical(): Promise<AutomaticAction[]> {
    return this.sql.begin(async (db) => {
      const rows = await db<
        {
          id: string;
          job_key: string;
          owner: Address;
          kind: string;
          target: Address;
          calldata: Hex;
          requires_claim_preference: boolean;
          receipt_block: string;
          receipt_hash: Hex;
          checkpoint: string | null;
          canonical_hash: Hex | null;
          moved_block: string | null;
          moved_hash: Hex | null;
        }[]
      >`SELECT t.id,t.job_key,t.owner,t.kind,t.target,t.calldata,t.requires_claim_preference,
          t.receipt_block::text,t.receipt_hash,cp.block_number::text AS checkpoint,
          cb.block_hash AS canonical_hash,moved.block_number::text AS moved_block,moved.block_hash AS moved_hash
        FROM automation_transactions t
        LEFT JOIN chain_checkpoints cp ON cp.chain_id=t.chain_id
        LEFT JOIN canonical_blocks cb ON cb.chain_id=t.chain_id AND cb.block_number=t.receipt_block
        LEFT JOIN LATERAL (
          SELECT e.block_number,e.block_hash FROM chain_events e
          WHERE e.chain_id=t.chain_id AND e.transaction_hash=t.tx_hash
          ORDER BY e.block_number DESC,e.log_index LIMIT 1
        ) moved ON true
        WHERE t.chain_id=${this.chainId} AND t.deployment_id=${this.deploymentId}
          AND t.signer=${this.signer.toLowerCase()} AND t.state='confirmed'
          AND (t.canonical_checked_at IS NULL OR t.canonical_checked_at<now()-interval '5 minutes')
        ORDER BY t.canonical_checked_at NULLS FIRST,t.created_at
        LIMIT 20 FOR UPDATE OF t SKIP LOCKED`;
      const orphaned: AutomaticAction[] = [];
      for (const row of rows) {
        if (
          row.canonical_hash?.toLowerCase() === row.receipt_hash.toLowerCase()
        ) {
          await db`UPDATE automation_transactions SET canonical_status='canonical',canonical_checked_at=now() WHERE id=${row.id}`;
          continue;
        }
        if (row.moved_block && row.moved_hash) {
          await db`UPDATE automation_transactions SET receipt_block=${row.moved_block},receipt_hash=${row.moved_hash},canonical_status='canonical',canonical_checked_at=now(),updated_at=now() WHERE id=${row.id}`;
          continue;
        }
        if (
          row.checkpoint === null ||
          BigInt(row.checkpoint) < BigInt(row.receipt_block)
        )
          continue;
        await db`UPDATE automation_transactions SET canonical_status='orphaned',canonical_checked_at=now(),updated_at=now() WHERE id=${row.id}`;
        orphaned.push({
          key: row.job_key,
          owner: row.owner,
          kind: row.kind,
          target: row.target,
          data: row.calldata,
          requiresClaimPreference: row.requires_claim_preference,
        });
      }
      return orphaned;
    });
  }
  async blockedCounts() {
    return this
      .sql`SELECT reason,count(*)::int AS count FROM automation_lane_status WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND lane=${this.lane} AND reason IN ('daily_gas_budget_exhausted','gas_balance_insufficient','retry_after_chain_check','checking_original_transaction','transaction_reverted','submission_rpc_unavailable','rechecking_after_reorg') GROUP BY reason`;
  }
  async oldestPendingSeconds(): Promise<number> {
    const [r] = await this
      .sql`SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(COALESCE(broadcast_at,created_at))),0)::float AS age
      FROM automation_transactions WHERE chain_id=${this.chainId} AND signer=${this.signer.toLowerCase()} AND state IN ('prepared','broadcasting','unknown')`;
    return Number(r?.age ?? 0);
  }
  async publicStatus(owner: Address) {
    const [status] = await this
      .sql`SELECT reason,updated_at FROM automation_lane_status WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND lane='claims' AND owner=${owner.toLowerCase()}`;
    const rows = await this.sql<
      {
        id: string;
        kind: string;
        state: string;
        canonical_status: string;
        tx_hash: Hex | null;
        created_at: Date;
        fact: unknown | null;
        market_question: string | null;
        market_rules: unknown | null;
      }[]
    >`SELECT t.id,t.kind,t.state,t.canonical_status,t.tx_hash,t.created_at,
        matched.fact,CASE WHEN metadata.verified THEN metadata.question ELSE NULL END AS market_question,
        CASE WHEN metadata.verified THEN metadata.rules ELSE NULL END AS market_rules
      FROM automation_transactions t
      LEFT JOIN LATERAL (
        SELECT f.fact,f.market FROM ledger_facts f
        WHERE f.chain_id=t.chain_id AND f.transaction_hash=t.tx_hash
          AND (
            (t.kind='winner' AND f.kind='winner-claimed') OR
            (t.kind='early-bird' AND f.kind='early-bird-claimed') OR
            (t.kind='refund' AND f.kind='refunded') OR
            (t.kind='timeout-bonus' AND f.kind='timeout-claimed') OR
            (t.kind='fees' AND f.kind='fee-claimed') OR
            (t.kind='bond' AND f.kind='bond-claimed') OR
            (t.kind LIKE 'return-listing:%' AND f.kind IN ('order-released','listing-returned'))
          )
        ORDER BY CASE WHEN f.kind='order-released' THEN 0 ELSE 1 END,f.log_index,f.fact_index
        LIMIT 1
      ) matched ON true
      LEFT JOIN public_market_metadata metadata ON metadata.market=matched.market
      WHERE t.chain_id=${this.chainId} AND t.deployment_id=${this.deploymentId}
        AND t.owner=${owner.toLowerCase()} AND t.requires_claim_preference=true
      ORDER BY t.created_at DESC LIMIT 40`;
    const transactions = rows
      .map((row) => {
        const effect = automationEffect(row.kind),
          reorganized =
            row.state === "confirmed" && row.canonical_status === "orphaned";
        return {
          id: row.id,
          kind: row.kind,
          effect,
          state: reorganized ? "unknown" : row.state,
          tx_hash: row.tx_hash,
          created_at: row.created_at,
          context: this.publicContext(row),
          reorganized,
        };
      })
      .filter((row) => ["payout", "asset-return"].includes(row.effect))
      .slice(0, 20);
    // A blocked claims nonce stalls every beneficiary in this deployment. Return
    // only a generic queue reason; never expose another owner's transaction.
    const [queue] = await this
      .sql`SELECT COALESCE(broadcast_at,created_at) AS since FROM automation_transactions
      WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND requires_claim_preference=true
        AND state IN ('broadcasting','unknown') AND COALESCE(broadcast_at,created_at)<now()-interval '120 seconds'
      ORDER BY created_at LIMIT 1`;
    return {
      enabled: await this.enabled(owner),
      reason: queue
        ? "queue_blocked_unknown_transaction"
        : transactions[0]?.reorganized
          ? "rechecking_after_reorg"
          : (status?.reason ?? this.reasonFromLatest(transactions[0])),
      updatedAt: queue?.since ?? status?.updated_at ?? null,
      transactions: transactions.map(({ reorganized: _, ...row }) => row),
    };
  }
  private publicContext(row: {
    fact: unknown | null;
    market_question: string | null;
    market_rules: unknown | null;
  }) {
    if (!row.fact || typeof row.fact !== "object") return undefined;
    const fact = row.fact as Record<string, unknown>,
      text = (key: string) =>
        typeof fact[key] === "string" ? (fact[key] as string) : null,
      market = text("market") as Address | null,
      outcomeId = text("outcomeId"),
      rules =
        row.market_rules && typeof row.market_rules === "object"
          ? (row.market_rules as Record<string, unknown>)
          : null,
      outcomes = Array.isArray(rules?.outcomes) ? rules.outcomes : [],
      outcomeNumber = outcomeId === null ? null : Number(outcomeId),
      outcomeLabel =
        outcomeNumber !== null &&
        Number.isSafeInteger(outcomeNumber) &&
        typeof outcomes[outcomeNumber] === "string"
          ? (outcomes[outcomeNumber] as string)
          : null;
    return {
      market,
      marketQuestion: row.market_question,
      outcomeId,
      outcomeLabel,
      amount: text("amount"),
      units: text("units"),
    };
  }
  private reasonFromLatest(
    transaction:
      | {
          state: string;
          effect: ReturnType<typeof automationEffect>;
          reorganized?: boolean;
        }
      | undefined,
  ): string {
    if (!transaction) return "waiting_for_entitlement";
    if (transaction.reorganized) return "rechecking_after_reorg";
    if (transaction.state === "confirmed")
      return transaction.effect === "payout" ? "received" : "assets_returned";
    if (transaction.state === "reverted") return "transaction_reverted";
    if (["prepared", "broadcasting", "unknown"].includes(transaction.state))
      return "confirming";
    return "waiting_for_entitlement";
  }
}
