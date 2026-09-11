import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import postgres from "postgres";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  A,
  H,
  appAccount,
  env,
  operation,
} from "../../app-core/test/fixtures.js";
import {
  environmentKey,
  depositSchema,
  operationSchema,
} from "../../app-core/src/contracts.js";
import {
  receiveCall,
  receiveTypedData,
  USDC_ADDRESS,
} from "../../app-core/src/usdc.js";
import type { StoredDeposit } from "../src/store.js";
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
    await sql.unsafe(
      await readFile(
        new URL("../migrations/003_usdc_deposits.sql", import.meta.url),
        "utf8",
      ),
    );
    await sql.unsafe(await readFile(new URL("../migrations/004_deployment_carryover.sql", import.meta.url), "utf8"));
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
  const funder = privateKeyToAccount(generatePrivateKey());
  let depositSequence = 1000;
  function preparedDeposit(
    overrides: Partial<StoredDeposit> = {},
    target = appAccount,
    now = "2026-09-12T00:00:00.000Z",
  ): StoredDeposit {
    const n = ++depositSequence;
    return {
      subject,
      idempotencyKey: randomUUID(),
      requestHash: H(n),
      ...overrides,
      deposit: depositSchema.parse({
        id: randomUUID(),
        environment: target.environment,
        deploymentId: target.deploymentId,
        accountId: target.id,
        account: target.address,
        domain: {
          name: "USD Coin",
          version: "2",
          chainId: 421614,
          verifyingContract: USDC_ADDRESS,
        },
        authorization: {
          from: funder.address,
          to: target.address,
          value: "1000000",
          validAfter: "0",
          validBefore: String(Date.parse(now) / 1000 + 600),
          nonce: H(n),
        },
        state: "awaiting-authorization",
        operationId: null,
        userOperationHash: null,
        transactionHash: null,
        blockNumber: null,
        blockHash: null,
        actualGasCost: null,
        finality: "pending",
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.parse(now) + 600000).toISOString(),
        reason: null,
      }),
    };
  }
  async function depositOperation(value: StoredDeposit) {
    const d = value.deposit,
      signature = await funder.signTypedData(
        receiveTypedData(d.domain, d.authorization),
      );
    const call = receiveCall(d.authorization, signature);
    return {
      subject: value.subject,
      idempotencyKey: randomUUID(),
      requestHash: H(++depositSequence),
      operation: operationSchema.parse({
        ...operation,
        id: randomUUID(),
        environment: d.environment,
        deploymentId: d.deploymentId,
        accountId: d.accountId,
        account: d.account,
        nonce: String(depositSequence),
        kind: "deposit-usdc",
        intent: {
          kind: "deposit-usdc",
          depositId: d.id,
          authorization: d.authorization,
          signature,
        },
        calls: [call],
        callData: call.data,
        lane: "exposure",
        createdAt: d.createdAt,
        updatedAt: d.createdAt,
        expiresAt: d.expiresAt,
      }),
    };
  }
  it("prepares one durable authorization across processes and rejects conflicting drafts", async () => {
    const value = preparedDeposit(),
      now = value.deposit.createdAt;
    const results = await Promise.all([
      store.createDeposit(value),
      otherProcess.createDeposit(value),
    ]);
    expect(results.map((r) => r.deposit.id)).toEqual([
      value.deposit.id,
      value.deposit.id,
    ]);
    await expect(
      otherProcess.createDeposit({ ...value, requestHash: H(9999) }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      otherProcess.createDeposit(preparedDeposit()),
    ).rejects.toMatchObject({ code: "deposit_in_progress" });
    await expect(
      store.cancelDeposit(value.deposit.id, "did:privy:other", now),
    ).rejects.toMatchObject({ code: "deposit_not_found" });
    expect(
      (await store.cancelDeposit(value.deposit.id, subject, now)).deposit.state,
    ).toBe("cancelled");
    const duplicate = preparedDeposit();
    duplicate.deposit.authorization.nonce = value.deposit.authorization.nonce;
    await expect(store.createDeposit(duplicate)).rejects.toMatchObject({
      code: "23505",
    });
  });
  it("serializes cancellation against admission without an orphaned operation or authorization", async () => {
    const value = preparedDeposit();
    await store.createDeposit(value);
    const registered = await depositOperation(value);
    const results = await Promise.allSettled([
      store.admit(registered, limits),
      otherProcess.cancelDeposit(
        value.deposit.id,
        subject,
        value.deposit.createdAt,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const d = (await store.deposit(value.deposit.id, value.deposit.createdAt))!
      .deposit;
    if (d.operationId) {
      expect(
        (await store.operation(d.operationId))!.operation.intent.kind,
      ).toBe("deposit-usdc");
      await store.transition(d.operationId, ["awaiting-signature"], {
        state: "cancelled",
      });
    } else {
      expect(d.state).toBe("cancelled");
      expect(await store.operation(registered.operation.id)).toBeUndefined();
    }
  });
  it("recovers exactly one linked admission across restart and keeps expired unknown deposits active", async () => {
    const value = preparedDeposit();
    await store.createDeposit(value);
    const registered = await depositOperation(value);
    const results = await Promise.all([
      store.admit(registered, limits),
      otherProcess.admit(registered, limits),
    ]);
    expect(results[0]!.operation.id).toBe(results[1]!.operation.id);
    const reopened = new PostgresApplicationStore(
      scopedUrl,
      environmentKey(env),
    );
    try {
      await reopened.ready();
      expect(
        (await reopened.depositByKey(
          subject,
          value.idempotencyKey,
          value.deposit.createdAt,
        ))!.deposit.operationId,
      ).toBe(registered.operation.id);
      await reopened.transition(
        registered.operation.id,
        ["awaiting-signature"],
        { state: "unknown", userOperationHash: H(12345) },
      );
      const later = "2026-09-12T01:00:00.000Z";
      expect(
        (await reopened.deposit(value.deposit.id, later))!.deposit,
      ).toMatchObject({ state: "unknown", userOperationHash: H(12345) });
      const next = preparedDeposit();
      next.deposit.createdAt = later;
      next.deposit.expiresAt = "2026-09-12T01:10:00.000Z";
      await expect(reopened.createDeposit(next)).rejects.toMatchObject({
        code: "deposit_in_progress",
      });
      expect(
        (
          await reopened.depositPage(
            subject,
            appAccount.id,
            later,
            100,
            undefined,
            true,
          )
        ).items.map((d) => d.id),
      ).toContain(value.deposit.id);
      const page = await reopened.depositPage(subject, appAccount.id, later, 1);
      expect(page.nextCursor).toBeTypeOf("string");
      await expect(
        reopened.depositPage(
          "did:privy:other",
          appAccount.id,
          later,
          1,
          page.nextCursor!,
        ),
      ).rejects.toMatchObject({ code: "cursor_filter_mismatch" });
      await reopened.transition(registered.operation.id, ["unknown"], {
        state: "confirmed",
        finality: "finalized",
      });
    } finally {
      await reopened.close();
    }
  });
  it("reserves source quota across users and rolls back the denied deposit link", async () => {
    const targets = [];
    for (const n of [801, 802]) {
      const target = {
          ...appAccount,
          id: randomUUID(),
          controller: A(n),
          address: A(n + 10),
        },
        owner = `did:privy:funding-${n}`,
        id = randomUUID();
      await store.createChallenge({
        ...challenge(id),
        subject: owner,
        controller: target.controller,
      });
      await store.bindAccount(id, owner, target, operation.createdAt);
      const value = preparedDeposit(
        { subject: owner },
        target,
        "2026-09-13T00:00:00.000Z",
      );
      await store.createDeposit(value);
      targets.push(value);
    }
    const first = await depositOperation(targets[0]!),
      second = await depositOperation(targets[1]!);
    await store.admit(first, { ...limits, methodDailyOperations: 1 });
    await expect(
      otherProcess.admit(second, { ...limits, methodDailyOperations: 1 }),
    ).rejects.toMatchObject({ code: "deposit_source_quota_exhausted" });
    expect(await store.operation(second.operation.id)).toBeUndefined();
    expect(
      (await store.deposit(
        targets[1]!.deposit.id,
        targets[1]!.deposit.createdAt,
      ))!.deposit.operationId,
    ).toBeNull();
  });
  it("paginates signature-free operator reconciliation and binds filters to cursors", async () => {
    const q = {
        start: "2026-09-12T00:00:00.000Z",
        end: "2026-09-14T00:00:00.000Z",
        limit: 1,
      },
      now = "2026-09-14T00:00:00.000Z";
    const first = await store.depositReport(q, now);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf("string");
    const next = await store.depositReport(
      { ...q, cursor: first.nextCursor! },
      now,
    );
    expect(next.items[0]!.id).not.toBe(first.items[0]!.id);
    const filtered = await store.depositReport(
      {
        ...q,
        id: first.items[0]!.id,
        source: first.items[0]!.authorization.from,
      },
      now,
    );
    expect(filtered.items).toEqual(first.items);
    expect(filtered.nextCursor).toBeNull();
    await expect(
      store.depositReport(
        { ...q, start: "2026-09-13T00:00:00.000Z", cursor: first.nextCursor! },
        now,
      ),
    ).rejects.toMatchObject({ code: "cursor_filter_mismatch" });
    expect(JSON.stringify(first)).not.toContain('"signature":');
    expect(JSON.stringify(first)).not.toContain('"callData":');
    expect(JSON.stringify(first)).not.toContain(subject);
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
          await sql.unsafe(await readFile(new URL("../migrations/004_deployment_carryover.sql", import.meta.url), "utf8"));
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
