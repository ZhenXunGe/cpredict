import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresTerminalWorkerState } from "../src/postgres-state.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const market = "0x00000000000000000000000000000000000000B1";
const hash = `0x${"77".repeat(32)}` as const;

describe.skipIf(databaseUrl === undefined)(
  "PostgresTerminalWorkerState integration",
  () => {
    const schema = `cpredict_worker_${process.pid}_${Date.now()}`;
    let admin: ReturnType<typeof postgres>;
    let sql: ReturnType<typeof postgres>;

    beforeAll(async () => {
      if (databaseUrl === undefined)
        throw new Error("TEST_DATABASE_URL is required");
      admin = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      const scoped = new URL(databaseUrl);
      scoped.searchParams.set("options", `-csearch_path=${schema}`);
      sql = postgres(scoped.toString(), { max: 1 });
      const migration = await readFile(
        new URL("../migrations/001_terminal_worker.sql", import.meta.url),
        "utf8",
      );
      await sql.unsafe(migration);
    });

    afterAll(async () => {
      await sql?.end();
      if (admin) {
        await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    });

    it("round-trips JSON results and reloads the attempt block", async () => {
      const state = new PostgresTerminalWorkerState(sql, 99_901);
      await state.recordAttempt(market, 10n, [
        {
          market,
          blockNumber: 10n,
          operation: "settle-bond",
          outcome: "success",
          hash,
        },
      ]);
      const restored = new PostgresTerminalWorkerState(sql, 99_901);
      expect(await restored.lastAttemptBlock(market)).toBe(10n);
      const rows =
        await sql`SELECT results FROM terminal_worker_attempts WHERE chain_id = 99901`;
      expect(rows[0]?.results).toEqual([
        {
          operation: "settle-bond",
          outcome: "success",
          hash,
          reason: null,
        },
      ]);
    });

    it("upserts results without mixing chains or retaining a previous transaction hash", async () => {
      const state = new PostgresTerminalWorkerState(sql, 99_902);
      const other = new PostgresTerminalWorkerState(sql, 99_903);
      await state.recordAttempt(market, 20n, [
        {
          market,
          blockNumber: 20n,
          operation: "settle-bond",
          outcome: "success",
          hash,
        },
      ]);
      await state.recordAttempt(market, 21n, [
        {
          market,
          blockNumber: 21n,
          operation: "sync-exposure",
          outcome: "simulation-rejected",
          reason: "already synchronized",
        },
      ]);
      expect(await state.lastAttemptBlock(market)).toBe(21n);
      expect(await other.lastAttemptBlock(market)).toBeUndefined();
      const rows =
        await sql`SELECT results FROM terminal_worker_attempts WHERE chain_id = 99902`;
      expect(rows[0]?.results).toEqual([
        {
          operation: "sync-exposure",
          outcome: "simulation-rejected",
          hash: null,
          reason: "already synchronized",
        },
      ]);
    });
  },
);
