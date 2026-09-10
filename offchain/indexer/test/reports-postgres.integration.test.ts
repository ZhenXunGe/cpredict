import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { z } from "zod";
import { keccak256, stringToHex } from "viem";
import {
  A,
  H,
  env,
  appAccount,
  operation,
} from "../../app-core/test/fixtures.js";
import { sponsorConfigSchema } from "../../app-service/src/config.js";
import { PostgresApplicationStore } from "../../app-service/src/postgres-store.js";
import { environmentKey } from "../../app-core/src/contracts.js";
import { PostgresEventStore } from "../src/postgres-store.js";
import { Leaderboards } from "../src/leaderboards.js";
import { activateLedger } from "../src/reconciliation.js";
import { PostgresReports } from "../../app-service/src/reports.js";
import {
  block,
  createMarket,
  purchase,
  raw,
  trader,
  vault,
} from "./financial-fixtures.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("report and publication PostgreSQL boundaries", () => {
  const schema = `cpredict_reports_${process.pid}_${Date.now()}`;
  let admin: ReturnType<typeof postgres>,
    sql: ReturnType<typeof postgres>,
    store: PostgresEventStore,
    reports: PostgresReports,
    boards: Leaderboards;
  const digest = "b".repeat(64);
  async function approvedSnapshot(passed = true) {
    const snapshot = await store.financial!.snapshot(),
      id = randomUUID();
    await sql`INSERT INTO ledger_reconciliations(id,report,passed,epoch,block_number,block_hash,code_digest) VALUES(${id},${sql.json({ snapshot })},${passed},${snapshot.epoch},${snapshot.blockNumber},${snapshot.blockHash},${digest})`;
    return id;
  }
  beforeAll(async () => {
    if (!url) throw new Error("TEST_DATABASE_URL required");
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    sql = postgres(scoped.toString(), { max: 1, onnotice: () => undefined });
    for (const name of [
      "001_indexer.sql",
      "002_settlement_evidence.sql",
      "003_read_api_indexes.sql",
      "004_market_metadata.sql",
      "005_activity_catalog.sql",
      "006_financial_facts.sql",
      "007_legacy_deployment.sql",
    ])
      await sql.unsafe(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    await sql.unsafe(
      await readFile(
        new URL(
          "../../app-service/migrations/001_application.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    store = new PostgresEventStore(scoped.toString(), 3, env);
    await store.ready();
    reports = new PostgresReports(scoped.toString(), env, null);
    boards = new Leaderboards(store.financial!);
    await sql`INSERT INTO app_accounts(id,environment,deployment_id,controller,address,record) VALUES(${appAccount.id},${env.id},${env.deployment.id},${appAccount.controller},${appAccount.address},${sql.json(appAccount)})`;
    await sql`INSERT INTO ledger_tracked_accounts(address,from_block) VALUES(${trader.toLowerCase()},1)`;
    await store.applyBatch(createMarket(), [block(1)], block(1));
    const fee = (n: number, amount: bigint) =>
      raw(
        "FeeAccrued",
        env.deployment.feeVault,
        {
          beneficiary: trader,
          source: vault,
          feeKind: keccak256(stringToHex("CREATOR_RAKE")),
          feeReference: H(n),
          amount,
        },
        n,
        3,
      );
    await store.applyBatch([...purchase(), fee(2, 5n)], [block(2)], block(2));
    await store.applyBatch([fee(3, 7n)], [block(3)], block(3));
    await store.financial!.accountScanned([trader], 1n, 3n, H(3));
  });
  afterAll(async () => {
    await reports?.close();
    await store?.close();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  it("only activates a passed reconciliation for the exact code, epoch and database snapshot", async () => {
    await expect(
      activateLedger(store.financial!, await approvedSnapshot(false), digest),
    ).rejects.toMatchObject({ code: "reconciliation_required" });
    const id = await approvedSnapshot();
    await expect(
      activateLedger(store.financial!, id, "c".repeat(64)),
    ).rejects.toMatchObject({ code: "reconciliation_required" });
    await store.applyBatch([], [block(4)], block(4));
    await store.financial!.accountScanned([trader], 4n, 4n, H(4));
    await expect(
      activateLedger(store.financial!, id, digest),
    ).rejects.toMatchObject({ code: "reconciliation_snapshot_changed" });
    await activateLedger(store.financial!, await approvedSnapshot(), digest);
    expect((await store.financial!.snapshot()).status).toBe("active");
  });
  it("freezes a period end, preserves old versions and exposes replay corrections", async () => {
    const period = {
      id: "first",
      startsAt: "180",
      endsAt: "280",
      publishedAt: "50",
      markets: [{ market: vault, startsAt: "180" }],
    };
    await boards.register(period, new Date(50000));
    await expect(
      boards.register(
        { ...period, id: "late", publishedAt: "190" },
        new Date(190000),
      ),
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(
      boards.register({ ...period, id: "backdated" }, new Date(190000)),
    ).rejects.toMatchObject({ code: "roster_must_precede_scoring" });
    await boards.publish("first");
    const first = await boards.page({ period: "first" });
    expect(first.status).toBe("available");
    expect(first.snapshot?.data.blockNumber).toBe("2");
    expect(first.items[0]?.realizedNet).toBe("0");
    await store.applyBatch([], [block(5)], block(5));
    await store.financial!.accountScanned([trader], 5n, 5n, H(5));
    await boards.publish("first");
    expect((await boards.page({ period: "first" })).snapshot?.version).toBe(1);
    await store.replayFinancial(1n, 5n);
    expect((await boards.page({ period: "first" })).status).toBe(
      "correction-pending",
    );
    await activateLedger(store.financial!, await approvedSnapshot(), digest);
    await boards.publish("first");
    expect((await boards.page({ period: "first" })).snapshot).toMatchObject({
      version: 2,
      correction: expect.any(String),
    });
    expect(await sql`SELECT id FROM leaderboard_snapshots`).toHaveLength(2);
    expect(
      (
        await sql`SELECT corrected_by FROM leaderboard_snapshots WHERE id=${first.snapshot!.id}`
      )[0]!.corrected_by,
    ).toBeTruthy();
  });
  it("uses event-time half-open windows, separates creator fees and keeps billing intervals intact", async () => {
    const session = randomUUID();
    for (const [at, event] of [
      [150, "visit"],
      [200, "visit"],
      [300, "login"],
    ] as const)
      await sql`INSERT INTO app_telemetry(id,event,occurred_at,subject,session_id) VALUES(${randomUUID()},${event},${new Date(at * 1000)},'did:privy:fixture',${session})`;
    await sql`INSERT INTO app_provider_invoice_lines(reference,starts_at,ends_at,amount,currency) VALUES('original-month',${new Date(0)},${new Date(86400000)},1.2500,'USD')`;
    const r = await reports.report(new Date(150000), new Date(300000));
    expect(r.window.bounds).toBe("[start,end)");
    expect(r.trading).toMatchObject({
      primaryPayment: "100",
      activeAccounts: 1,
      activeAddresses: 1,
    });
    expect(r.fees).toMatchObject({
      creatorAccrued: "5",
      protocolAccrued: "0",
      claimed: "0",
      claimable: "12",
    });
    expect(r.funnel).toMatchObject({
      visitingSessions: 1,
      loginSubjects: 0,
      firstSuccessfulTradingAccounts: 1,
    });
    expect(r.gas.providerInvoices[0]).toMatchObject({
      reference: "original-month",
      start: new Date(0).toISOString(),
      end: new Date(86400000).toISOString(),
    });
    await expect(
      reports.report(new Date(300000), new Date(150000)),
    ).rejects.toMatchObject({ code: "invalid_report_window" });
  });
  it("treats feedback retries as one record and rejects changed content or another subject", async () => {
    const input = {
      id: randomUUID(),
      message: "测试反馈：确认窗口关闭后未见到账。",
    };
    await reports.feedback(input, "did:privy:test");
    await reports.feedback(input, "did:privy:test");
    expect(
      await sql`SELECT id FROM app_feedback WHERE id=${input.id}`,
    ).toHaveLength(1);
    await expect(
      reports.feedback(
        { ...input, message: "另一条不能静默覆盖旧反馈的内容" },
        "did:privy:test",
      ),
    ).rejects.toMatchObject({ code: "feedback_idempotency_conflict" });
    const second = { id: randomUUID(), message: "另一条反馈，用于验证稳定分页与编号查询。" };
    await reports.feedback(second, "did:privy:test");
    await sql`UPDATE app_feedback SET received_at='2026-09-09T00:00:00.000123Z' WHERE id IN (${input.id},${second.id})`;
    const page = await reports.feedbackPage({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    expect(page.items[0]).not.toHaveProperty("subject");
    const next = await reports.feedbackPage({ limit: 1, cursor: page.nextCursor! });
    expect(next.snapshotAt).toBe(page.snapshotAt);
    expect(new Set([...page.items, ...next.items].map((f) => f.id))).toEqual(new Set([input.id, second.id]));
    await expect(reports.feedbackPage({ limit: 1, id: input.id, cursor: page.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    const exact = await reports.feedbackPage({ limit: 30, id: input.id });
    expect(exact.items.map((f) => f.id)).toEqual([input.id]);
  });
  it("reports the same weekly reservation and carry-over used for admission", async () => {
    const cap = {
      projectWei: "100000000000000000",
      accountWei: "100000000000000000",
      subjectWei: "100000000000000000",
      projectOperations: 100,
      accountOperations: 100,
      subjectOperations: 100,
    };
    const limits = sponsorConfigSchema.parse({
      projectId: "reports-test",
      providerHardLimitWei: "100000000000000000",
      providerHardLimitPeriodSeconds: 604800,
      policyOperator: "and",
      passOnError: false,
      maxCostPerOperation: operation.maxGasCost,
      validitySeconds: 300,
      exposure: cap,
      exit: cap,
      methodDailyOperations: 20,
      weekly: {
        window: "shanghai-monday",
        projectWei: "100000000000000000",
        exitReserveWei: "20000000000000000",
      },
    });
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    const operations = new PostgresApplicationStore(
      scoped.toString(),
      environmentKey(env),
    );
    const withBudget = new PostgresReports(scoped.toString(), env, limits);
    try {
      await operations.ready();
      for (const [n, at, lane] of [
        [1, "2026-08-31T00:00:00.000Z", "exposure"],
        [2, "2026-09-07T00:00:00.000Z", "exposure"],
        [3, "2026-09-09T00:00:00.000Z", "exit"],
      ] as const) {
        await operations.admit(
          {
            subject: "did:privy:budget-test",
            idempotencyKey: randomUUID(),
            requestHash: H(n),
            operation: {
              ...operation,
              id: randomUUID(),
              nonce: String(n),
              lane,
              createdAt: at,
              updatedAt: at,
            },
          },
          limits,
        );
      }
      const r = await withBudget.report(
        new Date(150000),
        new Date(300000),
        new Date("2026-09-09T01:00:00.000Z"),
      );
      expect(r.weeklyBudget).toMatchObject({
        start: "2026-09-06T16:00:00.000Z",
        end: "2026-09-13T16:00:00.000Z",
        projectLimitWei: "100000000000000000",
        lanes: [
          {
            lane: "exposure",
            reservedWei: "2000000000000000",
            remainingWei: "78000000000000000",
          },
          {
            lane: "exit",
            reservedWei: "1000000000000000",
            remainingWei: "19000000000000000",
          },
        ],
      });
      const monitor = await withBudget.monitor(new Date("2026-09-09T01:00:00.000Z"));
      expect(monitor.budget).toEqual(r.weeklyBudget!.lanes.map(({ lane, reservedWei, remainingWei }) => ({ lane, reservedWei, remainingWei })));
      expect(monitor.pending).toBeGreaterThanOrEqual(monitor.unknown);
      expect(r.budgets.find((b) => b.lane === "exposure")!.reservedWei).toBe(
        "0",
      );
      expect(r.services).toMatchObject({
        providerHardLimitUsd: null,
        providerHardLimitWei: "100000000000000000",
        providerHardLimitPeriodSeconds: 604800,
        providerPolicyVerified: false,
      });
    } finally {
      await operations.close();
      await withBudget.close();
    }
  });
});
