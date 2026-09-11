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
  assertDeploymentRollover,
  rolloverDeployment,
} from "../src/deployment-rollover.js";
import { PostgresApplicationStore } from "../src/postgres-store.js";
import { sponsorConfigSchema } from "../src/config.js";
import { PostgresReports } from "../src/reports.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("ctUSD deployment rollover", () => {
  const schema = `cpredict_rollover_${process.pid}_${Date.now()}`;
  const previous = environmentSchema.parse({
    ...env,
    deployment: { ...env.deployment, protocolVersion: "legacy-v1" },
  });
  const next = environmentSchema.parse({
    ...env,
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
  it("rejects changing token, account derivation, login project or reusing old protocol contracts", () => {
    expect(() =>
      assertDeploymentRollover(previous, {
        ...next,
        account: { ...next.account, index: "1002" },
      }),
    ).toThrow();
    expect(() =>
      assertDeploymentRollover(previous, { ...next, privyAppId: "different" }),
    ).toThrow();
    expect(() =>
      assertDeploymentRollover(previous, {
        ...next,
        deployment: { ...next.deployment, paymentToken: A(80) },
      }),
    ).toThrow();
    expect(() =>
      assertDeploymentRollover(previous, {
        ...next,
        deployment: {
          ...next.deployment,
          factory: previous.deployment.factory,
        },
      }),
    ).toThrow();
  });
  it("keeps live history untouched while an unknown result or nonfinal receipt needs recovery", async () => {
    await sql`UPDATE app_operations SET state='unknown'`;
    await expect(
      rolloverDeployment(sql, previous, next, true),
    ).rejects.toMatchObject({ code: "rollover_operations_need_recovery" });
    await sql`UPDATE app_operations SET state='confirmed',record=record || '{"finality":"application-confirmed"}'::jsonb`;
    await expect(
      rolloverDeployment(sql, previous, next, true),
    ).rejects.toMatchObject({ code: "rollover_operations_need_recovery" });
    await sql`UPDATE app_operations SET record=${sql.json(oldOperation)}`;
    expect(await sql`SELECT * FROM registered_markets`).toHaveLength(1);
    expect(
      (await sql`SELECT identity FROM cpredict_environment_identity`)[0]!
        .identity,
    ).toBe(environmentKey(previous));
  });
  it("archives old markets, starts at the new block and retains account, faucet and weekly quotas", async () => {
    expect((await rolloverDeployment(sql, previous, next)).status).toBe(
      "ready-not-applied",
    );
    const result = await rolloverDeployment(sql, previous, next, true);
    archive = result.archiveSchema;
    expect(result.status).toBe("applied");
    expect(await sql`SELECT * FROM registered_markets`).toHaveLength(0);
    expect(await sql`SELECT * FROM chain_checkpoints`).toHaveLength(0);
    expect(await sql`SELECT * FROM app_operations`).toHaveLength(0);
    expect(
      await sql`SELECT * FROM ${sql(archive)}.registered_markets`,
    ).toHaveLength(1);
    expect(
      (await sql`SELECT record FROM ${sql(archive)}.app_operations`)[0]!.record,
    ).toEqual(oldOperation);
    expect(
      (await sql`SELECT from_block::text FROM ledger_tracked_accounts`)[0]!
        .from_block,
    ).toBe("100");
    const app = new PostgresApplicationStore(
      scopedUrl,
      environmentKey(next),
      next.deployment.deploymentBlock,
    );
    const reports = new PostgresReports(scopedUrl, next, limits);
    try {
      await app.ready();
      expect(await app.accounts(subject)).toEqual([
        { ...appAccount, deploymentId: next.deployment.id },
      ]);
      expect(await app.operations(subject, 10)).toEqual([]);
      const fresh = operationSchema.parse({
        ...oldOperation,
        id: randomUUID(),
        deploymentId: next.deployment.id,
        state: "awaiting-signature",
        finality: "pending",
        nonce: "1",
      });
      await expect(
        app.admit(
          {
            operation: fresh,
            subject,
            idempotencyKey: randomUUID(),
            requestHash: H(82),
          },
          limits,
        ),
      ).rejects.toMatchObject({ code: "faucet_cooldown" });
      const monitor = await reports.monitor(new Date(now));
      expect(
        monitor.budget.find((row) => row.lane === "exposure")!.reservedWei,
      ).toBe(oldOperation.maxGasCost);
    } finally {
      await app.close();
      await reports.close();
    }
  });
  it("recognizes a completed switch without reimporting old records or resetting quotas", async () => {
    expect((await rolloverDeployment(sql, previous, next, true)).status).toBe(
      "already-applied",
    );
    expect(await sql`SELECT * FROM app_quota_carryover`).toHaveLength(1);
    expect(await sql`SELECT * FROM app_operations`).toHaveLength(0);
  });
});
