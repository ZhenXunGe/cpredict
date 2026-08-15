import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { PostgresSponsorBudgetStore } from "../src/postgres-budget-store.js";
import type { SponsorBudgetRequest } from "../src/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl !== undefined;
const suite = describe.skipIf(!run);

suite("PostgresSponsorBudgetStore integration", () => {
  const schema = `cpredict_sponsor_${process.pid}_${Date.now()}`;
  let admin: ReturnType<typeof postgres>;
  let store: PostgresSponsorBudgetStore;

  beforeAll(async () => {
    if (databaseUrl === undefined)
      throw new Error("TEST_DATABASE_URL unexpectedly missing");
    admin = postgres(databaseUrl, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    const migration = await readFile(
      new URL("../migrations/001_sponsor_budget.sql", import.meta.url),
      "utf8",
    );
    const migrationSql = postgres(scoped.toString(), { max: 1 });
    await migrationSql.unsafe(migration);
    await migrationSql.end();
    store = new PostgresSponsorBudgetStore(scoped.toString());
    await store.ready();
  });

  afterAll(async () => {
    if (!run) return;
    await store.close();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("atomically enforces user operation and cost budgets under concurrency", async () => {
    const request = budgetRequest();
    const attempts = await Promise.allSettled([
      store.reserve(request),
      store.reserve(request),
    ]);
    const fulfilled = attempts.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof store.reserve>>
      > => result.status === "fulfilled",
    );
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain(
      "budget exceeded",
    );

    await fulfilled[0]!.value.release();
    const replacement = await store.reserve(request);
    await replacement.commit();
    await expect(store.reserve(request)).rejects.toThrow("budget exceeded");
  });

  it("fails readiness when either required migration table is absent", async () => {
    if (databaseUrl === undefined)
      throw new Error("TEST_DATABASE_URL unexpectedly missing");
    const incompleteSchema = `cpredict_sponsor_incomplete_${process.pid}_${Date.now()}`;
    await admin.unsafe(`CREATE SCHEMA ${incompleteSchema}`);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-csearch_path=${incompleteSchema}`);
    const incompleteSql = postgres(scoped.toString(), { max: 1 });
    const incompleteStore = new PostgresSponsorBudgetStore(scoped.toString());

    try {
      await incompleteSql`CREATE TABLE sponsor_budget_user_usage (id INTEGER PRIMARY KEY)`;
      await expect(incompleteStore.ready()).rejects.toThrow(
        "paymaster budget migration is not applied",
      );
    } finally {
      await incompleteStore.close();
      await incompleteSql.end();
      await admin.unsafe(`DROP SCHEMA ${incompleteSchema} CASCADE`);
    }
  });
});

function budgetRequest(): SponsorBudgetRequest {
  return {
    subject: "opaque-test-user",
    sender: getAddress("0x4444444444444444444444444444444444444444"),
    maxCost: 100n,
    validUntil: Math.floor(Date.now() / 1_000) + 300,
    policyDay: Math.floor(Date.now() / 1_000 / 86_400),
    operationCounts: { createListing: 1, cancelListing: 0 },
    limits: {
      maxCostPerUserDay: 100n,
      maxCostGlobalDay: 1_000n,
      createListingPerUserDay: 1,
      cancelListingPerUserDay: 2,
    },
  };
}
