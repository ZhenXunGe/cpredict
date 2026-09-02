import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { getAddress, type Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresPermit2RelayIntentStore } from "../src/postgres-intent-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl !== undefined;
const suite = describe.skipIf(!run);

suite("PostgresPermit2RelayIntentStore integration", () => {
  const schema = `cpredict_relay_${process.pid}_${Date.now()}`;
  let admin: ReturnType<typeof postgres>;
  let store: PostgresPermit2RelayIntentStore;

  beforeAll(async () => {
    if (databaseUrl === undefined)
      throw new Error("TEST_DATABASE_URL unexpectedly missing");
    admin = postgres(databaseUrl, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    const migration = await readFile(
      new URL("../../paymaster-service/migrations/002_permit2_relay_intents.sql", import.meta.url),
      "utf8",
    );
    const migrationSql = postgres(scoped.toString(), { max: 1 });
    await migrationSql.unsafe(migration);
    await migrationSql.end();
    store = new PostgresPermit2RelayIntentStore(scoped.toString());
    await store.ready();
  });

  afterAll(async () => {
    if (!run) return;
    await store.close();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("atomically acquires once and preserves the submitted hash on replay", async () => {
    const input = reservationInput();
    const attempts = await Promise.all([store.reserve(input), store.reserve(input)]);
    expect(attempts.map((result) => result.kind).sort()).toEqual([
      "acquired",
      "pending",
    ]);
    const acquired = attempts.find((result) => result.kind === "acquired");
    if (acquired?.kind !== "acquired") throw new Error("missing acquired intent");
    const hash = `0x${"77".repeat(32)}` as Hex;
    await acquired.markSubmitted(hash);
    await expect(store.find(input.intentId)).resolves.toEqual({
      state: "submitted",
      hash,
    });
    await expect(store.reserve(input)).resolves.toEqual({
      kind: "submitted",
      hash,
    });
  });

  it("reserves each Permit2 owner nonce only once across different intent bodies", async () => {
    const first = reservationInput();
    const second = {
      ...first,
      intentId: `0x${"22".repeat(32)}` as Hex,
      vault: getAddress("0x4444444444444444444444444444444444444444"),
    };
    await expect(store.reserve(first)).resolves.toMatchObject({ kind: "acquired" });
    await expect(store.reserve(second)).resolves.toEqual({ kind: "pending" });
    await expect(store.find(second.intentId)).resolves.toBeNull();
  });

  it("fails readiness when the relay migration table is absent", async () => {
    if (databaseUrl === undefined)
      throw new Error("TEST_DATABASE_URL unexpectedly missing");
    const emptySchema = `cpredict_relay_empty_${process.pid}_${Date.now()}`;
    await admin.unsafe(`CREATE SCHEMA ${emptySchema}`);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-csearch_path=${emptySchema}`);
    const emptyStore = new PostgresPermit2RelayIntentStore(scoped.toString());
    try {
      await expect(emptyStore.ready()).rejects.toThrow(
        "Permit2 relay migration is not applied",
      );
    } finally {
      await emptyStore.close();
      await admin.unsafe(`DROP SCHEMA ${emptySchema} CASCADE`);
    }
  });
});

function reservationInput() {
  return {
    intentId: `0x${"11".repeat(32)}` as Hex,
    owner: getAddress("0x2222222222222222222222222222222222222222"),
    vault: getAddress("0x3333333333333333333333333333333333333333"),
    permitNonce: 7n,
    expiresAt: BigInt(Math.floor(Date.now() / 1_000) + 300),
  };
}
