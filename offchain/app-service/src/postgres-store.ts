import postgres, { type Sql } from "postgres";
import { createHash } from "node:crypto";
import { z } from "zod";
import { keccak256, type Address, type Hex } from "viem";
import {
  AppError,
  accountSchema,
  operationSchema,
  type AppAccount,
  type Operation,
  type OperationState,
} from "../../app-core/src/contracts.js";
import type { SponsorConfig } from "./config.js";
import { quotaHistoryStart } from "./budget.js";
import {
  assertAccountUnchanged,
  assertQuota,
  type ApplicationStore,
  type ControlChallenge,
  type OperationPatch,
  type StoredOperation,
} from "./store.js";

type OperationRow = {
  record: unknown;
  subject: string;
  idempotency_key: string;
  request_hash: Hex;
};
const fromRow = (r: OperationRow): StoredOperation => ({
  operation: operationSchema.parse(r.record),
  subject: r.subject,
  idempotencyKey: r.idempotency_key,
  requestHash: r.request_hash,
});

/** One database/schema is permanently bound to one environment + deployment manifest. */
export class PostgresApplicationStore implements ApplicationStore {
  private readonly sql: Sql;
  constructor(
    url: string,
    private readonly environmentIdentity: string,
    private readonly trackingFromBlock?: string,
  ) {
    this.sql = postgres(url, {
      max: 5,
      connect_timeout: 5,
      idle_timeout: 20,
      onnotice: () => undefined,
    });
  }
  async ready(): Promise<void> {
    await this
      .sql`INSERT INTO cpredict_environment_identity(singleton,identity) VALUES(true,${this.environmentIdentity}) ON CONFLICT DO NOTHING`;
    const identity = await this.sql<
      { identity: string }[]
    >`SELECT identity FROM cpredict_environment_identity WHERE singleton`;
    if (identity[0]?.identity !== this.environmentIdentity)
      throw new Error("application database belongs to another deployment");
    await this
      .sql`INSERT INTO app_environment(singleton,identity) VALUES(true,${this.environmentIdentity}) ON CONFLICT DO NOTHING`;
    const rows = await this.sql<
      { identity: string }[]
    >`SELECT identity FROM app_environment WHERE singleton=true`;
    if (rows[0]?.identity !== this.environmentIdentity)
      throw new Error("application database belongs to another deployment");
    await this.sql`SELECT id FROM app_operations LIMIT 0`;
    if (this.trackingFromBlock !== undefined) {
      await this.sql`SELECT address FROM ledger_tracked_accounts LIMIT 0`;
      const ledger = await this.sql<
        { identity: string }[]
      >`SELECT identity FROM ledger_environment WHERE singleton`;
      if (ledger[0] && ledger[0].identity !== this.environmentIdentity)
        throw new Error(
          "account tracking ledger belongs to another environment",
        );
    }
  }
  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
  async createChallenge(c: ControlChallenge): Promise<void> {
    await this
      .sql`INSERT INTO app_control_challenges(id,subject,controller,environment,deployment_id,message,expires_at,consumed)
      VALUES(${c.id},${c.subject},${c.controller},${c.environment},${c.deploymentId},${c.message},${c.expiresAt},false)`;
  }
  async challenge(id: string): Promise<ControlChallenge | undefined> {
    const rows = await this.sql<
      {
        id: string;
        subject: string;
        controller: Address;
        environment: string;
        deployment_id: string;
        message: string;
        expires_at: Date;
        consumed: boolean;
      }[]
    >`SELECT * FROM app_control_challenges WHERE id=${id}`;
    const c = rows[0];
    return c
      ? {
          id: c.id,
          subject: c.subject,
          controller: c.controller,
          environment: c.environment,
          deploymentId: c.deployment_id,
          message: c.message,
          expiresAt: c.expires_at.toISOString(),
          consumed: c.consumed,
        }
      : undefined;
  }
  async bindAccount(
    challengeId: string,
    subject: string,
    account: AppAccount,
    now: string,
  ): Promise<AppAccount> {
    return this.sql.begin(async (tx) => {
      const consumed =
        await tx`UPDATE app_control_challenges SET consumed=true WHERE id=${challengeId} AND subject=${subject}
        AND controller=${account.controller} AND environment=${account.environment} AND deployment_id=${account.deploymentId}
        AND NOT consumed AND expires_at > ${now} RETURNING id`;
      if (consumed.length !== 1)
        throw new AppError("challenge_unavailable", 409);
      await tx`INSERT INTO app_accounts(id,environment,deployment_id,controller,address,record) VALUES(${account.id},${account.environment},${account.deploymentId},${account.controller},${account.address},${tx.json(account)}) ON CONFLICT(environment,deployment_id,controller) DO NOTHING`;
      const rows = await tx<
        { record: unknown }[]
      >`SELECT record FROM app_accounts WHERE environment=${account.environment} AND deployment_id=${account.deploymentId} AND controller=${account.controller} FOR UPDATE`;
      const stored = accountSchema.parse(rows[0]?.record);
      assertAccountUnchanged(stored, account);
      await tx`INSERT INTO app_account_subjects(account_id,subject) VALUES(${stored.id},${subject}) ON CONFLICT DO NOTHING`;
      if (this.trackingFromBlock !== undefined)
        await tx`INSERT INTO ledger_tracked_accounts(address,from_block) VALUES(${stored.address.toLowerCase()},${this.trackingFromBlock}) ON CONFLICT DO NOTHING`;
      return stored;
    });
  }
  async accounts(subject: string): Promise<AppAccount[]> {
    const rows = await this.sql<
      { record: unknown }[]
    >`SELECT a.record FROM app_accounts a JOIN app_account_subjects s ON s.account_id=a.id WHERE s.subject=${subject} ORDER BY a.id`;
    return rows.map((r) => accountSchema.parse(r.record));
  }
  async allAccounts(): Promise<AppAccount[]> {
    const rows = await this.sql<
      { record: unknown }[]
    >`SELECT record FROM app_accounts ORDER BY id`;
    return rows.map((r) => accountSchema.parse(r.record));
  }
  async account(id: string, subject: string): Promise<AppAccount | undefined> {
    const rows = await this.sql<
      { record: unknown }[]
    >`SELECT a.record FROM app_accounts a JOIN app_account_subjects s ON s.account_id=a.id WHERE a.id=${id} AND s.subject=${subject}`;
    return rows[0] ? accountSchema.parse(rows[0].record) : undefined;
  }
  async byKey(
    subject: string,
    key: string,
  ): Promise<StoredOperation | undefined> {
    const rows = await this.sql<
      OperationRow[]
    >`SELECT record,subject,idempotency_key,request_hash FROM app_operations WHERE subject=${subject} AND idempotency_key=${key}`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }
  async admit(
    value: StoredOperation,
    limits: SponsorConfig,
  ): Promise<StoredOperation> {
    return this.sql.begin(async (tx) => {
      // Admission serializes quota reservations across all service instances.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${this.environmentIdentity},0))`;
      const prior = await tx<
        OperationRow[]
      >`SELECT record,subject,idempotency_key,request_hash FROM app_operations WHERE subject=${value.subject} AND idempotency_key=${value.idempotencyKey}`;
      if (prior[0]) {
        if (prior[0].request_hash !== value.requestHash)
          throw new AppError("idempotency_conflict", 409);
        return fromRow(prior[0]);
      }
      const o = operationSchema.parse(value.operation);
      const rows = await tx<
        OperationRow[]
      >`SELECT record,subject,idempotency_key,request_hash FROM app_operations
        WHERE created_at >= ${quotaHistoryStart(o.createdAt)}
        OR updated_at >= ${quotaHistoryStart(o.createdAt)}
        OR state IN ('preparing','awaiting-signature','submitted','confirming','unknown')`;
      assertQuota(rows.map(fromRow), value, limits);
      await tx`INSERT INTO app_operations(id,subject,idempotency_key,request_hash,account_id,sender,nonce,call_hash,state,kind,lane,created_at,updated_at,expires_at,max_gas_cost,record)
        VALUES(${o.id},${value.subject},${value.idempotencyKey},${value.requestHash},${o.accountId},${o.account.toLowerCase()},${o.nonce},${keccak256(o.callData)},${o.state},${o.kind},${o.lane},${o.createdAt},${o.updatedAt},${o.expiresAt},${o.maxGasCost},${tx.json(o)})`;
      return value;
    });
  }
  async operation(id: string): Promise<StoredOperation | undefined> {
    const rows = await this.sql<
      OperationRow[]
    >`SELECT record,subject,idempotency_key,request_hash FROM app_operations WHERE id=${id}`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }
  async operations(
    subject: string,
    limit: number,
    before?: string,
  ): Promise<Operation[]> {
    const rows = await this.sql<
      OperationRow[]
    >`SELECT o.record,o.subject,o.idempotency_key,o.request_hash FROM app_operations o JOIN app_account_subjects s ON s.account_id=o.account_id
      WHERE s.subject=${subject} AND (${before ?? null}::uuid IS NULL OR o.id < ${before ?? null}::uuid) ORDER BY o.id DESC LIMIT ${limit}`;
    return rows.map((r) => fromRow(r).operation);
  }
  async pending(limit: number): Promise<StoredOperation[]> {
    const rows = await this.sql<
      OperationRow[]
    >`SELECT record,subject,idempotency_key,request_hash FROM app_operations WHERE state IN ('submitted','confirming','unknown') OR (state IN ('preparing','awaiting-signature') AND expires_at <= now()) OR (state IN ('confirmed','reverted') AND record->>'finality' <> 'finalized') ORDER BY updated_at,id LIMIT ${limit}`;
    return rows.map(fromRow);
  }
  async operationPage(
    subject: string,
    accountId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: Operation[]; nextCursor: string | null }> {
    const filter = createHash("sha256")
      .update(JSON.stringify([this.environmentIdentity, subject, accountId]))
      .digest("hex");
    let parsed:
      | { filter: string; snapshot: string; at: string; id: string }
      | undefined;
    if (cursor) {
      try {
        parsed = z
          .strictObject({
            filter: z.string(),
            snapshot: z.string().regex(/^\d+$/),
            at: z.string().datetime(),
            id: z.string().uuid(),
          })
          .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      } catch {
        throw new AppError("invalid_cursor");
      }
      if (parsed.filter !== filter)
        throw new AppError("cursor_filter_mismatch");
    }
    const snapshot =
      parsed?.snapshot ??
      (
        await this.sql<
          { sequence: string }[]
        >`SELECT coalesce(max(admission_sequence),0)::text AS sequence FROM app_operations`
      )[0]!.sequence;
    const rows = await this.sql<
      OperationRow[]
    >`SELECT o.record,o.subject,o.idempotency_key,o.request_hash FROM app_operations o
      JOIN app_account_subjects s ON s.account_id=o.account_id
      WHERE s.subject=${subject} AND o.account_id=${accountId} AND o.admission_sequence <= ${snapshot}
      AND (${parsed?.at ?? null}::timestamptz IS NULL OR (o.created_at,o.id) < (${parsed?.at ?? null}::timestamptz,${parsed?.id ?? null}::uuid))
      ORDER BY o.created_at DESC,o.id DESC LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit).map((row) => fromRow(row).operation),
      last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                filter,
                snapshot,
                at: last.createdAt,
                id: last.id,
              }),
            ).toString("base64url")
          : null,
    };
  }
  async policyCandidate(
    sender: Address,
    nonce: string,
    callData: Hex,
  ): Promise<StoredOperation | undefined> {
    const rows = await this.sql<
      OperationRow[]
    >`SELECT record,subject,idempotency_key,request_hash FROM app_operations WHERE sender=${sender.toLowerCase()} AND nonce=${nonce} AND call_hash=${keccak256(callData)} AND state IN ('awaiting-signature','submitted','confirming','unknown') ORDER BY created_at DESC LIMIT 1`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }
  async transition(
    id: string,
    from: readonly OperationState[],
    patch: OperationPatch,
  ): Promise<{ changed: boolean; record: StoredOperation }> {
    return this.sql.begin(async (tx) => {
      const rows = await tx<
        OperationRow[]
      >`SELECT record,subject,idempotency_key,request_hash FROM app_operations WHERE id=${id} FOR UPDATE`;
      if (!rows[0]) throw new AppError("operation_not_found", 404);
      const old = fromRow(rows[0]);
      if (!from.includes(old.operation.state))
        return { changed: false, record: old };
      const operation = operationSchema.parse({ ...old.operation, ...patch });
      await tx`UPDATE app_operations SET state=${operation.state},updated_at=${operation.updatedAt},record=${tx.json(operation)} WHERE id=${id}`;
      if (
        Object.entries(patch).some(
          ([key, value]) =>
            key !== "updatedAt" &&
            old.operation[key as keyof Operation] !== value,
        )
      )
        await tx`INSERT INTO app_operation_changes(operation_id,previous_state,current_state,reason,user_operation_hash,transaction_hash,block_hash)
        VALUES(${id},${old.operation.state},${operation.state},${operation.reason},${operation.userOperationHash},${operation.transactionHash},${operation.blockHash})`;
      return { changed: true, record: { ...old, operation } };
    });
  }
  async report(start: string, end: string): Promise<StoredOperation[]> {
    const rows = await this.sql<
      OperationRow[]
    >`SELECT record,subject,idempotency_key,request_hash FROM app_operations WHERE created_at >= ${start} AND created_at < ${end} ORDER BY created_at,id`;
    return rows.map(fromRow);
  }
}
