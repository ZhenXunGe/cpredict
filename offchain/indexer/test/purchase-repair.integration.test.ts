import { entryPoint07Address } from "viem/account-abstraction";
import type { PublicClient, TransactionReceipt } from "viem";
import { reconcileConfirmedPurchases } from "../src/purchase-reconciliation.js";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresEventStore } from "../src/postgres-store.js";
import { env, H, A, operation } from "../../app-core/test/fixtures.js";
import {
  block,
  createMarket,
  purchase,
  raw,
  seller,
  trader,
  vault,
} from "./financial-fixtures.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("confirmed purchase receipt PostgreSQL repair", () => {
  let admin: ReturnType<typeof postgres>,
    sql: ReturnType<typeof postgres>,
    store: PostgresEventStore,
    schema: string;
  beforeEach(async () => {
    schema = `purchase_repair_${process.pid}_${Date.now()}`;
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
    await store.ready();
    await store.applyBatch(createMarket(), [block(1)], block(1));
    await store.applyBatch({
      range: {
        chainId: env.deployment.chainId,
        fromBlock: 2n,
        toBlock: 3n,
        predecessor: block(1),
        endBlockHash: block(3).blockHash,
        confirmationStatus: "confirmed",
        mode: "sparse",
      },
      anchors: [block(3)],
      events: [],
      checkpoint: block(3),
    });
  });
  afterEach(async () => {
    await store?.close();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("restores missed earlier purchase without regressing later market totals, then is idempotent", async () => {
    const later = purchase(3, seller);
    later[1] = raw(
      "PrimaryPurchased",
      vault,
      {
        buyer: seller,
        outcomeId: 0n,
        desiredUnits: 100n,
        filledUnits: 100n,
        payment: 100n,
        earlyBirdWeight: 3,
        cumulativeUserPrimary: 100n,
        totalPrincipal: 200n,
      },
      3,
      1,
    );
    await store.applyBatch(later, [block(3)], block(3));
    const checkpoint = await store.checkpoint(env.deployment.chainId);
    await store.repairPurchaseLogs(purchase(2), block(2));
    expect(await store.canonicalBlock(env.deployment.chainId, 2n)).toEqual(block(2));
    expect(await store.market(env.deployment.chainId, vault)).toMatchObject({
      primaryFilledUnits: 200n,
      primaryPayment: 200n,
      updatedBlock: 3n,
    });
    expect((await store.financial!.pnl(trader)).pnl.lots).toEqual([
      expect.objectContaining({ units: "100", knownCost: "100" }),
    ]);
    expect((await store.financial!.pnl(seller)).pnl.lots).toEqual([
      expect.objectContaining({ units: "100", knownCost: "100" }),
    ]);
    expect(await store.checkpoint(env.deployment.chainId)).toEqual(checkpoint);
    const before =
      await sql`SELECT * FROM ledger_facts ORDER BY log_index,fact_index`;
    const epoch = (await store.financial!.snapshot()).epoch;
    await store.repairPurchaseLogs(purchase(2), block(2));
    expect(
      await sql`SELECT * FROM ledger_facts ORDER BY log_index,fact_index`,
    ).toEqual(before);
    expect((await store.financial!.snapshot()).epoch).toBe(epoch);
    expect(
      (await store.market(env.deployment.chainId, vault))?.primaryFilledUnits,
    ).toBe(200n);
  });
  it("repairs a missing mint without double counting an already indexed primary purchase", async () => {
    await store.applyBatch([purchase(2)[1]!], [block(2)], block(2));
    await store.repairPurchaseLogs(purchase(2), block(2));
    expect(
      (await store.market(env.deployment.chainId, vault))?.primaryFilledUnits,
    ).toBe(100n);
    expect((await store.financial!.pnl(trader)).pnl.lots[0]?.units).toBe("100");
    expect(
      (
        await sql`SELECT count(*)::int AS n FROM ledger_facts WHERE kind='coverage-gap'`
      )[0]!.n,
    ).toBe(0);
  });
  it("rejects cross-fork data atomically and refuses non-purchase mutations", async () => {
    const before = await sql`SELECT * FROM chain_events ORDER BY log_index`;
    await expect(
      store.repairPurchaseLogs(
        purchase(2).map((e) => ({ ...e, blockHash: H(999) })),
        { ...block(2), blockHash: H(999) },
      ),
    ).rejects.toThrow("canonical");
    await expect(
      store.repairPurchaseLogs(createMarket(2), block(2)),
    ).rejects.toThrow("scope");
    expect(await sql`SELECT * FROM chain_events ORDER BY log_index`).toEqual(
      before,
    );
  });
  it("discovers a completely omitted confirmed operation and leaves unknown operations alone", async () => {
    await sql`CREATE TABLE app_operations(id uuid, state text, kind text, sender text, record jsonb, created_at timestamptz DEFAULT now())`;
    const record = {...operation,state:"confirmed",account:trader,kind:"buy",transactionHash:H(20),userOperationHash:H(200),blockNumber:"2",blockHash:H(2),intent:{kind:"buy",market:vault,outcomeId:"0",units:"100",minUnits:"100",maxPayment:"100",deadline:"99999"}};
    await sql`INSERT INTO app_operations(id,state,kind,sender,record) VALUES(${record.id},'unknown','buy',${trader.toLowerCase()},${sql.json({...record,state:"unknown"})})`;
    const receipt={status:"success",transactionHash:H(20),blockNumber:2n,blockHash:H(2),logs:[...purchase(2),raw("UserOperationEvent",entryPoint07Address,{userOpHash:H(200),sender:trader,paymaster:A(0),nonce:0n,success:true,actualGasCost:3n,actualGasUsed:1n},2,3)].map(e=>({...e,removed:false}))} as unknown as TransactionReceipt;
    let reads=0;
    const client={getTransactionReceipt:async()=>{reads++;return receipt},getBlock:async()=>({number:2n,hash:H(2),parentHash:H(1),timestamp:2n})} as unknown as PublicClient;
    expect(await reconcileConfirmedPurchases(store,client)).toBe(0);
    expect(reads).toBe(0);
    await sql`UPDATE app_operations SET state='confirmed',record=${sql.json(record)}`;
    expect(await reconcileConfirmedPurchases(store,client)).toBe(1);
    expect((await store.financial!.pnl(trader)).pnl.lots[0]?.units).toBe("100");
    expect(await reconcileConfirmedPurchases(store,client)).toBe(0);
    expect(reads).toBe(1);
    expect((await sql`SELECT record FROM app_operations`)[0]!.record).toEqual(record);
  });

});
