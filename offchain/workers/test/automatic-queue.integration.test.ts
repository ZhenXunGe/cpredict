import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { A, H, env } from "../../app-core/test/fixtures.js";
import { PostgresClaimQueue, retrySeconds } from "../src/automatic-queue.js";
import { PostgresAutomaticStore } from "../src/automatic-store.js";
import {
  AutomaticClaimsWorker,
  type AutomaticAction,
  type AutomationChain,
} from "../src/automatic-claims.js";
import { PostgresFinancialLedger } from "../../indexer/src/financial-store.js";
import { AutomaticClaimDiscovery } from "../src/automatic-discovery.js";
import { LedgerAutomaticSource } from "../src/automatic-source.js";
import { keccak256, type Hex, type PublicClient } from "viem";
import {
  ledgerFactSchema,
  type LedgerSnapshot,
} from "../../app-core/src/ledger-contracts.js";
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of items) result.push(item);
  return result;
}
const url = process.env.TEST_DATABASE_URL;
const snapshot = {
  environment: env.id,
  deploymentId: env.deployment.id,
  version: 1,
  epoch: "1",
  blockNumber: "10",
  blockHash: H(10),
  timestamp: "2000",
  coverageStart: "1",
  complete: true,
  status: "active",
} as LedgerSnapshot;
const owner = A(100),
  market = A(101),
  signer = A(102);
const action: AutomaticAction = {
  key: `winner:${market.toLowerCase()}:${owner.toLowerCase()}`,
  owner,
  kind: "winner",
  target: market,
  data: "0x1234",
  requiresClaimPreference: true,
};
describe.skipIf(!url)("persistent incremental claims queue", () => {
  let admin: ReturnType<typeof postgres>,
    sql: ReturnType<typeof postgres>,
    queue: PostgresClaimQueue,
    store: PostgresAutomaticStore;
  const schema = `claims_queue_${process.pid}_${Date.now()}`;
  beforeAll(async () => {
    admin = postgres(url!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    sql = postgres(scoped.toString(), { max: 6, onnotice: () => {} });
    const migrations = await sql.reserve();
    for (const name of [
      "007_order_automation",
      "008_automation_status_scope",
      "009_automation_canonical_audit",
      "010_automation_cleanup_quotas",
      "011_automation_operations",
      "012_automation_claim_queue",
      "013_actual_automation_gas",
    ])
      await migrations.unsafe(
        await readFile(`offchain/app-service/migrations/${name}.sql`, "utf8"),
      );
    migrations.release();
    // Real ledger shape with disposable minimal catalog; no production connection.
    await sql.unsafe(
      `CREATE TABLE canonical_blocks(chain_id bigint,block_number numeric,block_hash text,block_timestamp numeric,PRIMARY KEY(chain_id,block_number));CREATE TABLE ledger_environment(singleton boolean DEFAULT true,identity text,epoch bigint DEFAULT 1,indexed_block numeric,indexed_hash text,coverage_start numeric,coverage_complete boolean,status text,fact_revision bigint DEFAULT 1);CREATE TABLE ledger_facts(chain_id bigint,block_number numeric,transaction_hash text,transaction_index int,log_index int,fact_index int,occurred_at numeric,kind text,market text,owner text,counterparty text,fact jsonb);CREATE TABLE public_market_metadata(market text,verified boolean,question text,rules jsonb);CREATE TABLE chain_checkpoints(chain_id bigint,block_number numeric);CREATE TABLE chain_events(chain_id bigint,transaction_hash text,block_number numeric,block_hash text,log_index int,observed_at timestamptz DEFAULT now());`,
    );
    queue = new PostgresClaimQueue(sql, 421614, env.deployment.id);
    store = new PostgresAutomaticStore(
      sql,
      421614,
      env.deployment.id,
      signer,
      "claims",
      () => {},
      true,
    );
  });
  beforeEach(async () => {
    await sql.unsafe(
      "TRUNCATE automation_claim_candidates,automation_claim_scopes,automation_discovery,automation_attempts,automation_recoveries,automation_alert_events,automation_transactions,automatic_claim_preferences,automation_lane_status,ledger_facts,ledger_environment,canonical_blocks,chain_checkpoints CASCADE",
    );
    await sql`INSERT INTO canonical_blocks VALUES(421614,10,${H(10)},2000)`;
    await sql`INSERT INTO ledger_environment(identity,epoch,indexed_block,indexed_hash,coverage_start,coverage_complete,status) VALUES('test',1,10,${H(10)},1,true,'active')`;
    await queue.progress(snapshot, "1");
  });
  afterAll(async () => {
    await sql?.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  const wake = async () => {
    const [d] = await sql`SELECT cursor_block::text FROM automation_discovery`;
    await queue.ingest("1", d!.cursor_block, "10", H(10), [
      { owner, scope: market.toLowerCase(), triggerAt: new Date() },
    ]);
    return (await queue.dueScopes())[0]!;
  };
  const ready = async (a = action) => {
    const scope = await wake();
    await queue.discovered(scope, [a], null);
    return scope;
  };
  it("commits cursor and deduplicated wakes together; stale cursor cannot advance", async () => {
    await wake();
    await wake();
    expect(await queue.dueScopes()).toHaveLength(1);
    const [s] = await sql`SELECT version FROM automation_claim_scopes`;
    expect(s!.version).toBe("2");
    expect(
      await queue.ingest("1", "0", "10", H(10), [
        { owner: A(200), scope: "*", triggerAt: new Date() },
      ]),
    ).toBe(false);
    expect(await queue.dueScopes()).toHaveLength(1);
  });
  it("a failure rolls back the cursor along with wakeups", async () => {
    await expect(
      queue.ingest("1", "0", "10", H(10), [
        { owner, scope: null as never, triggerAt: new Date() },
      ]),
    ).rejects.toThrow();
    const [d] = await sql`SELECT cursor_block::text FROM automation_discovery`;
    expect(d!.cursor_block).toBe("0");
    expect(await queue.dueScopes()).toHaveLength(0);
  });
  it("a newer event cannot be overwritten by an older scan", async () => {
    const scope = await wake();
    await wake();
    await queue.discovered(scope, [action], null);
    expect(await collect(queue.candidates())).toEqual([]);
    expect(await queue.dueScopes()).toHaveLength(1);
  });
  it("atomically links candidates to journal and survives process restart", async () => {
    await ready();
    const raw = "0x123456" as Hex;
    const tx = await store.save(action, {
      raw,
      hash: keccak256(raw),
      nonce: 0n,
      maximumCost: 1n,
    });
    expect(
      await collect(
        new PostgresClaimQueue(sql, 421614, env.deployment.id).candidates(),
      ),
    ).toHaveLength(0);
    expect((await store.pending())[0]?.hash).toBe(tx.hash);
    expect(await queue.summary(owner)).toMatchObject({
      state: "queued",
      inFlightCount: 0,
      readyCount: 1,
    });
    await store.status(owner, "gas_balance_insufficient");
    expect(await queue.summary(A(200))).toMatchObject({
      state: "paused",
      reason: "gas_balance_insufficient",
      readyCount: 0,
    });
    await expect(
      store.save(action, {
        raw,
        hash: keccak256(raw),
        nonce: 1n,
        maximumCost: 1n,
      }),
    ).rejects.toThrow("claims_candidate_changed");
    await store.finish(tx.id, {
      status: "success",
      blockNumber: 10n,
      blockHash: H(10),
    });
    const [c] = await sql`SELECT state FROM automation_claim_candidates`;
    expect(c!.state).toBe("done");
  });
  it("opt-out preserves in-flight history and re-enable schedules historical discovery", async () => {
    await ready();
    await store.setEnabled(owner, false);
    expect(await collect(queue.candidates())).toHaveLength(0);
    await store.setEnabled(owner, true);
    expect((await queue.dueScopes()).some((s) => s.scope === "*")).toBe(true);
    // Both operations lock scope before candidate, so either ordering is safe.
    for (let attempt = 0; attempt < 10; attempt++) {
      await store.setEnabled(owner, true);
      const scope = (await queue.dueScopes()).find((s) => s.scope === "*")!;
      await Promise.all([
        queue.discovered(scope, [action], null),
        store.setEnabled(owner, false),
      ]);
      expect(await collect(queue.candidates())).toEqual([]);
    }
  });
  it("reorg invalidates unsigned candidates but keeps signed transactions", async () => {
    await ready();
    await queue.progress({ ...snapshot, epoch: "2" }, "1");
    expect(await collect(queue.candidates())).toEqual([]);
    expect(await queue.dueScopes()).toEqual([]);
    await queue.progress(snapshot, "1");
    await ready();
    const raw = "0x123456" as Hex;
    await store.save(action, {
      raw,
      hash: keccak256(raw),
      nonce: 0n,
      maximumCost: 1n,
    });
    await queue.progress({ ...snapshot, epoch: "2" }, "1");
    expect(await store.pending()).toHaveLength(1);
  });
  it("failed scopes back off and cannot monopolize unrelated work", async () => {
    const scope = await wake();
    await queue.failedScope(scope, "chain_check_rate_limit");
    expect(await queue.dueScopes()).toEqual([]);
    expect([0, 1, 2, 3, 4, 5].map(retrySeconds)).toEqual([
      2, 5, 15, 30, 60, 60,
    ]);
    const summary = await queue.summary(owner);
    expect(summary.state).toBe("paused");
  });
  it("starts a fresh event clock when waking a dormant future deadline", async () => {
    const old = new Date(1000),
      current = new Date();
    await queue.ingest("1", "0", "10", H(10), [
      { owner, scope: market, triggerAt: old, indexedAt: old },
    ]);
    await queue.discovered(
      (await queue.dueScopes())[0]!,
      [],
      new Date(Date.now() + 3600000),
    );
    await queue.ingest("1", "10", "10", H(10), [
      { owner, scope: market, triggerAt: current, indexedAt: current },
    ]);
    const scope = (await queue.dueScopes())[0]!;
    expect(scope.trigger_at).toEqual(current);
    expect(scope.indexed_at).toEqual(current);
    await queue.discovered(scope, [action], null);
    const [candidate] =
      await sql`SELECT trigger_at,indexed_at FROM automation_claim_candidates`;
    expect(candidate!.trigger_at).toEqual(current);
    expect(candidate!.indexed_at).toEqual(current);
  });
  it("retains the original clock for a failed scope despite its future retry", async () => {
    const old = new Date(1000);
    await queue.ingest("1", "0", "10", H(10), [
      { owner, scope: market, triggerAt: old, indexedAt: old },
    ]);
    await queue.failedScope(
      (await queue.dueScopes())[0]!,
      "chain_check_rate_limit",
    );
    await queue.ingest("1", "10", "10", H(10), [
      { owner, scope: market, triggerAt: new Date() },
    ]);
    const scope = (await queue.dueScopes())[0]!;
    expect(scope.trigger_at).toEqual(old);
    expect(scope.indexed_at).toEqual(old);
  });
  it("preserves an already queued candidate's clock when its scope has a deadline", async () => {
    const old = new Date(1000);
    await queue.ingest("1", "0", "10", H(10), [
      { owner, scope: market, triggerAt: old, indexedAt: old },
    ]);
    await queue.discovered(
      (await queue.dueScopes())[0]!,
      [action],
      new Date(Date.now() + 3600000),
    );
    await queue.ingest("1", "10", "10", H(10), [
      { owner, scope: market, triggerAt: new Date() },
    ]);
    await queue.discovered((await queue.dueScopes())[0]!, [action], null);
    const rows =
      await sql`SELECT trigger_at,indexed_at FROM automation_claim_candidates`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.trigger_at).toEqual(old);
    expect(rows[0]!.indexed_at).toEqual(old);
  });
  it("reports only the current owner, includes global blocking without private hashes", async () => {
    await ready();
    expect(await queue.summary(A(200))).toMatchObject({
      readyCount: 0,
      inFlightCount: 0,
    });
    expect(await queue.summary(owner)).toMatchObject({
      state: "queued",
      readyCount: 1,
    });
    const blocked = await queue.summary(
      A(200),
      "queue_blocked_unknown_transaction",
    );
    expect(blocked.state).toBe("paused");
    expect(JSON.stringify(blocked)).not.toContain(action.key);
    await sql`UPDATE automation_discovery SET updated_at=now()-interval '3 minutes'`;
    expect((await queue.summary(owner)).state).toBe("unavailable");
  });
  it("concurrent discovery processes acquire only one lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered = false;
    const first = queue.exclusive(async () => {
      entered = true;
      await gate;
      return 1;
    });
    while (!entered) await new Promise((r) => setTimeout(r, 1));
    expect(
      await new PostgresClaimQueue(sql, 421614, env.deployment.id).exclusive(
        async () => 2,
      ),
    ).toBeUndefined();
    release();
    expect(await first).toBe(1);
  });
  it("incremental market resolution wakes unregistered holders and filters unrelated history", async () => {
    const f = ledgerFactSchema.parse({
      id: "purchase",
      kind: "primary-buy",
      blockNumber: "9",
      blockHash: H(9),
      transactionHash: H(99),
      transactionIndex: 0,
      logIndex: 0,
      factIndex: 0,
      timestamp: "1999",
      market,
      owner,
      counterparty: null,
      outcomeId: "0",
      listingId: null,
      units: "10",
      amount: "10",
      extra: { score: "1" },
    });
    await sql`INSERT INTO ledger_facts VALUES(421614,9,${H(99)},0,0,0,1999,'primary-buy',${market.toLowerCase()},${owner.toLowerCase()},NULL,${sql.json(f)})`;
    await sql`INSERT INTO ledger_facts VALUES(421614,10,${H(100)},0,0,0,2000,'market-resolved',${market.toLowerCase()},NULL,NULL,${sql.json({ ...f, id: "resolve", kind: "market-resolved", owner: null, blockNumber: "10" })})`;
    await sql`UPDATE automation_discovery SET cursor_block=9,backstop_due=now()+interval '1 day'`;
    const values: Record<string, unknown> = {
      marketState: 1,
      voidReason: 0,
      winningOutcome: 0,
      outcomeCount: 2,
      remainingWinnerPool: 10n,
      remainingWinningUnits: 10n,
      remainingEarlyBirdPool: 1n,
      remainingEarlyBirdScore: 1n,
      earlyBirdScore: 1n,
      timeoutBonusUnits: 0n,
      bondOf: [owner, 0n, true],
      creditOf: 0n,
    };
    let reads = 0;
    const client = {
      getBlock: async () => ({ number: 10n, hash: H(10), timestamp: 2000n }),
      readContract: vi.fn(
        async ({
          functionName,
          args,
        }: {
          functionName: string;
          args: unknown[];
        }) => {
          reads++;
          return functionName === "balanceOf"
            ? args[1] === 0n
              ? 10n
              : 0n
            : values[functionName];
        },
      ),
    } as unknown as PublicClient;
    const ledger = new PostgresFinancialLedger(sql, env),
      source = new LedgerAutomaticSource(ledger, client, store),
      discovery = new AutomaticClaimDiscovery(queue, ledger, source);
    await discovery.tick();
    expect((await collect(queue.candidates())).map((a) => a.kind)).toEqual([
      "winner",
      "early-bird",
    ]);
    const first = reads;
    await discovery.tick();
    expect(reads).toBe(first);
    await sql`UPDATE ledger_environment SET coverage_complete=false`;
    await expect(discovery.tick()).rejects.toThrow("index_incomplete");
    expect((await queue.summary(owner)).reason).toBe(
      "automatic_claims_index_incomplete",
    );
  });
  it("failed candidates leave the first page and accounts take turns", async () => {
    const first = await wake();
    await queue.discovered(
      first,
      Array.from({ length: 25 }, (_, i) => ({
        ...action,
        key: `backlog:${i}`,
      })),
      null,
    );
    await queue.ingest("1", "10", "10", H(10), [
      { owner: A(200), scope: "*", triggerAt: first.trigger_at },
    ]);
    const second = (await queue.dueScopes()).find(
      (s) => s.owner === A(200).toLowerCase(),
    )!;
    await queue.discovered(
      second,
      [{ ...action, key: "other", owner: A(200) }],
      null,
    );
    expect(
      (await collect(queue.candidates()))
        .slice(0, 2)
        .map((a) => a.owner.toLowerCase()),
    ).toContain(A(200).toLowerCase());
    for (const a of await collect(queue.candidates()))
      await queue.reject(a, "retry_after_chain_check");
    expect((await collect(queue.candidates())).length).toBeLessThan(20);
  });
  it("reconciles transactions finalized by an older worker during rollback", async () => {
    await ready();
    const raw = "0x123456" as Hex;
    const tx = await store.save(action, {
      raw,
      hash: keccak256(raw),
      nonce: 0n,
      maximumCost: 1n,
    });
    await sql`UPDATE automation_transactions SET state='confirmed',raw_transaction=NULL WHERE id=${tx.id}`;
    await queue.progress(snapshot, "1");
    const [c] =
      await sql`SELECT state,transaction_id FROM automation_claim_candidates`;
    expect(c).toMatchObject({ state: "done", transaction_id: null });
  });
  it("a stored deadline wakes a market without any new fact; opt-out invalidates an active scan", async () => {
    const scope = await wake();
    await queue.discovered(scope, [], new Date(Date.now() - 1));
    expect(await queue.dueScopes()).toHaveLength(1);
    const scanning = (await queue.dueScopes())[0]!;
    await store.setEnabled(owner, false);
    await queue.discovered(scanning, [action], null);
    expect(await collect(queue.candidates())).toEqual([]);
  });
  it("share transfers wake both endpoints and aggregate credits share one scope", async () => {
    await sql`UPDATE automation_discovery SET backstop_due=now()+interval '1 day'`;
    const f = ledgerFactSchema.parse({
      id: "transfer",
      kind: "share-transfer",
      blockNumber: "10",
      blockHash: H(10),
      transactionHash: H(99),
      transactionIndex: 0,
      logIndex: 0,
      factIndex: 0,
      timestamp: "2000",
      market,
      owner,
      counterparty: A(200),
      outcomeId: "0",
      listingId: null,
      units: "10",
      amount: null,
      extra: {},
    });
    await sql`INSERT INTO ledger_facts VALUES(421614,10,${H(99)},0,0,0,2000,'share-transfer',${market.toLowerCase()},${owner.toLowerCase()},${A(200).toLowerCase()},${sql.json(f)})`;
    const source = {
      client: {
        getBlock: async () => ({ number: 10n, hash: H(10), timestamp: 2000n }),
      },
      async *candidates() {},
    } as unknown as LedgerAutomaticSource;
    const ledger = new PostgresFinancialLedger(sql, env);
    await new AutomaticClaimDiscovery(queue, ledger, source).tick();
    const scopes =
      await sql`SELECT owner,scope FROM automation_claim_scopes ORDER BY owner`;
    expect(scopes).toHaveLength(2);
    expect(scopes.map((s) => s.owner)).toContain(A(200).toLowerCase());
    await queue.ingest("1", "10", "10", H(10), [
      { owner, scope: "aggregate", triggerAt: new Date() },
      { owner, scope: "aggregate", triggerAt: new Date() },
    ]);
    expect(
      (await queue.dueScopes()).filter((s) => s.scope === "aggregate"),
    ).toHaveLength(1);
  });
  it("20 small batches retain candidates and finish without idle gaps", async () => {
    const durations: number[] = [];
    for (let round = 0; round < 20; round++) {
      await sql.unsafe(
        "TRUNCATE automation_claim_candidates,automation_claim_scopes,automation_attempts,automation_recoveries,automation_alert_events,automation_transactions CASCADE",
      );
      const scope = await wake(),
        actions = Array.from({ length: 7 }, (_, i) => ({
          ...action,
          key: `round:${round}:${i}`,
          owner: A(100 + (i % 3)),
          kind:
            i === 0 ? "settle-bond:" + market : i % 2 ? "winner" : "early-bird",
        }));
      // Each owner's scoped discovery has its own durable version.
      for (const a of actions) {
        await queue.ingest("1", "10", "10", H(10), [
          { owner: a.owner, scope: "*", triggerAt: new Date() },
        ]);
      }
      for (const s of await queue.dueScopes())
        await queue.discovered(
          s,
          actions.filter((a) => a.owner === s.owner),
          null,
        );
      let nonce = 0n,
        clock = 0;
      const receiptTimes = new Map<Hex, number>();
      const chain: AutomationChain = {
        eligible: async () => true,
        prepare: async () => {
          const raw =
            `0x${(round * 100 + Number(nonce) + 1).toString(16).padStart(4, "0")}` as Hex;
          return { raw, hash: keccak256(raw), nonce: nonce++, maximumCost: 1n };
        },
        send: async (raw) => {
          const hash = keccak256(raw);
          receiptTimes.set(hash, clock + 2);
          return hash;
        },
        receipt: async (hash) =>
          clock >= (receiptTimes.get(hash) ?? Infinity)
            ? { status: "success", blockNumber: 10n, blockHash: H(10) }
            : null,
        canonicalFinal: async () => true,
        balance: async () => 100000n,
      };
      const worker = new AutomaticClaimsWorker(store, chain, queue, 100000n);
      while (clock < 30) {
        await worker.tick();
        if (
          (await store.pending()).length === 0 &&
          (await collect(queue.candidates())).length === 0
        )
          break;
        clock += 2;
      }
      const [count] =
        await sql`SELECT count(*)::int AS n FROM automation_transactions WHERE state='confirmed'`;
      expect(count!.n).toBe(7);
      expect(clock).toBeLessThanOrEqual(30);
      durations.push(clock);
    }
    expect(durations).toHaveLength(20);
    console.log(
      JSON.stringify({
        proof: "virtual-2-second-chain-real-postgres-queue",
        rounds: 20,
        maxSeconds: Math.max(...durations),
      }),
    );
  }, 30000);
});
