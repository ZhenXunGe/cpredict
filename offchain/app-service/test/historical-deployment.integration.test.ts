import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  A,
  H,
  appAccount,
  env,
  operation,
} from "../../app-core/test/fixtures.js";
import {
  environmentKey,
  environmentSchema,
  operationSchema,
} from "../../app-core/src/contracts.js";
import { applyPublicSiteMigrations } from "../src/migrations.js";
import {
  prepareHistoricalSuccessor,
  successorSchema,
} from "../src/historical-deployment.js";
import { PostgresApplicationStore } from "../src/postgres-store.js";
import { sponsorConfigSchema } from "../src/config.js";
import { PostgresReports } from "../src/reports.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("live historical deployment", () => {
  const schema = `cpredict_history_test_${process.pid}_${Date.now()}`;
  const previous = environmentSchema.parse({
    ...env,
    deployment: { ...env.deployment, protocolVersion: "time-v2" },
  });
  const next = environmentSchema.parse({
    ...env,
    id: "current-market-environment",
    deployment: {
      ...env.deployment,
      id: "time-v2-deployment",
      protocolVersion: "time-v2",
      manifestHash: H(9),
      deploymentBlock: "100",
      factory: A(21),
      marketplace: A(22),
      bondEscrow: A(23),
      feeVault: A(24),
    },
  });
  const now = new Date().toISOString(),
    subject = "did:privy:rollover";
  const oldOperation = operationSchema.parse({
    ...operation,
    kind: "faucet",
    intent: { kind: "faucet" },
    lane: "exposure",
    state: "confirmed",
    finality: "finalized",
    createdAt: now,
    updatedAt: now,
    expiresAt: now,
  });
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
  let admin: ReturnType<typeof postgres>,
    sql: ReturnType<typeof postgres>,
    scopedUrl: string,
    archive: string | undefined;
  beforeAll(async () => {
    admin = postgres(url!, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    await admin`CREATE SCHEMA ${admin(schema)}`;
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    scopedUrl = scoped.toString();
    sql = postgres(scopedUrl, {
      max: 1,
      prepare: false,
      onnotice: () => undefined,
    });
    await applyPublicSiteMigrations(sql);
    await sql`INSERT INTO cpredict_environment_identity(singleton,identity) VALUES(true,${environmentKey(previous)})`;
    await sql`INSERT INTO app_environment(singleton,identity) VALUES(true,${environmentKey(previous)})`;
    await sql`INSERT INTO app_accounts VALUES(${appAccount.id},${previous.id},${previous.deployment.id},${appAccount.controller},${appAccount.address},${sql.json(appAccount)})`;
    await sql`INSERT INTO app_account_subjects VALUES(${appAccount.id},${subject})`;
    await sql`INSERT INTO registered_markets(chain_id,market,registered_block,transaction_hash,log_index) VALUES(421614,${A(50)},1,${H(51)},0)`;
    await sql`INSERT INTO canonical_blocks(chain_id,block_number,block_hash,parent_hash,block_timestamp,confirmation_status) VALUES(421614,99,${H(99)},${H(98)},99,'confirmed')`;
    await sql`INSERT INTO chain_checkpoints(chain_id,block_number,block_hash) VALUES(421614,99,${H(99)})`;
    await sql`INSERT INTO app_operations(id,subject,idempotency_key,request_hash,account_id,sender,nonce,call_hash,state,kind,lane,created_at,updated_at,expires_at,max_gas_cost,record)
      VALUES(${oldOperation.id},${subject},${randomUUID()},${H(90)},${appAccount.id},${appAccount.address},0,${H(91)},'confirmed','faucet','exposure',${now},${now},${now},${oldOperation.maxGasCost},${sql.json(oldOperation)})`;
  });
  afterAll(async () => {
    await sql?.end();
    if (admin) {
      await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
      if (archive) await admin`DROP SCHEMA IF EXISTS ${admin(archive)} CASCADE`;
      await admin.end();
    }
  });
  it("preserves old records and accounts while sharing live quota reservations in both directions", async () => {
    await sql`UPDATE app_operations SET state='unknown',record=jsonb_set(record,'{state}','"unknown"')`;
    const before = (await sql`SELECT record FROM app_operations`)[0]!.record;
    expect((await prepareHistoricalSuccessor(sql, previous, next)).status).toBe(
      "ready-not-applied",
    );
    const result = await prepareHistoricalSuccessor(sql, previous, next, true);
    archive = result.currentSchema;
    expect(archive).toBe(successorSchema(next));
    expect(await sql`SELECT FROM registered_markets`).toHaveLength(1);
    expect((await sql`SELECT record FROM app_operations`)[0]!.record).toEqual(
      before,
    );
    expect(
      (await sql`SELECT identity FROM cpredict_environment_identity`)[0]!
        .identity,
    ).toBe(environmentKey(previous));
    expect(
      await sql`SELECT FROM ${sql(archive)}.registered_markets`,
    ).toHaveLength(0);
    const currentUrl = new URL(scopedUrl);
    currentUrl.searchParams.set("options", `-csearch_path=${archive}`);
    const old = new PostgresApplicationStore(
      scopedUrl,
      environmentKey(previous),
    );
    const current = new PostgresApplicationStore(
      currentUrl.toString(),
      environmentKey(next),
    );
    try {
      await old.ready();
      await current.ready();
      expect(await current.accounts(subject)).toEqual([
        {
          ...appAccount,
          environment: next.id,
          deploymentId: next.deployment.id,
        },
      ]);
      const fresh = (deployment: typeof next, nonce: string) => ({
        subject,
        idempotencyKey: randomUUID(),
        requestHash: H(82),
        operation: operationSchema.parse({
          ...operation,
          id: randomUUID(),
          environment: deployment.id,
          deploymentId: deployment.deployment.id,
          kind: "buy",
          lane: "exposure",
          state: "awaiting-signature",
          finality: "pending",
          nonce,
          createdAt: now,
          updatedAt: now,
          expiresAt: now,
        }),
      });
      await expect(
        current.admit(fresh(next, oldOperation.nonce), limits),
      ).rejects.toMatchObject({ code: "operation_in_progress" });
      // Resolve the original without losing its charge, then race admissions in different schemas.
      await sql`UPDATE app_operations SET state='confirmed',record=${sql.json(oldOperation)}`;
      const bounded = {
        ...limits,
        exposure: { ...limits.exposure, projectOperations: 2 },
      };
      const results = await Promise.allSettled([
        old.admit(fresh(previous, "11"), bounded),
        current.admit(fresh(next, "12"), bounded),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(await sql`SELECT FROM app_quota_operations`).toHaveLength(2);
      expect(
        await sql`SELECT FROM ${sql(archive)}.app_quota_operations`,
      ).toHaveLength(2);
      await expect(
        prepareHistoricalSuccessor(sql, previous, next, true),
      ).rejects.toMatchObject({
        code: "successor_schema_exists_inspect_before_retry",
      });
    } finally {
      await old.close();
      await current.close();
    }
  });
});
