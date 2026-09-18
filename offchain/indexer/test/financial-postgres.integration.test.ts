import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createPublicClient, http } from "viem";
import { z } from "zod";
import { createIndexerApi } from "../src/api.js";
import { SiteApi } from "../../../examples/user-site/src/api.js";
import {
  listingSchema,
  marketSchema,
  page,
} from "../../app-core/src/catalog-contracts.js";
import { factsPageSchema } from "../../app-core/src/ledger-contracts.js";
import { env } from "../../app-core/test/fixtures.js";
import { PostgresEventStore } from "../src/postgres-store.js";
import { block, createMarket, purchase, trader } from "./financial-fixtures.js";
import { publicCatalog } from "../src/public-catalog.js";
import { platformFeesSchema } from "../../app-core/src/report-contracts.js";
import { A, H } from "../../app-core/test/fixtures.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("financial projection PostgreSQL invariants", () => {
  const schema = `cpredict_financial_${process.pid}_${Date.now()}`;
  let admin: ReturnType<typeof postgres>,
    sql: ReturnType<typeof postgres>,
    store: PostgresEventStore;
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
    store = new PostgresEventStore(scoped.toString(), 3, env);
    await store.ready();
    await sql`INSERT INTO ledger_tracked_accounts(address,from_block) VALUES(${trader.toLowerCase()},1)`;
  });
  afterAll(async () => {
    await store?.close();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  it("writes eventless watermark, raw events and financial facts in the same transaction", async () => {
    await store.applyBatch(createMarket(), [block(1)], block(1));
    await store.applyBatch(purchase(), [block(2)], block(2));
    await store.applyBatch([], [block(3)], block(3));
    await store.financial!.accountScanned([trader], 1n, 3n, block(3).blockHash);
    const result = await store.financial!.pnl(trader);
    expect(result.snapshot).toMatchObject({
      blockNumber: "3",
      complete: true,
      status: "shadow",
    });
    expect(result.pnl.lots[0]).toMatchObject({
      units: "100",
      knownCost: "100",
    });
    expect(result.pnl.realizedNet).toBe("0");
  });
  it("keeps replay idempotent and does not let it manufacture complete coverage", async () => {
    const before =
      await sql`SELECT fact FROM ledger_facts ORDER BY block_number,transaction_index,log_index,fact_index`;
    await store.replayFinancial(1n, 3n);
    await store.replayFinancial(1n, 3n);
    const after =
      await sql`SELECT fact FROM ledger_facts ORDER BY block_number,transaction_index,log_index,fact_index`;
    expect(after).toEqual(before);
    expect((await store.financial!.snapshot()).epoch).toBe("3");
  });
  it("serves the public client and existing API contracts in one process", async () => {
    const app = createIndexerApi(store, {
      financial: {
        ledger: store.financial!,
        client: createPublicClient({ transport: http("http://127.0.0.1:1") }),
        confirmations: 3n,
      },
    });
    const basePath = await app.listen({ host: "127.0.0.1", port: 0 });
    vi.stubGlobal("window", { location: { origin: basePath } });
    vi.stubGlobal("location", { origin: basePath });
    try {
      const site = new SiteApi({
        ...env,
        services: { ...env.services, indexer: `${basePath}/public` },
      });
      const legacyQuery = `chainId=${env.deployment.chainId}&limit=1`;
      const legacyRequest = async <T>(path: string, schema: z.ZodType<T>) => {
        const response = await app.inject(`${path}?${legacyQuery}`);
        expect(response.statusCode).toBe(200);
        return schema.parse(response.json<unknown>());
      };
      const legacyMarkets = await legacyRequest(
        "/v2/markets",
        z.object({
          items: z.array(z.object({ market: z.string(), status: z.string() })),
        }),
      );
      const publicMarkets = await site.request(
        "/v2/markets?limit=1",
        page(marketSchema),
        { service: "indexer" },
      );
      expect(legacyMarkets.items[0]!.market).toBe(
        publicMarkets.items[0]!.market,
      );
      expect(legacyMarkets.items[0]!.status).toBe("open");
      expect(publicMarkets.snapshot!.blockNumber).toBe("3");
      const publicFees = await site.request(
        "/v2/platform-fees",
        platformFeesSchema,
        { service: "indexer" },
      );
      expect(publicFees.accrued).toBe("0");
      expect(Object.keys(publicFees).sort()).toEqual([
        "accrued",
        "complete",
        "snapshot",
      ]);
      expect(
        await legacyRequest(
          "/v1/listings",
          z.object({ items: z.array(z.unknown()) }),
        ),
      ).toMatchObject({ items: [] });
      expect(
        (
          await site.request("/v1/listings", page(listingSchema), {
            service: "indexer",
          })
        ).items,
      ).toEqual([]);
      const oldHistory = await legacyRequest(
        `/v2/activity/${trader}`,
        z.object({
          items: z.array(z.object({ kind: z.string(), amount: z.string() })),
        }),
      );
      const first = await site.request(
        `/v2/activity/${trader}?limit=1`,
        factsPageSchema,
        { service: "indexer" },
      );
      expect(oldHistory.items[0]!.kind).toBe("primary-purchased");
      expect(oldHistory.items[0]!.amount).toBe("100");
      expect(first.items).toHaveLength(1);
      expect(first.snapshot.blockNumber).toBe("3");
      const detail = () =>
        site.request(`/v2/markets/${A(101)}`, marketSchema, {
          service: "indexer",
        });
      const withoutMetadata = await detail();
      expect(withoutMetadata.question).toBeNull();
      const rulesHash = H(71);
      await sql`UPDATE markets SET rules_hash=${rulesHash} WHERE market=${A(101)}`;
      await sql`INSERT INTO public_market_metadata(market,rules_hash,question,verified) VALUES(${A(101).toLowerCase()},${rulesHash},'测试市场 Alpha 100%',true) ON CONFLICT(market) DO UPDATE SET rules_hash=excluded.rules_hash,question=excluded.question,verified=true`;
      const namedDetail = await detail();
      const namedList = await site.request(
        `/v2/markets?q=Alpha`,
        page(marketSchema),
        { service: "indexer" },
      );
      expect(namedDetail.question).toBe("测试市场 Alpha 100%");
      expect(namedList.items[0]?.question).toBe(namedDetail.question);
      await sql`UPDATE public_market_metadata SET verified=false WHERE market=${A(101).toLowerCase()}`;
      expect((await detail()).question).toBeNull();
      await sql`UPDATE public_market_metadata SET verified=true,rules_hash=${H(999)} WHERE market=${A(101).toLowerCase()}`;
      expect((await detail()).question).toBeNull();
      await sql`UPDATE public_market_metadata SET rules_hash=${rulesHash} WHERE market=${A(101).toLowerCase()}`;
      const named = await site.request(
        `/v2/activity/${trader}?marketQuery=${encodeURIComponent("alpha 100%")}&limit=1`,
        factsPageSchema,
        { service: "indexer" },
      );
      expect(named.items).toHaveLength(1);
      expect(named.items[0]!.market?.toLowerCase()).toBe(A(101).toLowerCase());
      expect(
        (
          await site.request(
            `/v2/activity/${trader}?marketQuery=absent`,
            factsPageSchema,
            { service: "indexer" },
          )
        ).items,
      ).toEqual([]);
      expect(
        (
          await site.request(
            `/v2/activity/${trader}?marketQuery=_`,
            factsPageSchema,
            { service: "indexer" },
          )
        ).items,
      ).toEqual([]);
      if (named.nextCursor)
        await expect(
          site.request(
            `/v2/activity/${trader}?marketQuery=another&cursor=${encodeURIComponent(named.nextCursor)}`,
            factsPageSchema,
            { service: "indexer" },
          ),
        ).rejects.toBeTruthy();
      await sql`DELETE FROM public_market_metadata WHERE market=${A(101).toLowerCase()}`;
      const txHash = first.items[0]!.transactionHash;
      const exact = await site.request(
        `/v2/activity/${trader}?transactionHash=${txHash}&limit=1`,
        factsPageSchema,
        { service: "indexer" },
      );
      expect(exact.items).toHaveLength(1);
      expect(exact.items.every((f) => f.transactionHash === txHash)).toBe(true);
      const absent = await site.request(
        `/v2/activity/${trader}?transactionHash=${H(999)}`,
        factsPageSchema,
        { service: "indexer" },
      );
      expect(absent.items).toEqual([]);
      await expect(
        site.request(
          `/v2/activity/${trader}?transactionHash=invalid`,
          factsPageSchema,
          { service: "indexer" },
        ),
      ).rejects.toBeDefined();
      if (first.nextCursor)
        await expect(
          site.request(
            `/v2/activity/${trader}?transactionHash=${txHash}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
            factsPageSchema,
            { service: "indexer" },
          ),
        ).rejects.toBeDefined();
      if (exact.nextCursor) {
        const nextExact = await site.request(
          `/v2/activity/${trader}?transactionHash=${txHash}&limit=1&cursor=${encodeURIComponent(exact.nextCursor)}`,
          factsPageSchema,
          { service: "indexer" },
        );
        expect(nextExact.items.every((f) => f.transactionHash === txHash)).toBe(
          true,
        );
      }

      if (first.nextCursor) {
        const next = await site.request(
          `/v2/activity/${trader}?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
          factsPageSchema,
          { service: "indexer" },
        );
        expect(next.items[0]!.id).not.toBe(first.items[0]!.id);
      }
      for (const path of [
        "/v2/markets",
        `/v2/markets/${A(101)}`,
        "/v1/listings",
        `/v2/activity/${trader}`,
        `/v2/pnl/${trader}`,
        "/v2/sync-status",
        "/v2/platform-fees",
      ]) {
        for (const query of [
          "",
          `environment=wrong&deploymentId=${env.deployment.id}`,
          `environment=${env.id}&deploymentId=wrong`,
          `environment=${env.id}&deploymentId=${env.deployment.id}&chainId=1`,
        ]) {
          expect((await app.inject(`/public${path}?${query}`)).statusCode).toBe(
            400,
          );
        }
      }
      expect(
        (
          await app.inject(
            `/v2/pnl/${trader}?chainId=${env.deployment.chainId}`,
          )
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject(
            `/v1/listings?chainId=${env.deployment.chainId}&cursor=100001`,
          )
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await site.request(`/v2/markets/${A(101)}`, marketSchema, {
            service: "indexer",
          })
        ).market,
      ).toBe(A(101));
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });
  it("binds pagination to filters and invalidates old snapshots after a reorg", async () => {
    await store.applyBatch(purchase(4), [block(4)], block(4));
    await store.financial!.accountScanned([trader], 4n, 4n, block(4).blockHash);
    const first = await store.financial!.activity({ owner: trader, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf("string");
    const second = await store.financial!.activity({
      owner: trader,
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    await expect(
      store.financial!.activity({
        owner: A(99),
        limit: 1,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "cursor_filter_mismatch" });
    await sql`INSERT INTO ledger_tracked_accounts(address,from_block) VALUES(${A(33).toLowerCase()},1)`;
    await store.rollbackAfter(env.deployment.chainId, 1n);
    expect(
      (
        await sql`SELECT through_block FROM ledger_tracked_accounts WHERE address=${A(33).toLowerCase()}`
      )[0]!.through_block,
    ).toBeNull();
    await expect(
      store.financial!.assertSnapshot(first.snapshot),
    ).rejects.toMatchObject({ code: "snapshot_invalidated" });
    expect((await store.financial!.pnl(trader)).pnl.lots).toEqual([]);
    const corrections =
      await sql`SELECT reason FROM ledger_corrections ORDER BY id`;
    expect(corrections.map((r) => r.reason)).toEqual([
      "projection_replay",
      "projection_replay",
      "chain_reorganization",
    ]);
  });
  it("serves verified title search and creator filters without changing a retained catalog snapshot", async () => {
    await sql`UPDATE markets SET rules_hash=${"0x" + "a".repeat(64)} WHERE market=${A(101)}`;
    await sql`INSERT INTO public_market_metadata(market,rules_hash,question,verified,checked_at) VALUES(${A(101).toLowerCase()},${"0x" + "a".repeat(64)},'完整退出测试市场',true,'2026-09-09T00:00:00Z')`;
    const first = await publicCatalog(store.financial!, "markets", {
      q: "退出",
      creator: A(12),
    });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ question: "完整退出测试市场" });
    expect(
      (await publicCatalog(store.financial!, "markets", { q: "不存在" })).items,
    ).toEqual([]);
    expect(
      (await publicCatalog(store.financial!, "markets", { creator: A(99) }))
        .items,
    ).toEqual([]);
    await sql`UPDATE public_market_metadata SET question='修改后的已核对问题',checked_at='2026-09-09T00:01:00Z'`;
    expect(
      (
        await publicCatalog(store.financial!, "markets", {
          q: "退出",
          creator: A(12),
        })
      ).items,
    ).toEqual([]);
    expect(first.items[0]).toMatchObject({ question: "完整退出测试市场" });
  });
  it("serves simultaneous catalog reads when another reader expires the snapshot cache", async () => {
    await sql`UPDATE public_query_snapshots SET created_at=now()-interval '31 minutes'`;
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const blocker = sql.begin(async (db) => {
      await db`SELECT pg_advisory_xact_lock(hashtextextended('public-query-snapshots',0))`;
      acquired();
      await gate;
    });
    await ready;
    const reads = Promise.allSettled(
      Array.from({ length: 3 }, () =>
        publicCatalog(store.financial!, "markets", {}),
      ),
    );
    try {
      // All three readers must acquire their repeatable-read snapshots before
      // the first one deletes the expired rows. This reproduces the live 40001.
      await vi.waitFor(
        async () => {
          const waiting = await admin<{ count: number }[]>`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE wait_event='advisory' AND query LIKE '%public-query-snapshots%'
        `;
          expect(waiting[0]!.count).toBe(3);
        },
        { timeout: 5000, interval: 10 },
      );
    } finally {
      release();
      await blocker;
    }
    const results = await reads;
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    const pages = results.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    expect(pages[1]).toEqual(pages[0]);
    expect(pages[2]).toEqual(pages[0]);
  });
  it("rolls back the entire batch when a recognized financial log is corrupt", async () => {
    const bad = { ...purchase()[1]!, data: "0x" as const };
    await expect(
      store.applyBatch([bad], [block(2)], block(2)),
    ).rejects.toThrow();
    expect((await store.checkpoint(env.deployment.chainId))?.blockNumber).toBe(
      1n,
    );
    expect(
      await store.canonicalBlock(env.deployment.chainId, 2n),
    ).toBeUndefined();
  });
});
