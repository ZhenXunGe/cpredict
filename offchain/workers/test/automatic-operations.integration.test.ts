import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { keccak256 } from "viem";
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { PostgresAutomaticStore } from "../src/automatic-store.js";
import { PostgresRecoveryStore } from "../src/automatic-recovery.js";
import { AutomationAlerts } from "../src/automatic-alerts.js";
import type { AutomationRecord } from "../src/automatic-claims.js";
const url = process.env.TEST_DATABASE_URL;
const owner = "0x1111111111111111111111111111111111111111" as const;
const signer = "0x2222222222222222222222222222222222222222" as const;
const raw = "0x1234" as const;
describe.skipIf(!url)("durable automation operations", () => {
  const schema = `cpredict_operations_${process.pid}_${Date.now()}`;
  let admin: ReturnType<typeof postgres>,
    sql: ReturnType<typeof postgres>,
    store: PostgresAutomaticStore;
  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    sql = postgres(scoped.toString(), { max: 4, onnotice: () => {} });
    const migration = await sql.reserve();
    try {
      for (const name of [
        "007_order_automation.sql",
        "008_automation_status_scope.sql",
        "009_automation_canonical_audit.sql",
        "010_automation_cleanup_quotas.sql",
        "011_automation_operations.sql",
        "013_actual_automation_gas.sql",
      ])
        await migration.unsafe(
          await readFile(
            new URL(`../../app-service/migrations/${name}`, import.meta.url),
            "utf8",
          ),
        );
    } finally {
      migration.release();
    }
    store = new PostgresAutomaticStore(sql, 421614, "deployment", signer);
  });
  beforeEach(async () => {
    await sql`TRUNCATE automation_alert_events,automation_attempts,automation_recoveries,automation_transactions,automatic_claim_preferences,automation_lane_status CASCADE`;
  });
  afterAll(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  async function create(
    age = 121,
    state: "prepared" | "unknown" = "unknown",
  ): Promise<AutomationRecord> {
    const id = randomUUID();
    await sql`INSERT INTO automation_transactions(id,chain_id,deployment_id,job_key,owner,kind,target,calldata,signer,requires_claim_preference,nonce,tx_hash,raw_transaction,state,reserved_wei,created_at,broadcast_at) VALUES(${id},421614,'deployment',${id},${owner},'refund',${owner},'0x1234',${signer},true,5,${keccak256(raw)},${raw},${state},10,now()-${age}*interval '1 second',${state === "prepared" ? null : new Date(Date.now() - age * 1000)})`;
    return (await store.pending())[0]!;
  }
  const replacement = {
    raw: "0x5678" as const,
    hash: keccak256("0x5678"),
    nonce: 5n,
    maximumCost: 20n,
  };
  it("migration is additive/idempotent and old pending rows remain readable", async () => {
    const t = await create();
    const migration = await sql.reserve();
    try {
      await migration.unsafe(
        await readFile(
          new URL(
            "../../app-service/migrations/011_automation_operations.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
    } finally {
      migration.release();
    }
    await store.operationalSchemaReady();
    expect((await store.pending())[0]?.hash).toBe(t.hash);
  });
  it("durable recovery checks enforce age, rate limit and manual stop", async () => {
    const t = await create(119);
    expect(await store.recoveryCheckDue(t)).toBe(false);
    await sql`UPDATE automation_transactions SET broadcast_at=now()-interval '121 seconds' WHERE id=${t.id}`;
    expect(await store.recoveryCheckDue(t)).toBe(true);
    expect(await store.recoveryCheckDue(t)).toBe(false);
    await new PostgresRecoveryStore(store).recoveryCheck(t, {
      reason: "nonce_changed",
    });
    await sql`UPDATE automation_transactions SET recovery_checked_at=NULL WHERE id=${t.id}`;
    expect(await store.recoveryCheckDue(t)).toBe(false);
  });
  it("validation errors remain recorded after a successful later validation", async () => {
    const t = await create();
    await store.validation(t, "writer-1", {
      reason: "gas_limit",
      rpcCode: -32000,
    });
    await store.validation(t, "writer-2");
    const rows =
      await sql`SELECT outcome,provider,reason FROM automation_attempts ORDER BY id`;
    expect(rows).toMatchObject([
      { outcome: "rejected", provider: "writer-1", reason: "gas_limit" },
      { outcome: "validated", provider: "writer-2", reason: null },
    ]);
  });
  it("broadcast CAS and attempt record are atomic and single-use", async () => {
    const t = await create(1, "prepared");
    expect(
      await Promise.all([
        store.markBroadcasting(t.id, "writer-1"),
        store.markBroadcasting(t.id, "writer-2"),
      ]),
    ).toContain(false);
    await store.unknown(t.id, {
      outcome: "unknown",
      provider: "writer-1",
      failure: { reason: "timeout" },
    });
    expect((await store.pending())[0]?.state).toBe("unknown");
    expect(await sql`SELECT reason FROM automation_attempts`).toMatchObject([
      { reason: "timeout" },
    ]);
  });
  it("failed diagnostic persistence prevents broadcast CAS", async () => {
    const t = await create(1, "prepared");
    await expect(
      store.markBroadcasting(t.id, "https://secret"),
    ).rejects.toThrow();
    expect((await store.pending())[0]?.state).toBe("prepared");
  });
  it("concurrent recovery creates at most one durable replacement", async () => {
    const t = await create();
    const r = new PostgresRecoveryStore(store);
    const results = await Promise.allSettled([
      r.saveRecovery(t, replacement, "automatic"),
      r.saveRecovery(t, replacement, "automatic"),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await store.recoveryCheckDue(t)).toBe(false);
    const rows =
      await sql`SELECT original_raw,replacement_raw FROM automation_recoveries`;
    expect(rows).toMatchObject([
      { original_raw: raw, replacement_raw: replacement.raw },
    ]);
  });
  it("replacement CAS rejects mismatched bytes and refuses any repeat", async () => {
    const t = await create();
    const r = new PostgresRecoveryStore(store);
    const saved = await r.saveRecovery(t, replacement, "automatic");
    expect(
      await r.startRecovery(t, { ...saved, raw: "0xab" }, "writer-1"),
    ).toBe(false);
    expect(await r.startRecovery(t, saved, "writer-1")).toBe(true);
    expect(await r.startRecovery(t, saved, "writer-1")).toBe(false);
    expect((await store.pending())[0]).toMatchObject({
      hash: replacement.hash,
      nonce: 5n,
      state: "unknown",
    });
    expect(await store.recoveryHashes(t.id)).toEqual([t.hash]);
  });
  it("canonical original or replacement receipt clears both raws and accounts only one cost", async () => {
    for (const winner of ["original", "replacement"]) {
      await sql`TRUNCATE automation_alert_events,automation_attempts,automation_recoveries,automation_transactions CASCADE`;
      const t = await create();
      const r = new PostgresRecoveryStore(store);
      const saved = await r.saveRecovery(t, replacement, "automatic");
      await r.startRecovery(t, saved, "writer-1");
      const hash = winner === "original" ? t.hash : replacement.hash;
      await store.finish(
        t.id,
        { status: "success", blockNumber: 100n, blockHash: keccak256("0xab") },
        hash,
      );
      expect(await store.pending()).toHaveLength(0);
      expect(await store.spentToday()).toBe(20n);
      expect(
        await sql`SELECT winning_hash,original_raw,replacement_raw FROM automation_recoveries`,
      ).toMatchObject([
        { winning_hash: hash, original_raw: null, replacement_raw: null },
      ]);
    }
  });
  it("unregistered receipt hash cannot complete or partially write a task", async () => {
    const t = await create();
    await expect(
      store.finish(
        t.id,
        { status: "success", blockNumber: 100n, blockHash: keccak256("0xab") },
        replacement.hash,
      ),
    ).rejects.toThrow("unregistered");
    expect((await store.pending())[0]?.state).toBe("unknown");
  });
  it("blank email persists only one two-minute alert without claiming delivery", async () => {
    const t = await create(119);
    const alerts = new AutomationAlerts(store);
    expect(await alerts.sync()).toBe(0);
    await sql`UPDATE automation_transactions SET broadcast_at=now()-interval '121 seconds' WHERE id=${t.id}`;
    expect(await Promise.all([alerts.sync(), alerts.sync()])).toEqual([1, 1]);
    expect(await alerts.sendOne()).toBe("disabled");
    expect(
      await sql`SELECT sent_at,attempts FROM automation_alert_events`,
    ).toMatchObject([{ sent_at: null, attempts: 0 }]);
  });
  it("replacement does not resolve an alert; final receipt does", async () => {
    const t = await create();
    const alerts = new AutomationAlerts(store);
    await alerts.sync();
    const r = new PostgresRecoveryStore(store);
    await r.startRecovery(
      t,
      await r.saveRecovery(t, replacement, "automatic"),
      "writer-1",
    );
    expect(await alerts.sync()).toBe(1);
    await store.finish(
      t.id,
      { status: "success", blockNumber: 100n, blockHash: keccak256("0xab") },
      replacement.hash,
    );
    expect(await alerts.sync()).toBe(2);
    expect(
      await sql`SELECT event FROM automation_alert_events ORDER BY id`,
    ).toMatchObject([{ event: "firing" }, { event: "resolved" }]);
  });
  it("leased outbox sends in order and concurrent senders do not duplicate", async () => {
    const t = await create();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const delivery = vi.fn(
      async (_alert: import("../src/automatic-alerts.js").AutomationAlert) =>
        gate,
    );
    const a = new AutomationAlerts(store, delivery);
    await a.sync();
    const first = a.sendOne();
    await vi.waitFor(() => expect(delivery).toHaveBeenCalledOnce());
    expect(await a.sendOne()).toBe("idle");
    release();
    expect(await first).toBe("sent");
    await store.finish(t.id, {
      status: "success",
      blockNumber: 100n,
      blockHash: keccak256("0xab"),
    });
    await a.sync();
    expect(await a.sendOne()).toBe("sent");
    expect(delivery.mock.calls[0]![0]).toMatchObject({ event: "firing" });
    expect(delivery.mock.calls[1]![0]).toMatchObject({ event: "resolved" });
  });
  it("delivery failure retains event with safe error and backoff, without changing transaction", async () => {
    const t = await create();
    const a = new AutomationAlerts(store, async () => {
      throw new Error("secret SMTP token");
    });
    await a.sync();
    expect(await a.sendOne()).toBe("failed");
    expect(await a.sendOne()).toBe("idle");
    expect(
      await sql`SELECT last_failure,sent_at FROM automation_alert_events`,
    ).toMatchObject([{ last_failure: "delivery_failed", sent_at: null }]);
    expect((await store.pending())[0]?.hash).toBe(t.hash);
  });
});
