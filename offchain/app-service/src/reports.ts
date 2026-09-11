import postgres from "postgres";
import { z } from "zod";
import {
  AppError,
  operationSchema,
  type Environment,
} from "../../app-core/src/contracts.js";
import { financialOrder } from "../../app-core/src/pnl.js";
import { ledgerFactSchema } from "../../app-core/src/ledger-contracts.js";
import { feeCategory } from "../../app-core/src/fees.js";
import {
  opsReportSchema,
  feedbackPageSchema,
  feedbackQuerySchema,
  type FeedbackPage,
  type OpsReport,
  type feedbackSchema,
  type telemetrySchema,
} from "../../app-core/src/report-contracts.js";
import type { SponsorConfig } from "./config.js";
import {
  budgetTotals,
  quotaHistoryStart,
  weeklyBudgetWindow,
  weeklyLaneLimit,
} from "./budget.js";
import type { ApplicationMonitorState } from "./metrics.js";
export interface ReportingStore {
  telemetry(
    input: z.infer<typeof telemetrySchema>,
    subject: string | null,
  ): Promise<void>;
  feedback(
    input: z.infer<typeof feedbackSchema>,
    subject: string,
  ): Promise<void>;
  feedbackPage(
    query: z.infer<typeof feedbackQuerySchema>,
  ): Promise<FeedbackPage>;
  serviceEvent(code: string): Promise<void>;
  report(start: Date, end: Date, now?: Date): Promise<OpsReport>;
}
export class PostgresReports implements ReportingStore {
  private readonly sql;
  constructor(
    url: string,
    readonly environment: Environment,
    readonly sponsor: SponsorConfig | null,
  ) {
    this.sql = postgres(url, {
      max: 3,
      connect_timeout: 5,
      onnotice: () => undefined,
    });
  }
  async close() {
    await this.sql.end({ timeout: 5 });
  }
  private async budgetUsage(db: Pick<postgres.Sql, "unsafe">, now: Date) {
    const rows = await db.unsafe<{ record: unknown }[]>(
      `SELECT record || billing AS record FROM app_quota_operations
       WHERE created_at >= $1 OR updated_at >= $1
       OR state IN ('preparing','awaiting-signature','submitted','confirming','unknown')`,
      [quotaHistoryStart(now.toISOString())],
    );
    return budgetTotals(
      rows.map((r) => operationSchema.parse(r.record)),
      now,
    );
  }
  async telemetry(
    input: z.infer<typeof telemetrySchema>,
    subject: string | null,
  ) {
    const delta = Date.now() - Date.parse(input.occurredAt);
    if (delta < -30000 || delta > 86400000)
      throw new AppError("invalid_event_time");
    await this
      .sql`INSERT INTO app_telemetry(id,event,occurred_at,subject,account_id,session_id) VALUES(${input.id},${input.event},${input.occurredAt},${subject},${input.accountId ?? null},${input.sessionId}) ON CONFLICT DO NOTHING`;
  }
  async feedback(input: z.infer<typeof feedbackSchema>, subject: string) {
    await this
      .sql`INSERT INTO app_feedback(id,subject,account_id,operation_id,message) VALUES(${input.id},${subject},${input.accountId ?? null},${input.operationId ?? null},${input.message}) ON CONFLICT DO NOTHING`;
    const saved = (
      await this.sql<
        {
          subject: string;
          account_id: string | null;
          operation_id: string | null;
          message: string;
        }[]
      >`SELECT subject,account_id,operation_id,message FROM app_feedback WHERE id=${input.id}`
    )[0]!;
    if (
      saved.subject !== subject ||
      saved.account_id !== (input.accountId ?? null) ||
      saved.operation_id !== (input.operationId ?? null) ||
      saved.message !== input.message
    )
      throw new AppError("feedback_idempotency_conflict", 409);
  }
  async serviceEvent(code: string) {
    if (!/^[a-z_]{1,64}$/.test(code)) return;
    await this.sql`INSERT INTO app_service_events(code) VALUES(${code})`;
  }
  async feedbackPage(
    query: z.infer<typeof feedbackQuerySchema>,
  ): Promise<FeedbackPage> {
    const q = feedbackQuerySchema.parse(query);
    const scope = JSON.stringify([
      this.environment.id,
      this.environment.deployment.id,
      q.id ?? null,
      q.operationId ?? null,
    ]);
    const cursorSchema = z.strictObject({
      scope: z.literal(scope),
      snapshot: z.string().datetime(),
      before: z.string().datetime(),
      id: z.string().uuid(),
    });
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (q.cursor) {
      try {
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8")),
        );
      } catch {
        throw new AppError("invalid_cursor", 400);
      }
    }
    // Feedback records are immutable and timestamped by the database. Bind every
    // page to the first query's upper time bound, filters and deployment.
    const snapshotAt = cursor?.snapshot ?? new Date().toISOString();
    const rows = await this.sql<
      {
        id: string;
        account_id: string | null;
        operation_id: string | null;
        message: string;
        received_at: Date;
        received_precise: string;
      }[]
    >`
      SELECT id,account_id,operation_id,message,received_at,
        to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_precise
      FROM app_feedback WHERE received_at<=${snapshotAt}
        ${q.id ? this.sql`AND id=${q.id}` : this.sql``}
        ${q.operationId ? this.sql`AND operation_id=${q.operationId}` : this.sql``}
        ${cursor ? this.sql`AND (received_at,id)<(${cursor.before}::text::timestamptz,${cursor.id}::uuid)` : this.sql``}
      ORDER BY received_at DESC,id DESC LIMIT ${q.limit + 1}`;
    const page = rows.slice(0, q.limit),
      last = page.at(-1);
    return feedbackPageSchema.parse({
      environment: this.environment.id,
      deploymentId: this.environment.deployment.id,
      snapshotAt,
      items: page.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        operationId: row.operation_id,
        message: row.message,
        receivedAt: row.received_at.toISOString(),
      })),
      nextCursor:
        rows.length > q.limit && last
          ? Buffer.from(
              JSON.stringify({
                scope,
                snapshot: snapshotAt,
                before: last.received_precise,
                id: last.id,
              }),
            ).toString("base64url")
          : null,
    });
  }
  async monitor(now = new Date()): Promise<ApplicationMonitorState> {
    const week = weeklyBudgetWindow(now);
    return this.sql.begin(
      "isolation level repeatable read read only",
      async (db) => {
        const [pending] = await db<
          { pending: string; unknown: string; oldest: string }[]
        >`
        SELECT count(*)::text AS pending,count(*) FILTER (WHERE state='unknown')::text AS unknown,
        GREATEST(COALESCE(EXTRACT(EPOCH FROM (${now}::timestamptz-min(created_at))),0),0)::text AS oldest
        FROM app_operations WHERE state IN ('submitted','confirming','unknown')`;
        const [index] = await db<
          { indexed_block: string | null }[]
        >`SELECT indexed_block::text FROM ledger_environment WHERE singleton=true`;
        const reserved = this.sponsor ? await this.budgetUsage(db, now) : [];
        return {
          pending: Number(pending?.pending ?? 0),
          unknown: Number(pending?.unknown ?? 0),
          oldestPendingSeconds: Number(pending?.oldest ?? 0),
          indexedBlock: index?.indexed_block ?? null,
          budget: this.sponsor
            ? (["exposure", "exit"] as const).map((lane) => {
                const cost =
                  reserved.find((r) => r.lane === lane)?.weeklyWei ?? 0n;
                const limit = weeklyLaneLimit(this.sponsor!, lane);
                return {
                  lane,
                  reservedWei: cost.toString(),
                  remainingWei: (limit > cost ? limit - cost : 0n).toString(),
                };
              })
            : [],
        };
      },
    );
  }
  async report(start: Date, end: Date, now = new Date()): Promise<OpsReport> {
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      start >= end ||
      end.getTime() - start.getTime() > 32 * 86400000
    )
      throw new AppError("invalid_report_window");
    return this.sql.begin(
      "isolation level repeatable read read only",
      async (db) => {
        const from = BigInt(Math.floor(start.getTime() / 1000)),
          to = BigInt(Math.floor(end.getTime() / 1000));
        const state = (
          await db<
            {
              indexed_block: string | null;
              block_timestamp: string | null;
              coverage_complete: boolean;
              epoch: string;
            }[]
          >`SELECT e.indexed_block,e.coverage_complete,e.epoch,b.block_timestamp FROM ledger_environment e LEFT JOIN canonical_blocks b ON b.chain_id=${this.environment.deployment.chainId} AND b.block_number=e.indexed_block WHERE singleton`
        )[0];
        const index = state?.indexed_block ?? null;
        const verifiedAccounts = new Set(
          (
            await db<{ address: string }[]>`SELECT address FROM app_accounts`
          ).map((a) => a.address.toLowerCase()),
        );
        const all = (
          await db<
            { fact: unknown }[]
          >`SELECT fact FROM ledger_facts WHERE block_number<=${index ?? "0"} ORDER BY block_number,transaction_index,log_index,fact_index LIMIT 200001`
        ).map((r) => ledgerFactSchema.parse(r.fact));
        if (all.length > 200000)
          throw new AppError("report_capacity_exceeded", 503);
        const facts = all.filter(
            (f) => BigInt(f.timestamp) >= from && BigInt(f.timestamp) < to,
          ),
          active = new Set<string>(),
          claims = new Set<string>(),
          firstTrades = new Map<string, bigint>(),
          firstClaims = new Map<string, bigint>(),
          reinvested = new Set<string>();
        let primary = 0n,
          c2c = 0n,
          protocol = 0n,
          creator = 0n,
          unknownFees = 0n,
          claimed = 0n,
          gas = 0n,
          totalAccrued = 0n,
          totalClaimed = 0n;
        for (const f of [...all].sort(financialOrder)) {
          if (f.kind === "fee-accrued") totalAccrued += BigInt(f.amount ?? "0");
          if (f.kind === "fee-claimed") totalClaimed += BigInt(f.amount ?? "0");
          const owner = f.owner?.toLowerCase();
          if (!owner || !verifiedAccounts.has(owner)) continue;
          const time = BigInt(f.timestamp);
          if (
            [
              "winner-claimed",
              "early-bird-claimed",
              "refunded",
              "timeout-claimed",
            ].includes(f.kind) &&
            !firstClaims.has(owner)
          )
            firstClaims.set(owner, time);
          if (f.kind === "primary-buy" || f.kind === "listing-filled") {
            if (!firstTrades.has(owner)) firstTrades.set(owner, time);
            const prior = firstClaims.get(owner);
            if (
              prior !== undefined &&
              prior <= time &&
              time >= from &&
              time < to
            )
              reinvested.add(owner);
          }
        }
        for (const f of facts) {
          const amount = BigInt(f.amount ?? "0");
          if (f.kind === "primary-buy") {
            primary += amount;
            if (f.owner) active.add(f.owner.toLowerCase());
          }
          if (f.kind === "listing-filled") {
            c2c += amount;
            if (f.owner) active.add(f.owner.toLowerCase());
            if (f.counterparty) active.add(f.counterparty.toLowerCase());
          }
          if (
            [
              "winner-claimed",
              "early-bird-claimed",
              "refunded",
              "timeout-claimed",
            ].includes(f.kind) &&
            f.owner
          )
            if (verifiedAccounts.has(f.owner.toLowerCase()))
              claims.add(f.owner.toLowerCase());
          if (f.kind === "fee-accrued") {
            const category = feeCategory(f.extra.feeKind);
            if (category === "creator") creator += amount;
            else if (category === "protocol") protocol += amount;
            else unknownFees += amount;
          }
          if (f.kind === "fee-claimed") claimed += amount;
          if (f.kind === "user-operation") gas += amount;
        }
        const telemetry = (
          await db<
            { visits: string; logins: string; ready: string }[]
          >`SELECT count(DISTINCT session_id) FILTER(WHERE event='visit')::text AS visits,count(DISTINCT subject) FILTER(WHERE event='login')::text AS logins,count(DISTINCT account_id) FILTER(WHERE event='account-ready')::text AS ready FROM app_telemetry WHERE occurred_at>=${start} AND occurred_at<${end}`
        )[0]!;
        const registered = (
          await db<
            { count: string }[]
          >`SELECT count(*)::text AS count FROM app_operations WHERE created_at>=${start} AND created_at<${end}`
        )[0]!;
        const changes = (
          await db<
            { unknown: string }[]
          >`SELECT count(DISTINCT operation_id) FILTER(WHERE current_state='unknown')::text AS unknown FROM app_operation_changes WHERE at>=${start} AND at<${end}`
        )[0]!;
        const pending = (
          await db<
            { count: string }[]
          >`SELECT count(*)::text AS count FROM app_operations WHERE state IN ('submitted','unknown','confirming')`
        )[0]!;
        const midnight = new Date(
            now.toISOString().slice(0, 10) + "T00:00:00.000Z",
          ),
          reset = new Date(midnight.getTime() + 86400000).toISOString();
        const budgets = this.sponsor ? await this.budgetUsage(db, now) : [];
        const week = weeklyBudgetWindow(now);
        const invoices = await db<
          {
            reference: string;
            starts_at: Date;
            ends_at: Date;
            amount: string;
            currency: string;
          }[]
        >`SELECT * FROM app_provider_invoice_lines WHERE starts_at<${end} AND ends_at>${start} ORDER BY starts_at,reference LIMIT 100`;
        const events = await db<
          { code: string; count: string }[]
        >`SELECT code,count(*)::text AS count FROM app_service_events WHERE occurred_at>=${start} AND occurred_at<${end} GROUP BY code`;
        return opsReportSchema.parse({
          environment: this.environment.id,
          deploymentId: this.environment.deployment.id,
          window: {
            start: start.toISOString(),
            end: end.toISOString(),
            timeZone: "Asia/Shanghai",
            bounds: "[start,end)",
          },
          generatedAt: now.toISOString(),
          data: {
            indexedBlock: index,
            indexedTimestamp: state?.block_timestamp ?? null,
            coverageComplete: state?.coverage_complete ?? false,
            epoch: state?.epoch ?? null,
          },
          funnel: {
            visitingSessions: Number(telemetry.visits),
            loginSubjects: Number(telemetry.logins),
            readyAccounts: Number(telemetry.ready),
            firstSuccessfulTradingAccounts: [...firstTrades.values()].filter(
              (t) => t >= from && t < to,
            ).length,
            claimingAccounts: claims.size,
            reinvestingAccounts: reinvested.size,
          },
          operations: {
            registered: Number(registered.count),
            confirmed: facts.filter(
              (f) => f.kind === "user-operation" && f.extra.success === true,
            ).length,
            reverted: facts.filter(
              (f) => f.kind === "user-operation" && f.extra.success === false,
            ).length,
            unknown: Number(changes.unknown),
            pending: Number(pending.count),
          },
          trading: {
            activeAccounts: [...active].filter((a) => verifiedAccounts.has(a))
              .length,
            activeAddresses: active.size,
            primaryPayment: primary.toString(),
            c2cVolume: c2c.toString(),
          },
          fees: {
            protocolAccrued: protocol.toString(),
            creatorAccrued: creator.toString(),
            unknownAccrued: unknownFees.toString(),
            claimed: claimed.toString(),
            claimable:
              state?.coverage_complete && totalAccrued >= totalClaimed
                ? (totalAccrued - totalClaimed).toString()
                : null,
            asOfBlock: index,
          },
          gas: {
            userOperationActualWei: gas.toString(),
            providerInvoices: invoices.map((i) => ({
              reference: i.reference,
              start: i.starts_at.toISOString(),
              end: i.ends_at.toISOString(),
              amount: i.amount,
              currency: i.currency,
            })),
            providerBillingStatus: invoices.length ? "imported" : "unavailable",
          },
          budgets: this.sponsor
            ? (["exposure", "exit"] as const).map((lane) => {
                const used = budgets.find((b) => b.lane === lane),
                  cap = this.sponsor![lane],
                  cost = used?.dailyWei ?? 0n,
                  remaining = BigInt(cap.projectWei) - cost;
                return {
                  lane,
                  reservedWei: cost.toString(),
                  remainingWei: (remaining > 0n ? remaining : 0n).toString(),
                  operations: used?.dailyOperations ?? 0,
                  remainingOperations: Math.max(
                    0,
                    cap.projectOperations - (used?.dailyOperations ?? 0),
                  ),
                  resetsAt: reset,
                };
              })
            : [],
          weeklyBudget: this.sponsor
            ? {
                start: week.start.toISOString(),
                end: week.end.toISOString(),
                timeZone: "Asia/Shanghai",
                weekStartsOn: "monday",
                projectLimitWei: this.sponsor.weekly.projectWei,
                lanes: (["exposure", "exit"] as const).map((lane) => {
                  const cost =
                    budgets.find((b) => b.lane === lane)?.weeklyWei ?? 0n;
                  const limit = weeklyLaneLimit(this.sponsor!, lane);
                  return {
                    lane,
                    limitWei: limit.toString(),
                    reservedWei: cost.toString(),
                    remainingWei: (limit > cost ? limit - cost : 0n).toString(),
                  };
                }),
              }
            : null,
          services: {
            rpc: "unknown",
            chainHead: null,
            indexDelayBlocks: null,
            events: Object.fromEntries(
              events.map((e) => [e.code, Number(e.count)]),
            ),
            providerHardLimitUsd: this.sponsor?.providerHardLimitUsd ?? null,
            providerHardLimitWei: this.sponsor?.providerHardLimitWei ?? null,
            providerHardLimitPeriodSeconds:
              this.sponsor?.providerHardLimitPeriodSeconds ?? null,
            providerSpendUsd: null,
            providerPolicyVerified: false,
          },
          notes: [
            "访问与登录为客户端事件上报，分别去重会话和已认证登录主体；不等于真实人数。",
            "链上金额按事件发生时间归属；待恢复积压、余额和预算为查询时快照。",
            "UserOperation 的 actualGasCost 逐项计入；未将整笔 Bundler 交易费用重复分摊。",
            "供应商账单按原计费期间列出，不分摊成当日费用；未导入时显示未知。",
            "每日防滥用额度按 UTC 重置；周总额按 Asia/Shanghai 周一 00:00 重置，两者同时生效。",
            "周预算按每笔最大 Gas 预留；跨周未决操作与本周恢复的旧操作继续占用，不因结果未知释放额度。",
            "供应商硬上限、窗口起点和实际账单需在控制台另行核对；ETH Gas 额度不等于美元账单上限。",
          ],
        });
      },
    );
  }
}
