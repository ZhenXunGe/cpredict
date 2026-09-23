import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresEventStore } from "../src/postgres-store.js";
import { env, H } from "../../app-core/test/fixtures.js";
import {
  block,
  createMarket,
  purchase,
  raw,
  seller,
  vault,
} from "./financial-fixtures.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("scoped creation repair PostgreSQL invariants", () => {
  let admin: ReturnType<typeof postgres>,
    sql: ReturnType<typeof postgres>,
    store: PostgresEventStore,
    schema: string;
  const initialization = () => [
    createMarket()[1]!,
    raw(
      "MarketMetadataUpdated",
      vault,
      {
        rulesHash: H(501),
        metadataURI: "https://example.test/rules/{id}.json",
        resolutionSourceHash: H(502),
        resolutionSourceURI: "https://example.test/result",
        closeAt: 1000n,
        eventStartsAt: 1001n,
        outcomeDeadlineAt: 2000n,
        creatorTreasury: seller,
        featureFlags: 1n,
      },
      1,
      2,
    ),
  ];
  beforeEach(async () => {
    schema = `creation_repair_${process.pid}_${Date.now()}`;
    admin = postgres(url!, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    sql = postgres(scoped.toString(), { max: 1, onnotice: () => undefined });
    for (const file of [
      "001_indexer.sql",
      "002_settlement_evidence.sql",
      "003_read_api_indexes.sql",
      "004_market_metadata.sql",
      "005_activity_catalog.sql",
      "006_financial_facts.sql",
      "007_legacy_deployment.sql",
      "009_sparse_canonical_ranges.sql",
      "011_ledger_fact_revision.sql",
    ])
      await sql.unsafe(
        await readFile(
          new URL(`../migrations/${file}`, import.meta.url),
          "utf8",
        ),
      );
    store = new PostgresEventStore(scoped.toString(), 2, env);
    await store.applyBatch([createMarket()[0]!], [block(1)], block(1));
    await store.applyBatch([], [block(2), block(3)], block(3));
  });
  afterEach(async () => {
    await store?.close();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  it("fills the placeholder and financial facts without moving the checkpoint or duplicating a repeat", async () => {
    const checkpoint = await store.checkpoint(env.deployment.chainId);
    await store.repairMarketCreation(vault, initialization(), block(1));
    expect(await store.market(env.deployment.chainId, vault)).toMatchObject({
      outcomeCount: 2,
      rulesHash: H(501),
      closeAt: 1000n,
    });
    expect(await store.checkpoint(env.deployment.chainId)).toEqual(checkpoint);
    const facts =
      await sql`SELECT fact FROM ledger_facts ORDER BY log_index,fact_index`;
    expect(facts.some((row) => row.fact.kind === "market-initialized")).toBe(
      true,
    );
    await expect(
      store.repairMarketCreation(vault, initialization(), block(1)),
    ).rejects.toThrow("untouched incomplete creation");
    expect(
      await sql`SELECT fact FROM ledger_facts ORDER BY log_index,fact_index`,
    ).toEqual(facts);
    expect((await sql`SELECT count(*)::int AS n FROM chain_events`)[0]!.n).toBe(
      3,
    );
  });
  it("rolls the entire repair back when the stored canonical hash differs", async () => {
    await expect(
      store.repairMarketCreation(vault, initialization(), {
        ...block(1),
        blockHash: H(999),
      }),
    ).rejects.toThrow("canonical block mismatch");
    expect(
      (await store.market(env.deployment.chainId, vault))?.rulesHash,
    ).toBeNull();
    expect((await sql`SELECT count(*)::int AS n FROM chain_events`)[0]!.n).toBe(
      1,
    );
  });
  it("refuses to overwrite a market that has already traded", async () => {
    await store.applyBatch(purchase(3), [block(3)], block(3));
    await expect(
      store.repairMarketCreation(vault, initialization(), block(1)),
    ).rejects.toThrow("untouched incomplete creation");
    expect(
      (await store.market(env.deployment.chainId, vault))?.primaryPayment,
    ).toBe(100n);
  });
  it("refuses events from a different transaction or an incomplete repair", async () => {
    await expect(
      store.repairMarketCreation(
        vault,
        initialization().map((e) => ({ ...e, transactionHash: H(999) })),
        block(1),
      ),
    ).rejects.toThrow("untouched incomplete creation");
    await expect(
      store.repairMarketCreation(vault, [initialization()[0]!], block(1)),
    ).rejects.toThrow("initialization and metadata only");
    expect((await sql`SELECT count(*)::int AS n FROM chain_events`)[0]!.n).toBe(
      1,
    );
  });
});
