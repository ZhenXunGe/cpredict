import postgres, { type Sql } from "postgres";
import { createHash } from "node:crypto";
import { z } from "zod";
import { keccak256, type Address, type Hex } from "viem";
import {
  AppError,
  accountSchema,
  operationSchema,
  depositSchema,
  type AppAccount,
  type Operation,
  type OperationState,
  type Deposit,
  type DepositReportQuery,
} from "../../app-core/src/contracts.js";
import type { SponsorConfig } from "./config.js";
import { quotaHistoryStart } from "./budget.js";
import {
  assertAccountUnchanged,
  applyOperationPatch,
  assertQuota,
  assertDepositRegistration,
  depositView,
  type ApplicationStore,
  type ControlChallenge,
  type OperationPatch,
  type StoredOperation,
  type StoredDeposit,
} from "./store.js";

// Extra fields stay in a separate column; old releases can parse record on rollback.
function splitBilling(o: Operation) {
  const {
    gasPayment,
    sponsorshipAttempted,
    gasSettledAt,
    gasReleasedAt,
    ...record
  } = o;
  return {
    record,
    billing: {
      ...(gasPayment === undefined ? {} : { gasPayment }),
      ...(sponsorshipAttempted === undefined ? {} : { sponsorshipAttempted }),
      ...(gasSettledAt === undefined ? {} : { gasSettledAt }),
      ...(gasReleasedAt === undefined ? {} : { gasReleasedAt }),
    },
  };
}

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
type DepositRow = Omit<OperationRow, "record"> & {
  record: unknown;
  operation_record?: unknown;
};
const fromDepositRow = (r: DepositRow, now: string): StoredDeposit => ({
  deposit: depositView(
    depositSchema.parse(r.record),
    r.operation_record ? operationSchema.parse(r.operation_record) : undefined,
    now,
  ),
  subject: r.subject,
  idempotencyKey: r.idempotency_key,
  requestHash: r.request_hash,
});

/** One database/schema is permanently bound to one environment + deployment manifest. */
export class PostgresApplicationStore implements ApplicationStore {
  private readonly sql: Sql;
  private accountingInitialization?: Promise<unknown>;
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
    // A restart may follow an older release that did not record grant attempts.
    // Existing unproven records fail closed; certified cancellations stay free.
    await (this.accountingInitialization ??= this
      .sql`UPDATE app_operations SET billing=jsonb_set(billing,'{sponsorshipAttempted}','true'::jsonb)
      WHERE billing->'sponsorshipAttempted'='false'::jsonb AND billing->>'gasReleasedAt' IS NULL`.then(
      () => undefined,
    ));
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
    >`SELECT record || billing AS record,subject,idempotency_key,request_hash FROM app_operations WHERE subject=${subject} AND idempotency_key=${key}`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }
  async deposit(id: string, now: string): Promise<StoredDeposit | undefined> {
    const rows = await this.sql<
      DepositRow[]
    >`SELECT d.record,d.subject,d.idempotency_key,d.request_hash,(o.record || o.billing) AS operation_record
      FROM app_deposits d LEFT JOIN app_operations o ON o.id=d.operation_id WHERE d.id=${id}`;
    return rows[0] ? fromDepositRow(rows[0], now) : undefined;
  }
  async depositByKey(
    subject: string,
    key: string,
    now: string,
  ): Promise<StoredDeposit | undefined> {
    const rows = await this.sql<
      DepositRow[]
    >`SELECT d.record,d.subject,d.idempotency_key,d.request_hash,(o.record || o.billing) AS operation_record
      FROM app_deposits d LEFT JOIN app_operations o ON o.id=d.operation_id WHERE d.subject=${subject} AND d.idempotency_key=${key}`;
    return rows[0] ? fromDepositRow(rows[0], now) : undefined;
  }
  async createDeposit(value: StoredDeposit): Promise<StoredDeposit> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${this.environmentIdentity},0))`;
      const prior = await tx<
        DepositRow[]
      >`SELECT d.record,d.subject,d.idempotency_key,d.request_hash,(o.record || o.billing) AS operation_record
        FROM app_deposits d LEFT JOIN app_operations o ON o.id=d.operation_id WHERE d.subject=${value.subject} AND d.idempotency_key=${value.idempotencyKey}`;
      if (prior[0]) {
        if (prior[0].request_hash !== value.requestHash)
          throw new AppError("idempotency_conflict", 409);
        return fromDepositRow(prior[0], value.deposit.createdAt);
      }
      const d = value.deposit;
      const pending = await tx<
        { id: string; operation_id: string | null }[]
      >`SELECT d.id,d.operation_id FROM app_deposits d
        LEFT JOIN app_operations o ON o.id=d.operation_id WHERE d.account_id=${d.accountId} AND (
          (d.operation_id IS NULL AND d.state='awaiting-authorization' AND d.expires_at > ${d.createdAt}) OR
          o.state IN ('preparing','awaiting-signature','submitted','confirming','unknown') OR
          (o.state='reverted' AND coalesce(o.record->>'finality','pending') <> 'finalized')
        ) LIMIT 1`;
      if (pending[0])
        throw new AppError(
          "deposit_in_progress",
          409,
          "该账户已有待完成入金，请查询原记录",
          pending[0].operation_id ?? undefined,
        );
      await tx`INSERT INTO app_deposits(id,subject,idempotency_key,request_hash,account_id,token,source,authorization_nonce,created_at,expires_at,state,operation_id,record)
        VALUES(${d.id},${value.subject},${value.idempotencyKey},${value.requestHash},${d.accountId},${d.domain.verifyingContract.toLowerCase()},${d.authorization.from.toLowerCase()},${d.authorization.nonce.toLowerCase()},${d.createdAt},${d.expiresAt},${d.state},NULL,${tx.json(d)})`;
      return value;
    });
  }
  async depositPage(
    subject: string,
    accountId: string,
    now: string,
    limit: number,
    cursor?: string,
    activeOnly = false,
  ): Promise<{ items: Deposit[]; nextCursor: string | null }> {
    return this.readDeposits(
      subject,
      accountId,
      now,
      limit,
      cursor,
      activeOnly,
    );
  }
  async depositReport(query: DepositReportQuery, now: string) {
    return this.readDeposits(
      null,
      query.accountId ?? null,
      now,
      query.limit,
      query.cursor,
      false,
      query,
    );
  }
  private async readDeposits(
    subject: string | null,
    accountId: string | null,
    now: string,
    limit: number,
    cursor?: string,
    activeOnly = false,
    report?: DepositReportQuery,
  ): Promise<{ items: Deposit[]; nextCursor: string | null }> {
    const filter = createHash("sha256")
      .update(
        JSON.stringify([
          this.environmentIdentity,
          subject,
          accountId,
          activeOnly,
          report?.start ?? null,
          report?.end ?? null,
          report?.source ?? null,
          report?.id ?? null,
        ]),
      )
      .digest("hex");
    let before: { filter: string; at: string; id: string } | undefined;
    if (cursor) {
      try {
        before = z
          .strictObject({
            filter: z.string(),
            at: z.string().datetime(),
            id: z.string().uuid(),
          })
          .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
      } catch {
        throw new AppError("invalid_cursor");
      }
      if (before.filter !== filter)
        throw new AppError("cursor_filter_mismatch");
    }
    const rows = await this.sql<
      DepositRow[]
    >`SELECT d.record,d.subject,d.idempotency_key,d.request_hash,(o.record || o.billing) AS operation_record
      FROM app_deposits d LEFT JOIN app_operations o ON o.id=d.operation_id
      WHERE (${subject}::text IS NULL OR d.subject=${subject}) AND (${accountId}::uuid IS NULL OR d.account_id=${accountId})
      AND (${report?.start ?? null}::timestamptz IS NULL OR d.created_at>=${report?.start ?? null}::timestamptz)
      AND (${report?.end ?? null}::timestamptz IS NULL OR d.created_at<${report?.end ?? null}::timestamptz)
      AND (${report?.source?.toLowerCase() ?? null}::text IS NULL OR d.source=${report?.source?.toLowerCase() ?? null})
      AND (${report?.id ?? null}::uuid IS NULL OR d.id=${report?.id ?? null})
      AND (${before?.at ?? null}::timestamptz IS NULL OR (d.created_at,d.id) < (${before?.at ?? null}::timestamptz,${before?.id ?? null}::uuid))
      AND (NOT ${activeOnly} OR (d.operation_id IS NULL AND d.state='awaiting-authorization' AND d.expires_at > ${now})
        OR o.state IN ('preparing','awaiting-signature','submitted','confirming','unknown')
        OR (o.state='reverted' AND coalesce(o.record->>'finality','pending') <> 'finalized'))
      ORDER BY d.created_at DESC,d.id DESC LIMIT ${limit + 1}`;
    const items = rows
        .slice(0, limit)
        .map((r) => fromDepositRow(r, now).deposit),
      last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ filter, at: last.createdAt, id: last.id }),
            ).toString("base64url")
          : null,
    };
  }
  async cancelDeposit(
    id: string,
    subject: string,
    now: string,
  ): Promise<StoredDeposit> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${this.environmentIdentity},0))`;
      const rows = await tx<
        DepositRow[]
      >`SELECT record,subject,idempotency_key,request_hash FROM app_deposits WHERE id=${id} AND subject=${subject} FOR UPDATE`;
      if (!rows[0]) throw new AppError("deposit_not_found", 404);
      const stored = fromDepositRow(rows[0], now),
        d = stored.deposit;
      if (d.operationId)
        throw new AppError(
          "deposit_already_registered",
          409,
          "请查询原入金操作",
          d.operationId,
        );
      if (d.state !== "awaiting-authorization") return stored;
      const deposit = {
        ...d,
        state: "cancelled" as const,
        updatedAt: now,
        reason: "user_cancelled_before_submission",
      };
      await tx`UPDATE app_deposits SET state='cancelled',record=${tx.json(deposit)} WHERE id=${id}`;
      return { ...stored, deposit };
    });
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
      >`SELECT record || billing AS record,subject,idempotency_key,request_hash FROM app_operations WHERE subject=${value.subject} AND idempotency_key=${value.idempotencyKey}`;
      if (prior[0]) {
        if (prior[0].request_hash !== value.requestHash)
          throw new AppError("idempotency_conflict", 409);
        return fromRow(prior[0]);
      }
      const o = operationSchema.parse(value.operation);
      if (o.intent.kind === "deposit-usdc") {
        const deposits = await tx<
          DepositRow[]
        >`SELECT record,subject,idempotency_key,request_hash FROM app_deposits WHERE id=${o.intent.depositId} FOR UPDATE`;
        assertDepositRegistration(
          deposits[0] ? fromDepositRow(deposits[0], o.createdAt) : undefined,
          value,
        );
      }
      const rows = await tx<
        OperationRow[]
      >`SELECT record || billing AS record,subject,idempotency_key,request_hash FROM app_quota_operations
        WHERE created_at >= ${quotaHistoryStart(o.createdAt)}
        OR updated_at >= ${quotaHistoryStart(o.createdAt)}
        OR state IN ('preparing','awaiting-signature','submitted','confirming','unknown')`;
      assertQuota(rows.map(fromRow), value, limits);
      await tx`INSERT INTO app_operations(id,subject,idempotency_key,request_hash,account_id,sender,nonce,call_hash,state,kind,lane,created_at,updated_at,expires_at,max_gas_cost,record,billing)
        VALUES(${o.id},${value.subject},${value.idempotencyKey},${value.requestHash},${o.accountId},${o.account.toLowerCase()},${o.nonce},${keccak256(o.callData)},${o.state},${o.kind},${o.lane},${o.createdAt},${o.updatedAt},${o.expiresAt},${o.maxGasCost},${tx.json(splitBilling(o).record)},${tx.json(splitBilling(o).billing)})`;
      if (o.intent.kind === "deposit-usdc") {
        await tx`UPDATE app_deposits SET operation_id=${o.id},state='awaiting-signature',
          record=record || ${tx.json({ operationId: o.id, state: "awaiting-signature", updatedAt: o.updatedAt })}::jsonb WHERE id=${o.intent.depositId}`;
      }
      return value;
    });
  }
  async operation(id: string): Promise<StoredOperation | undefined> {
    const rows = await this.sql<
      OperationRow[]
    >`SELECT record || billing AS record,subject,idempotency_key,request_hash FROM app_operations WHERE id=${id}`;
    return rows[0] ? fromRow(rows[0]) : undefined;
  }
  async operations(
    subject: string,
    limit: number,
    before?: string,
  ): Promise<Operation[]> {
    const rows = await this.sql<
      OperationRow[]
    >`SELECT o.record || o.billing AS record,o.subject,o.idempotency_key,o.request_hash FROM app_operations o JOIN app_account_subjects s ON s.account_id=o.account_id
      WHERE s.subject=${subject} AND (${before ?? null}::uuid IS NULL OR o.id < ${before ?? null}::uuid) ORDER BY o.id DESC LIMIT ${limit}`;
    return rows.map((r) => fromRow(r).operation);
  }
  async pending(limit: number): Promise<StoredOperation[]> {
    const rows = await this.sql<
      OperationRow[]
    >`SELECT record || billing AS record,subject,idempotency_key,request_hash FROM app_operations WHERE state IN ('submitted','confirming','unknown') OR (state IN ('preparing','awaiting-signature') AND expires_at <= now()) OR (state IN ('confirmed','reverted') AND record->>'finality' <> 'finalized') ORDER BY updated_at,id LIMIT ${limit}`;
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
    >`SELECT o.record || o.billing AS record,o.subject,o.idempotency_key,o.request_hash FROM app_operations o
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
    >`SELECT record || billing AS record,subject,idempotency_key,request_hash FROM app_operations WHERE sender=${sender.toLowerCase()} AND nonce=${nonce} AND call_hash=${keccak256(callData)} AND state IN ('awaiting-signature','submitted','confirming','unknown') ORDER BY created_at DESC LIMIT 1`;
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
      >`SELECT record || billing AS record,subject,idempotency_key,request_hash FROM app_operations WHERE id=${id} FOR UPDATE`;
      if (!rows[0]) throw new AppError("operation_not_found", 404);
      const old = fromRow(rows[0]);
      if (!from.includes(old.operation.state))
        return { changed: false, record: old };
      const operation = operationSchema.parse(
        applyOperationPatch(old.operation, patch),
      );
      await tx`UPDATE app_operations SET state=${operation.state},updated_at=${operation.updatedAt},record=${tx.json(splitBilling(operation).record)},billing=${tx.json(splitBilling(operation).billing)} WHERE id=${id}`;
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
    >`SELECT record || billing AS record,subject,idempotency_key,request_hash FROM app_operations WHERE created_at >= ${start} AND created_at < ${end} ORDER BY created_at,id`;
    return rows.map(fromRow);
  }
}
