import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  A,
  H,
  appAccount,
  env,
  operation,
} from "../../app-core/test/fixtures.js";
import { environmentKey } from "../../app-core/src/contracts.js";
import { sponsorConfigSchema } from "../src/config.js";
import { PostgresApplicationStore } from "../src/postgres-store.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("public application PostgreSQL invariants", () => {
  const schema = `cpredict_app_${process.pid}_${Date.now()}`;
  let admin: ReturnType<typeof postgres>,
    store: PostgresApplicationStore,
    otherProcess: PostgresApplicationStore;
  let scopedUrl: string;
  const subject = "did:privy:pg-test";
  const cap = {
    projectWei: "100000000000000000",
    accountWei: "100000000000000000",
    subjectWei: "100000000000000000",
    projectOperations: 100,
    accountOperations: 100,
    subjectOperations: 100,
  };
  const limits = sponsorConfigSchema.parse({
    projectId: "test",
    providerHardLimitUsd: "1.00",
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
  const challenge = (id: string) => ({
    id,
    subject,
    controller: appAccount.controller,
    environment: env.id,
    deploymentId: env.deployment.id,
    message: "test only",
    expiresAt: "2026-09-09T01:00:00.000Z",
    consumed: false,
  });
  beforeAll(async () => {
    if (!url) throw new Error("TEST_DATABASE_URL is required");
    admin = postgres(url, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    scopedUrl = scoped.toString();
    const sql = postgres(scopedUrl, { max: 1, onnotice: () => undefined });
    await sql.unsafe(
      await readFile(
        new URL("../migrations/001_application.sql", import.meta.url),
        "utf8",
      ),
    );
    await sql.end();
    store = new PostgresApplicationStore(scopedUrl, environmentKey(env));
    otherProcess = new PostgresApplicationStore(scopedUrl, environmentKey(env));
    await store.ready();
    await otherProcess.ready();
  });
  afterAll(async () => {
    await store?.close();
    await otherProcess?.close();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  it("consumes control challenges once across processes and preserves a stable account identity", async () => {
    const id = randomUUID();
    await store.createChallenge(challenge(id));
    const results = await Promise.allSettled([
      store.bindAccount(id, subject, appAccount, operation.createdAt),
      otherProcess.bindAccount(id, subject, appAccount, operation.createdAt),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await store.account(appAccount.id, "did:privy:other"),
    ).toBeUndefined();
    const next = randomUUID();
    await store.createChallenge(challenge(next));
    await expect(
      otherProcess.bindAccount(
        next,
        subject,
        { ...appAccount, id: randomUUID(), address: A(99) },
        operation.createdAt,
      ),
    ).rejects.toMatchObject({ code: "account_configuration_changed" });
    expect((await store.challenge(next))!.consumed).toBe(false);
  });
  it("atomically registers one operation and rejects idempotency or account-nonce conflicts", async () => {
    const value = {
      operation,
      subject,
      idempotencyKey: randomUUID(),
      requestHash: H(2),
    };
    const result = await Promise.all([
      store.admit(value, limits),
      otherProcess.admit(value, limits),
    ]);
    expect(result.map((r) => r.operation.id)).toEqual([
      operation.id,
      operation.id,
    ]);
    expect(await store.operations(subject, 100)).toHaveLength(1);
    await expect(
      otherProcess.admit({ ...value, requestHash: H(3) }, limits),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      otherProcess.admit(
        {
          ...value,
          idempotencyKey: randomUUID(),
          operation: { ...operation, id: randomUUID() },
        },
        limits,
      ),
    ).rejects.toMatchObject({ code: "operation_in_progress" });
  });
  it("allows only one submit transition, persists original hashes across restart and retains correction history", async () => {
    const results = await Promise.all([
      store.transition(operation.id, ["awaiting-signature"], {
        state: "submitted",
        userOperationHash: H(10),
      }),
      otherProcess.transition(operation.id, ["awaiting-signature"], {
        state: "submitted",
        userOperationHash: H(11),
      }),
    ]);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    const saved = (await store.operation(operation.id))!.operation
      .userOperationHash;
    await store.transition(operation.id, ["submitted"], {
      state: "unknown",
      reason: "provider_result_unknown",
    });
    const reopened = new PostgresApplicationStore(
      scopedUrl,
      environmentKey(env),
    );
    try {
      await reopened.ready();
      expect(
        (await reopened.operation(operation.id))!.operation.userOperationHash,
      ).toBe(saved);
    } finally {
      await reopened.close();
    }
    const sql = postgres(scopedUrl, { max: 1 });
    try {
      const rows =
        await sql`SELECT * FROM app_operation_changes WHERE operation_id=${operation.id}`;
      expect(rows).toHaveLength(2);
      expect(JSON.stringify(rows)).not.toContain('"signature":');
    } finally {
      await sql.end();
    }
  });
  it("rejects a second environment using the same schema", async () => {
    const wrong = new PostgresApplicationStore(scopedUrl, "other-environment");
    try {
      await expect(wrong.ready()).rejects.toThrow("another deployment");
    } finally {
      await wrong.close();
    }
  });
  it("paginates at a fixed admission boundary and binds cursors to the account and subject", async () => {
    const make = (nonce: string, at: string) => ({
      operation: {
        ...operation,
        id: randomUUID(),
        nonce,
        createdAt: at,
        updatedAt: at,
      },
      subject,
      idempotencyKey: randomUUID(),
      requestHash: H(Number(nonce) + 30),
    });
    const first = make("1", "2026-09-09T00:01:00.000Z"),
      second = make("2", "2026-09-09T00:02:00.000Z");
    await store.admit(first, limits);
    await store.admit(second, limits);
    const page = await store.operationPage(subject, appAccount.id, 1);
    expect(page.items.map((o) => o.id)).toEqual([second.operation.id]);
    expect(page.nextCursor).toBeTypeOf("string");
    const late = make("3", "2026-09-09T00:01:30.000Z");
    await otherProcess.admit(late, limits);
    const next = await store.operationPage(
      subject,
      appAccount.id,
      10,
      page.nextCursor!,
    );
    expect(next.items.map((o) => o.id)).toEqual([
      first.operation.id,
      operation.id,
    ]);
    expect(
      (await store.operationPage("did:privy:other", appAccount.id, 10)).items,
    ).toEqual([]);
    await expect(
      store.operationPage(
        "did:privy:other",
        appAccount.id,
        10,
        page.nextCursor!,
      ),
    ).rejects.toMatchObject({ code: "cursor_filter_mismatch" });
    await expect(
      store.operationPage(subject, randomUUID(), 10, page.nextCursor!),
    ).rejects.toMatchObject({ code: "cursor_filter_mismatch" });
  });
  it("reserves quotas atomically across processes while preserving the independent exit budget", async () => {
    const limited = {
      ...limits,
      exposure: { ...cap, projectOperations: 1 },
      exit: { ...cap, projectOperations: 1 },
    };
    const make = (nonce: string, lane: "exposure" | "exit") => ({
      subject,
      idempotencyKey: randomUUID(),
      requestHash: H(Number(nonce)),
      operation: {
        ...operation,
        id: randomUUID(),
        nonce,
        lane,
        kind: lane === "exit" ? ("transfer" as const) : ("buy" as const),
        intent:
          lane === "exit"
            ? operation.intent
            : {
                kind: "buy" as const,
                market: A(101),
                outcomeId: "0",
                units: "1",
                minUnits: "1",
                maxPayment: "1",
                deadline: "2000000000",
              },
        createdAt: "2026-09-10T00:00:00.000Z",
        updatedAt: "2026-09-10T00:00:00.000Z",
        expiresAt: "2026-09-10T00:05:00.000Z",
      },
    });
    const attempts = await Promise.allSettled([
      store.admit(make("101", "exposure"), limited),
      otherProcess.admit(make("102", "exposure"), limited),
    ]);
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "sponsorship_budget_exhausted" },
    });
    await expect(
      store.admit(make("103", "exit"), limited),
    ).resolves.toMatchObject({ operation: { lane: "exit" } });
    await expect(
      otherProcess.admit(make("104", "exit"), limited),
    ).rejects.toMatchObject({ code: "sponsorship_budget_exhausted" });
  });
  it("shares a weekly cap across processes and days while isolating environments", async () => {
    const schemas = [`${schema}_weekly_a`, `${schema}_weekly_b`];
    const stores: PostgresApplicationStore[] = [];
    let secondProcess: PostgresApplicationStore | undefined;
    try {
      for (const [i, name] of schemas.entries()) {
        await admin.unsafe(`CREATE SCHEMA ${name}`);
        const scoped = new URL(url!);
        scoped.searchParams.set("options", `-csearch_path=${name}`);
        const sql = postgres(scoped.toString(), {
          max: 1,
          onnotice: () => undefined,
        });
        try {
          await sql.unsafe(
            await readFile(
              new URL("../migrations/001_application.sql", import.meta.url),
              "utf8",
            ),
          );
        } finally {
          await sql.end();
        }
        const identity = `${environmentKey(env)}-weekly-${i}`;
        const s = new PostgresApplicationStore(scoped.toString(), identity);
        stores.push(s);
        await s.ready();
        const id = randomUUID();
        await s.createChallenge(challenge(id));
        await s.bindAccount(id, subject, appAccount, operation.createdAt);
        if (i === 0) {
          secondProcess = new PostgresApplicationStore(
            scoped.toString(),
            identity,
          );
          await secondProcess.ready();
        }
      }
      const weekly = {
        ...limits,
        weekly: {
          window: "shanghai-monday" as const,
          projectWei: "4000000000000000",
          exitReserveWei: "1000000000000000",
        },
      };
      const make = (
        nonce: string,
        at: string,
        lane: "exit" | "exposure" = "exposure",
      ) => ({
        subject,
        idempotencyKey: randomUUID(),
        requestHash: H(Number(nonce)),
        operation: {
          ...operation,
          id: randomUUID(),
          nonce,
          lane,
          createdAt: at,
          updatedAt: at,
          expiresAt: new Date(Date.parse(at) + 300_000).toISOString(),
        },
      });
      await stores[0]!.admit(make("201", "2026-09-07T00:00:00.000Z"), weekly);
      await stores[0]!.admit(make("202", "2026-09-08T00:00:00.000Z"), weekly);
      const concurrent = await Promise.allSettled([
        stores[0]!.admit(make("203", "2026-09-12T00:00:00.000Z"), weekly),
        secondProcess!.admit(make("204", "2026-09-12T00:00:00.000Z"), weekly),
      ]);
      expect(concurrent.filter((r) => r.status === "fulfilled")).toHaveLength(
        1,
      );
      expect(concurrent.find((r) => r.status === "rejected")).toMatchObject({
        reason: { code: "sponsorship_weekly_budget_exhausted" },
      });
      await expect(
        stores[0]!.admit(
          make("205", "2026-09-12T00:00:00.000Z", "exit"),
          weekly,
        ),
      ).resolves.toBeDefined();
      await expect(
        stores[1]!.admit(make("206", "2026-09-12T00:00:00.000Z"), weekly),
      ).resolves.toBeDefined();
      // Old unresolved reservations are retained even when the date and process change.
      await expect(
        secondProcess!.admit(make("207", "2026-09-21T00:00:00.000Z"), weekly),
      ).rejects.toMatchObject({ code: "sponsorship_weekly_budget_exhausted" });
    } finally {
      await secondProcess?.close();
      for (const s of stores) await s.close();
      for (const name of schemas)
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    }
  });
});
