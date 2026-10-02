import { randomUUID } from "node:crypto";
import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import type {
  AutomaticAction,
  AutomationChain,
  AutomationRecord,
  PreparedAutomation,
} from "./automatic-claims.js";
import type { PostgresAutomaticStore } from "./automatic-store.js";
import {
  FinalValidationError,
  submissionFailure,
} from "./automatic-diagnostics.js";

export interface RecoveryRecord extends PreparedAutomation {
  id: string;
  transactionId: string;
  originalHash: Hex;
  mode: "automatic" | "manual";
  state: "prepared" | "broadcasting" | "unknown" | "confirmed" | "abandoned";
}
export interface RecoveryStore {
  enabled(owner: Address): Promise<boolean>;
  spentToday(excludeId?: string): Promise<bigint>;
  saveRecovery(
    tx: AutomationRecord,
    replacement: PreparedAutomation,
    mode: "automatic" | "manual",
    authorizationRef?: string,
  ): Promise<RecoveryRecord>;
  startRecovery(
    tx: AutomationRecord,
    recovery: RecoveryRecord,
    provider: string,
  ): Promise<boolean>;
  recoverySubmitted(
    recovery: RecoveryRecord,
    provider: string,
    failure?: ReturnType<typeof submissionFailure>,
  ): Promise<void>;
  recoveryCheck(
    tx: AutomationRecord,
    failure: ReturnType<typeof submissionFailure>,
  ): Promise<void>;
}
export interface RecoveryChain extends AutomationChain {
  prepareRecovery(tx: AutomationRecord): Promise<PreparedAutomation>;
  validate(tx: AutomationRecord): Promise<void>;
}
export class RecoveryStopped extends Error {
  constructor(
    readonly reason:
      | "rpc_unavailable"
      | "evidence_conflict"
      | "transaction_present"
      | "nonce_changed"
      | "owner_opted_out"
      | "no_entitlement"
      | "budget_exceeded"
      | "lane_busy"
      | "approval_mismatch"
      | "already_attempted",
  ) {
    super(`recovery_${reason}`);
  }
}

/** Absence alone is not permission. Require three matching chain/nonce views and
 * a common canonical anchor; unavailable nodes never count as an absence vote. */
export class RecoveryQuorum {
  constructor(
    readonly nodes: readonly { name: string; client: PublicClient }[],
    readonly chainId: number,
    readonly signer: Address,
  ) {}
  async verify(hashes: readonly Hex[], nonce: bigint): Promise<void> {
    const votes: Array<{ client: PublicClient; head: bigint }> = [];
    for (const node of this.nodes) {
      let vote: {
        chain: number;
        head: bigint;
        latest: number;
        pending: number;
        present: boolean;
      };
      try {
        const [chain, head, latest, pending, ...transactions] =
          await Promise.all([
            node.client.getChainId(),
            node.client.getBlockNumber(),
            node.client.getTransactionCount({
              address: this.signer,
              blockTag: "latest",
            }),
            node.client.getTransactionCount({
              address: this.signer,
              blockTag: "pending",
            }),
            ...hashes.flatMap((hash) => [
              node.client.request({
                method: "eth_getTransactionReceipt",
                params: [hash],
              }),
              node.client.request({
                method: "eth_getTransactionByHash",
                params: [hash],
              }),
            ]),
          ]);
        vote = {
          chain,
          head,
          latest,
          pending,
          present: transactions.some((t) => t !== null),
        };
      } catch {
        continue;
      }
      if (vote.chain !== this.chainId)
        throw new RecoveryStopped("evidence_conflict");
      if (vote.present) throw new RecoveryStopped("transaction_present");
      if (BigInt(vote.latest) !== nonce || BigInt(vote.pending) !== nonce)
        throw new RecoveryStopped("nonce_changed");
      votes.push({ client: node.client, head: vote.head });
      if (votes.length === 3) break;
    }
    if (votes.length < 3) throw new RecoveryStopped("rpc_unavailable");
    const heads = votes.map((v) => v.head);
    const low = heads.reduce((a, b) => (a < b ? a : b));
    const high = heads.reduce((a, b) => (a > b ? a : b));
    if (high - low > 120n || low < 2n)
      throw new RecoveryStopped("evidence_conflict");
    try {
      const anchors = await Promise.all(
        votes.map((v) => v.client.getBlock({ blockNumber: low - 2n })),
      );
      if (
        !anchors[0]?.hash ||
        anchors.some(
          (a) => a.number !== low - 2n || a.hash !== anchors[0]?.hash,
        )
      )
        throw new RecoveryStopped("evidence_conflict");
    } catch (error) {
      if (error instanceof RecoveryStopped) throw error;
      throw new RecoveryStopped("rpc_unavailable");
    }
  }
}

export class AutomationRecovery {
  constructor(
    readonly store: RecoveryStore,
    readonly chain: RecoveryChain,
    readonly quorum: RecoveryQuorum,
    readonly budget: bigint,
    readonly cap: bigint,
  ) {}
  private async admission(
    tx: AutomationRecord,
    replacement?: PreparedAutomation,
  ): Promise<void> {
    if (tx.requiresClaimPreference && !(await this.store.enabled(tx.owner)))
      throw new RecoveryStopped("owner_opted_out");
    if (!(await this.chain.eligible(tx)))
      throw new RecoveryStopped("no_entitlement");
    if (replacement) {
      if (replacement.nonce !== tx.nonce)
        throw new FinalValidationError("intent_mismatch");
      if (
        replacement.maximumCost > this.cap ||
        (await this.store.spentToday(tx.id)) + replacement.maximumCost >
          this.budget ||
        (await this.chain.balance()) < replacement.maximumCost
      )
        throw new RecoveryStopped("budget_exceeded");
    }
  }
  /** Caller holds the same chain/signer advisory lock as the normal worker. */
  async prepare(
    tx: AutomationRecord,
    mode: "automatic" | "manual",
    authorizationRef?: string,
  ): Promise<RecoveryRecord> {
    if (!["unknown", "broadcasting"].includes(tx.state))
      throw new RecoveryStopped("already_attempted");
    await this.quorum.verify([tx.hash], tx.nonce);
    await this.admission(tx);
    if (this.chain.submissionReady && !(await this.chain.submissionReady()))
      throw new RecoveryStopped("rpc_unavailable");
    const replacement = await this.chain.prepareRecovery(tx);
    await this.admission(tx, replacement);
    await this.chain.validate({ ...tx, ...replacement });
    return this.store.saveRecovery(tx, replacement, mode, authorizationRef);
  }
  async broadcast(
    tx: AutomationRecord,
    recovery: RecoveryRecord,
  ): Promise<void> {
    if (
      recovery.state !== "prepared" ||
      recovery.originalHash !== tx.hash ||
      recovery.transactionId !== tx.id
    )
      throw new RecoveryStopped("already_attempted");
    await this.quorum.verify([tx.hash, recovery.hash], tx.nonce);
    await this.admission(tx, recovery);
    if (this.chain.submissionReady && !(await this.chain.submissionReady()))
      throw new RecoveryStopped("rpc_unavailable");
    await this.chain.validate({
      ...tx,
      raw: recovery.raw,
      hash: recovery.hash,
      nonce: recovery.nonce,
      maximumCost: recovery.maximumCost,
    });
    await this.admission(tx, recovery);
    const provider = this.chain.submissionProvider?.() ?? "writer-unknown";
    if (!(await this.store.startRecovery(tx, recovery, provider)))
      throw new RecoveryStopped("already_attempted");
    let failure: ReturnType<typeof submissionFailure> | undefined;
    try {
      const hash = await this.chain.send(recovery.raw);
      if (hash !== recovery.hash)
        throw new FinalValidationError("hash_mismatch");
    } catch (error) {
      failure = submissionFailure(error);
    }
    // Broadcast may have succeeded even when no response arrived. Only query both
    // registered hashes from now on; NEVER recreate this replacement or another nonce.
    await this.store.recoverySubmitted(recovery, provider, failure);
  }
  async automatic(tx: AutomationRecord): Promise<void> {
    try {
      const recovery = await this.prepare(tx, "automatic");
      await this.broadcast(tx, recovery);
    } catch (error) {
      const failure =
        error instanceof RecoveryStopped
          ? { reason: error.reason }
          : submissionFailure(error);
      await this.store.recoveryCheck(tx, failure);
    }
  }
}

export class PostgresRecoveryStore implements RecoveryStore {
  constructor(readonly store: PostgresAutomaticStore) {}
  enabled(owner: Address) {
    return this.store.enabled(owner);
  }
  spentToday(excludeId?: string) {
    return this.store.spentToday(excludeId);
  }
  async saveRecovery(
    tx: AutomationRecord,
    p: PreparedAutomation,
    mode: "automatic" | "manual",
    authorizationRef?: string,
  ): Promise<RecoveryRecord> {
    if (
      p.nonce !== tx.nonce ||
      p.hash === tx.hash ||
      keccak256(p.raw) !== p.hash ||
      p.maximumCost <= 0n
    )
      throw new RecoveryStopped("approval_mismatch");
    if (mode === "manual" && !authorizationRef)
      throw new RecoveryStopped("approval_mismatch");
    const id = randomUUID();
    await this.store.sql.begin(async (db) => {
      const [current] =
        await db`SELECT * FROM automation_transactions WHERE id=${tx.id} FOR UPDATE`;
      if (
        !current ||
        Number(current.chain_id) !== this.store.chainId ||
        current.deployment_id !== this.store.deploymentId ||
        current.signer !== this.store.signer.toLowerCase() ||
        current.tx_hash !== tx.hash ||
        !["broadcasting", "unknown"].includes(current.state) ||
        String(current.nonce) !== tx.nonce.toString() ||
        current.raw_transaction !== tx.raw ||
        (mode === "automatic" &&
          (current.recovery_manual_required ||
            Date.now() -
              new Date(
                current.first_broadcast_at ??
                  current.broadcast_at ??
                  current.created_at,
              ).getTime() <
              120000))
      )
        throw new RecoveryStopped("already_attempted");
      const existing =
        await db`SELECT id FROM automation_recoveries WHERE transaction_id=${tx.id}`;
      if (existing.length) throw new RecoveryStopped("already_attempted");
      await db`INSERT INTO automation_recoveries(id,transaction_id,original_hash,replacement_hash,nonce,original_raw,replacement_raw,reserved_wei,mode,authorization_ref,state) VALUES(${id},${tx.id},${tx.hash},${p.hash},${tx.nonce.toString()},${tx.raw},${p.raw},${p.maximumCost.toString()},${mode},${authorizationRef ?? null},'prepared')`;
    });
    return {
      ...p,
      id,
      transactionId: tx.id,
      originalHash: tx.hash,
      mode,
      state: "prepared",
    };
  }
  async startRecovery(
    tx: AutomationRecord,
    r: RecoveryRecord,
    provider: string,
  ): Promise<boolean> {
    return this.store.sql.begin(async (db) => {
      const [current] =
        await db`SELECT * FROM automation_transactions WHERE id=${tx.id} FOR UPDATE`;
      if (
        !current ||
        Number(current.chain_id) !== this.store.chainId ||
        current.deployment_id !== this.store.deploymentId ||
        current.signer !== this.store.signer.toLowerCase() ||
        current.tx_hash !== tx.hash ||
        String(current.nonce) !== r.nonce.toString() ||
        !["broadcasting", "unknown"].includes(current.state)
      )
        return false;
      const changed =
        await db`UPDATE automation_recoveries SET state='broadcasting',broadcast_at=now(),updated_at=now() WHERE id=${r.id} AND transaction_id=${tx.id} AND original_hash=${tx.hash} AND replacement_hash=${r.hash} AND replacement_raw=${r.raw} AND reserved_wei=${r.maximumCost.toString()} AND nonce=${r.nonce.toString()} AND state='prepared' RETURNING id`;
      if (!changed.length) return false;
      await db`UPDATE automation_transactions SET tx_hash=${r.hash},raw_transaction=${r.raw},reserved_wei=${r.maximumCost.toString()},state='unknown',first_broadcast_at=COALESCE(first_broadcast_at,broadcast_at,created_at),broadcast_at=now(),updated_at=now() WHERE id=${tx.id}`;
      await db`INSERT INTO automation_attempts(transaction_id,tx_hash,phase,outcome,provider) VALUES(${tx.id},${r.hash},'broadcast','started',${provider})`;
      return true;
    });
  }
  async recoverySubmitted(
    r: RecoveryRecord,
    provider: string,
    failure?: ReturnType<typeof submissionFailure>,
  ): Promise<void> {
    await this.store.sql.begin(async (db) => {
      await db`UPDATE automation_recoveries SET state='unknown',updated_at=now() WHERE id=${r.id} AND state='broadcasting'`;
      await db`UPDATE automation_attempts SET outcome=${failure ? "unknown" : "accepted"},provider=${provider},reason=${failure?.reason ?? null},rpc_code=${failure?.rpcCode ?? null},updated_at=now() WHERE transaction_id=${r.transactionId} AND tx_hash=${r.hash} AND phase='broadcast'`;
    });
  }
  async recoveryCheck(
    tx: AutomationRecord,
    failure: ReturnType<typeof submissionFailure>,
  ): Promise<void> {
    if (
      ![
        "rpc_unavailable",
        "timeout",
        "rate_limit",
        "quota",
        "writer_unavailable",
        "transaction_present",
        "owner_opted_out",
        "budget_exceeded",
      ].includes(failure.reason)
    )
      await this.store
        .sql`UPDATE automation_transactions SET recovery_manual_required=true WHERE id=${tx.id}`;
    await this.store
      .sql`INSERT INTO automation_attempts(transaction_id,tx_hash,phase,outcome,provider,reason,rpc_code) VALUES(${tx.id},${tx.hash},'recovery-check','rejected','quorum',${failure.reason},${failure.rpcCode ?? null})`;
  }
}
