import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { Address, Hex } from "viem";
import type {
  AutomaticAction,
  PreparedAutomation,
  AutomationRecord,
  AutomationReceipt,
  AutomationStore,
} from "./automatic-claims.js";
export class PostgresAutomaticStore implements AutomationStore {
  constructor(
    readonly sql: Sql,
    readonly chainId: number,
    readonly deploymentId: string,
    readonly signer: Address,
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
    await this
      .sql`UPDATE automation_transactions SET state=${r.status === "success" ? "confirmed" : "reverted"},receipt_block=${r.blockNumber.toString()},receipt_hash=${r.blockHash},raw_transaction=NULL,updated_at=now() WHERE id=${id}`;
  }
  async spentToday(excludeId?: string): Promise<bigint> {
    const [r] = await this
      .sql`SELECT COALESCE(sum(reserved_wei),0)::text AS amount FROM automation_transactions
      WHERE chain_id=${this.chainId} AND signer=${this.signer.toLowerCase()} AND (${excludeId ?? null}::uuid IS NULL OR id<>${excludeId ?? null}::uuid) AND COALESCE(broadcast_at,created_at)>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
    return BigInt(r?.amount ?? "0");
  }
  async status(owner: Address, reason: string): Promise<void> {
    await this
      .sql`INSERT INTO automation_status(chain_id,owner,reason) VALUES(${this.chainId},${owner.toLowerCase()},${reason})
      ON CONFLICT(chain_id,owner) DO UPDATE SET reason=EXCLUDED.reason,updated_at=now()`;
  }
  async blockedCounts() {
    return this
      .sql`SELECT reason,count(*)::int AS count FROM automation_status WHERE chain_id=${this.chainId} AND reason IN ('daily_gas_budget_exhausted','gas_balance_insufficient','retry_after_chain_check','checking_original_transaction','transaction_reverted') GROUP BY reason`;
  }
  async oldestPendingSeconds(): Promise<number> {
    const [r] = await this.sql`SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(COALESCE(broadcast_at,created_at))),0)::float AS age
      FROM automation_transactions WHERE chain_id=${this.chainId} AND signer=${this.signer.toLowerCase()} AND state IN ('prepared','broadcasting','unknown')`;
    return Number(r?.age ?? 0);
  }
  async publicStatus(owner: Address) {
    const [status] = await this
      .sql`SELECT reason,updated_at FROM automation_status WHERE chain_id=${this.chainId} AND owner=${owner.toLowerCase()}`;
    const transactions = await this
      .sql`SELECT id,kind,state,tx_hash,created_at FROM automation_transactions WHERE chain_id=${this.chainId} AND owner=${owner.toLowerCase()} ORDER BY created_at DESC LIMIT 20`;
    // A blocked claims nonce stalls every beneficiary in this deployment. Return
    // only a generic queue reason; never expose another owner's transaction.
    const [queue] = await this.sql`SELECT COALESCE(broadcast_at,created_at) AS since FROM automation_transactions
      WHERE chain_id=${this.chainId} AND deployment_id=${this.deploymentId} AND requires_claim_preference=true
        AND state IN ('broadcasting','unknown') AND COALESCE(broadcast_at,created_at)<now()-interval '120 seconds'
      ORDER BY created_at LIMIT 1`;
    return {
      enabled: await this.enabled(owner),
      reason: queue ? "queue_blocked_unknown_transaction" : status?.reason ?? "waiting_for_entitlement",
      updatedAt: queue?.since ?? status?.updated_at ?? null,
      transactions,
    };
  }
}
