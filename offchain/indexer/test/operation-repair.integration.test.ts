import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PublicClient, TransactionReceipt } from "viem";
import { env, H, A } from "../../app-core/test/fixtures.js";
import { PostgresEventStore } from "../src/postgres-store.js";
import { reconcileConfirmedOperations } from "../src/operation-reconciliation.js";
import {
  block,
  createMarket,
  purchase,
  raw,
  trader,
  seller,
  vault,
  listing,
} from "./financial-fixtures.js";
import { confirmed, receiptFor } from "./operation-receipt-fixtures.js";
const url = process.env.TEST_DATABASE_URL;
const listingEvents = [
  raw(
    "TransferSingle",
    vault,
    {
      operator: trader,
      from: trader,
      to: env.deployment.marketplace,
      id: 0n,
      value: 100n,
    },
    3,
    0,
  ),
  raw(
    "ListingCreated",
    env.deployment.marketplace,
    {
      listingId: listing,
      vault,
      seller: trader,
      outcomeId: 0n,
      amount: 100n,
      unitPrice: 1000000n,
      expiresAt: 900n,
      sellerNonce: 0n,
    },
    3,
    1,
  ),
];
const fillEvents = [
  raw(
    "TransferSingle",
    vault,
    {
      operator: env.deployment.marketplace,
      from: env.deployment.marketplace,
      to: seller,
      id: 0n,
      value: 40n,
    },
    4,
    0,
  ),
  raw(
    "ListingFilled",
    env.deployment.marketplace,
    {
      listingId: listing,
      buyer: seller,
      seller: trader,
      desiredUnits: 40n,
      filledUnits: 40n,
      gross: 40n,
      sellerProceeds: 38n,
      platformFee: 1n,
      creatorFee: 1n,
      remainingUnits: 60n,
    },
    4,
    1,
  ),
];
const cancelEvents = [
  raw(
    "TransferSingle",
    vault,
    {
      operator: env.deployment.marketplace,
      from: env.deployment.marketplace,
      to: trader,
      id: 0n,
      value: 60n,
    },
    5,
    0,
  ),
  raw(
    "ListingCancelled",
    env.deployment.marketplace,
    { listingId: listing, seller: trader, returnedUnits: 60n },
    5,
    1,
  ),
];
describe.skipIf(!url)("operation receipt PostgreSQL recovery", () => {
  let admin: ReturnType<typeof postgres>,
    sql: ReturnType<typeof postgres>,
    store: PostgresEventStore,
    schema: string;
  beforeEach(async () => {
    schema = `operation_repair_${process.pid}_${Date.now()}`;
    admin = postgres(url!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url!);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    sql = postgres(scoped.toString(), { max: 1, onnotice: () => {} });
    for (const name of [
      "001_indexer.sql",
      "002_settlement_evidence.sql",
      "003_read_api_indexes.sql",
      "004_market_metadata.sql",
      "005_activity_catalog.sql",
      "006_financial_facts.sql",
      "007_legacy_deployment.sql",
      "009_sparse_canonical_ranges.sql",
      "011_ledger_fact_revision.sql",
      "008_operation_receipts.sql",
    ])
      await sql.unsafe(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    await sql`CREATE TABLE app_operations(id uuid PRIMARY KEY,state text,kind text,sender text,record jsonb,created_at timestamptz DEFAULT now())`;
    store = new PostgresEventStore(scoped.toString(), 3, env);
    await store.ready();
    await store.applyBatch(createMarket(), [block(1)], block(1));
    await store.applyBatch(purchase(), [block(2)], block(2));
    await store.applyBatch([], [block(3), block(4), block(5)], block(5));
  });
  afterEach(async () => {
    await store?.close();
    await sql?.end();
    if (admin) {
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
  const positions = async () =>
    await sql`SELECT owner,balance FROM positions WHERE vault=${vault} ORDER BY owner`;
  it("adds a verified event anchor inside a committed sparse range", async () => {
    await sql`DELETE FROM canonical_blocks WHERE chain_id=${env.deployment.chainId} AND block_number=3`;
    expect(await store.canonicalBlock(env.deployment.chainId, 3n)).toBeUndefined();
    expect(await store.repairOperationLogs(listingEvents, block(3))).toBe(2);
    expect(await store.canonicalBlock(env.deployment.chainId, 3n)).toEqual(block(3));
  });
  it("fills an omitted earlier C2C transaction without reopening a later cancelled listing", async () => {
    await store.applyBatch(listingEvents, [block(3)], block(3));
    await store.applyBatch(cancelEvents, [block(4), block(5)], block(5));
    const checkpoint = await store.checkpoint(env.deployment.chainId);
    expect(await store.repairOperationLogs(fillEvents, block(4))).toBe(2);
    expect(await positions()).toEqual(
      expect.arrayContaining([
        { owner: seller, balance: "40" },
        { owner: trader, balance: "60" },
        { owner: env.deployment.marketplace, balance: "0" },
      ]),
    );
    expect(
      (await sql`SELECT active,remaining_units,updated_block FROM listings`)[0],
    ).toEqual({ active: false, remaining_units: "0", updated_block: "5" });
    expect((await store.financial!.pnl(seller)).pnl.lots[0]).toMatchObject({
      units: "40",
      knownCost: "40",
    });
    const before =
      await sql`SELECT fact FROM ledger_facts ORDER BY block_number,log_index,fact_index`;
    expect(await store.repairOperationLogs(fillEvents, block(4))).toBe(0);
    expect(
      await sql`SELECT fact FROM ledger_facts ORDER BY block_number,log_index,fact_index`,
    ).toEqual(before);
    expect(await store.checkpoint(env.deployment.chainId)).toEqual(checkpoint);
  });
  it("repairs only the missing transfer of an otherwise indexed fill", async () => {
    await store.applyBatch(listingEvents, [block(3)], block(3));
    await store.applyBatch([fillEvents[1]!], [block(4), block(5)], block(5));
    expect(await store.repairOperationLogs(fillEvents, block(4))).toBe(1);
    expect((await sql`SELECT count(*)::int n FROM fills`)[0]!.n).toBe(1);
    expect(
      (
        await sql`SELECT count(*)::int n FROM ledger_facts WHERE kind='coverage-gap'`
      )[0]!.n,
    ).toBe(0);
    expect((await store.financial!.pnl(seller)).pnl.lots[0]?.units).toBe("40");
  });
  it.each(["ListingCancelled", "TerminalListingReturned"])(
    "restores %s together with returned shares",
    async (name) => {
      await store.applyBatch(listingEvents, [block(3)], block(3));
      await store.applyBatch(fillEvents, [block(4), block(5)], block(5));
      const events = [
        cancelEvents[0]!,
        raw(
          name,
          env.deployment.marketplace,
          {
            listingId: listing,
            seller: trader,
            caller: seller,
            returnedUnits: 60n,
          },
          5,
          1,
        ),
      ];
      expect(await store.repairOperationLogs(events, block(5))).toBe(2);
      expect(
        (await sql`SELECT active,remaining_units FROM listings`)[0],
      ).toEqual({ active: false, remaining_units: "0" });
      expect((await store.financial!.pnl(trader)).pnl.lots[0]).toMatchObject({
        units: "60",
        escrowUnits: "0",
      });
    },
  );
  it.each(["WinnerClaimed", "PrincipalRefunded"])(
    "restores %s and its burn once",
    async (name) => {
      const events = [
        raw(
          "TransferSingle",
          vault,
          { operator: trader, from: trader, to: A(0), id: 0n, value: 100n },
          4,
          0,
        ),
        raw(
          name,
          vault,
          {
            owner: trader,
            caller: trader,
            burnedUnits: 100n,
            payout: 120n,
            refund: 100n,
            timeoutEligibilityRecorded: true,
          },
          4,
          1,
        ),
      ];
      expect(await store.repairOperationLogs(events, block(4))).toBe(2);
      expect(
        (await sql`SELECT balance FROM positions WHERE owner=${trader}`)[0]!
          .balance,
      ).toBe("0");
      expect((await sql`SELECT count(*)::int n FROM claims`)[0]!.n).toBe(1);
      expect(await store.repairOperationLogs(events, block(4))).toBe(0);
    },
  );
  it("rejects conflicts and unavailable causal history atomically", async () => {
    const before =
      await sql`SELECT * FROM chain_events ORDER BY block_number,log_index`;
    await expect(
      store.repairOperationLogs(fillEvents, block(4)),
    ).rejects.toThrow();
    await expect(
      store.repairOperationLogs(
        purchase().map((e) => ({ ...e, blockHash: H(99) })),
        { ...block(2), blockHash: H(99) },
      ),
    ).rejects.toThrow("canonical");
    await expect(
      store.repairOperationLogs(
        purchase().map((e, i) => (i === 0 ? { ...e, data: "0x" } : e)),
        block(2),
      ),
    ).rejects.toThrow("conflict");
    expect(
      await sql`SELECT * FROM chain_events ORDER BY block_number,log_index`,
    ).toEqual(before);
  });
  it("audits every receipt including partial gaps, persists checks, skips unknown, and prevents failing-row starvation", async () => {
    await store.applyBatch(listingEvents, [block(3)], block(3));
    await store.applyBatch([fillEvents[1]!], [block(4), block(5)], block(5));
    const good = {
      ...confirmed(
        {
          kind: "fill-listing",
          listingId: listing,
          units: "40",
          minUnits: "40",
          maxPayment: "40",
          deadline: "9999",
        },
        4,
      ),
      account: seller,
    };
    const bad = {
      ...confirmed({ kind: "claim-winner", market: vault }, 4),
      id: "20000000-0000-4000-8000-000000000002",
      transactionHash: H(999),
    };
    const unknown = {
      ...bad,
      id: "20000000-0000-4000-8000-000000000003",
      state: "unknown",
    };
    for (const o of [good, bad, unknown])
      await sql`INSERT INTO app_operations(id,state,kind,sender,record) VALUES(${o.id},${o.state},${o.kind},${o.account},${sql.json(o)})`;
    const original = await sql`SELECT record FROM app_operations ORDER BY id`;
    const client = {
      getTransactionReceipt: async ({ hash }: { hash: string }) => {
        if (hash === H(999)) throw new Error("secret-provider-url");
        return receiptFor(good, fillEvents);
      },
      getBlock: async () => ({ hash: H(4) }),
    } as unknown as PublicClient;
    expect(await reconcileConfirmedOperations(store, client)).toMatchObject({
      checked: 2,
      repaired: 1,
      errors: 1,
      pending: 0,
      unresolved: 1,
    });
    expect(await reconcileConfirmedOperations(store, client)).toMatchObject({
      checked: 0,
      repaired: 0,
      unresolved: 1,
    });
    expect(
      (
        await sql`SELECT last_error FROM ledger_operation_receipts WHERE operation_id=${bad.id}`
      )[0]!.last_error,
    ).toBe("operation_verification_unavailable");
    expect(await sql`SELECT record FROM app_operations ORDER BY id`).toEqual(
      original,
    );
    await sql`UPDATE ledger_operation_receipts SET next_check_at=now()-interval '1 second' WHERE operation_id=${good.id}`;
    expect(await reconcileConfirmedOperations(store, client)).toMatchObject({
      checked: 1,
      repaired: 0,
      errors: 0,
    });
  });
  it("does not re-read receipts for timestamp/finality observations but immediately rechecks changed canonical identity", async () => {
    const op = confirmed(
      {
        kind: "buy",
        market: vault,
        outcomeId: "0",
        units: "100",
        minUnits: "100",
        maxPayment: "100",
        deadline: "9999",
      },
      2,
    );
    await sql`INSERT INTO app_operations(id,state,kind,sender,record) VALUES(${op.id},'confirmed','buy',${op.account},${sql.json(op)})`;
    let reads = 0;
    const client = {
      getTransactionReceipt: async () => {
        reads++;
        return receiptFor(op, purchase(2));
      },
      getBlock: async () => ({ hash: H(2) }),
    } as unknown as PublicClient;
    expect((await reconcileConfirmedOperations(store, client)).checked).toBe(1);
    const observed = {
      ...op,
      updatedAt: "2026-09-17T00:00:00.000Z",
      finality: "finalized",
      actualGasCost: "5",
    };
    await sql`UPDATE app_operations SET record=${sql.json(observed)}`;
    expect(await reconcileConfirmedOperations(store, client)).toMatchObject({
      checked: 0,
      pending: 0,
      errors: 0,
    });
    expect(reads).toBe(1);
    await sql`UPDATE app_operations SET record=${sql.json({ ...observed, blockHash: H(999) })}`;
    expect(await reconcileConfirmedOperations(store, client)).toMatchObject({
      checked: 1,
      errors: 1,
    });
    expect(reads).toBe(2);
  });
});
