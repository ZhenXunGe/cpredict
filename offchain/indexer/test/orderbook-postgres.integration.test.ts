import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { A, H, env } from "../../app-core/test/fixtures.js";
import { PostgresEventStore } from "../src/postgres-store.js";
import { orderbookPage } from "../src/orderbook.js";
import {
  block,
  createMarket,
  purchase,
  raw,
  trader,
  seller,
  vault,
} from "./financial-fixtures.js";
import { PostgresAutomaticStore } from "../../workers/src/automatic-store.js";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "V2 atomic order projection and durable automation PostgreSQL",
  () => {
    const schema = `v2_orders_${process.pid}_${Date.now()}`;
    let admin: ReturnType<typeof postgres>,
      sql: ReturnType<typeof postgres>,
      store: PostgresEventStore;
    const v2 = {
      ...env,
      deployment: {
        ...env.deployment,
        marketplaceVersion: "orderbook-v2" as const,
      },
    };
    beforeAll(async () => {
      admin = postgres(url!, { max: 1, onnotice: () => {} });
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      const u = new URL(url!);
      u.searchParams.set("options", `-csearch_path=${schema}`);
      sql = postgres(u.toString(), { max: 6, onnotice: () => {} });
      const migration = await sql.reserve();
      for (const n of [
        "001_indexer",
        "002_settlement_evidence",
        "003_read_api_indexes",
        "004_market_metadata",
        "005_activity_catalog",
        "006_financial_facts",
        "007_legacy_deployment",
        "008_orderbook",
        "009_sparse_canonical_ranges",
      ])
        await migration.unsafe(
          await readFile(`offchain/indexer/migrations/${n}.sql`, "utf8"),
        );
      await migration.unsafe(
        await readFile(
          "offchain/app-service/migrations/007_order_automation.sql",
          "utf8",
        ),
      );
      migration.release();
      store = new PostgresEventStore(u.toString(), 3, v2);
      await store.ready();
      await store.applyBatch(createMarket(), [block(1)], block(1));
      await store.applyBatch(purchase(), [block(2)], block(2));
    });
    afterAll(async () => {
      await store?.close();
      await sql?.end();
      if (admin) {
        await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    });
    it("tracks a funded bid, partial execution and exact release atomically", async () => {
      await store.applyBatch(
        [
          raw(
            "OrderCreated",
            env.deployment.marketplace,
            {
              orderId: 1n,
              vault,
              owner: seller,
              outcomeId: 0,
              side: 0,
              units: 100n,
              unitPrice: 1000000n,
              expiresAt: 900n,
              autoMatch: true,
              lockedPayment: 100n,
            },
            3,
            0,
          ),
        ],
        [block(3)],
        block(3),
      );
      expect(
        (
          await orderbookPage(
            sql,
            env.deployment.chainId,
            env.deployment.marketplace,
          )
        ).items[0],
      ).toMatchObject({
        id: "1",
        side: "bid",
        lockedPayment: "100",
        remainingUnits: "100",
        active: true,
      });
      const trade = {
        orderId: 1n,
        vault,
        buyer: seller,
        seller: trader,
        outcomeId: 0,
        units: 40n,
        unitPrice: 1000000n,
        gross: 40n,
        platformFee: 1n,
        creatorFee: 1n,
        escrowed: false,
        remainingAskUnits: 0n,
      };
      await store.applyBatch(
        [
          raw(
            "TransferSingle",
            vault,
            {
              operator: env.deployment.marketplace,
              from: trader,
              to: seller,
              id: 0n,
              value: 40n,
            },
            4,
            0,
          ),
          raw("TradeExecuted", env.deployment.marketplace, trade, 4, 1),
          raw(
            "OrderFilled",
            env.deployment.marketplace,
            { ...trade, remainingUnits: 60n, lockedPayment: 60n },
            4,
            2,
          ),
        ],
        [block(4)],
        block(4),
      );
      const facts =
        await sql`SELECT kind,fact FROM ledger_facts WHERE block_number=4`;
      expect(facts.filter((f) => f.kind === "listing-filled")).toHaveLength(1);
      expect(facts.some((f) => f.kind === "coverage-gap")).toBe(false);
      const pnl = await store.financial!.pnl(trader);
      expect(pnl.pnl.lots[0]?.units).toBe("60");
      expect(pnl.pnl.lots[0]?.escrowUnits).toBe("0");
      expect(
        (
          await orderbookPage(
            sql,
            env.deployment.chainId,
            env.deployment.marketplace,
          )
        ).items[0],
      ).toMatchObject({ lockedPayment: "60", remainingUnits: "60" });
      await store.applyBatch(
        [
          raw(
            "OrderReleased",
            env.deployment.marketplace,
            {
              orderId: 1n,
              owner: seller,
              reason: 0,
              returnedUnits: 0n,
              returnedPayment: 60n,
            },
            5,
            0,
          ),
        ],
        [block(5)],
        block(5),
      );
      expect(
        (
          await orderbookPage(
            sql,
            env.deployment.chainId,
            env.deployment.marketplace,
          )
        ).items[0],
      ).toMatchObject({ active: false, lockedPayment: "0" });
      await sql`DELETE FROM canonical_blocks WHERE block_number=5`;
      expect(
        (
          await orderbookPage(
            sql,
            env.deployment.chainId,
            env.deployment.marketplace,
          )
        ).items[0],
      ).toMatchObject({ active: true, lockedPayment: "60" });
      // Frozen balance covers the entire account even when the order list is paginated.
      await sql`INSERT INTO orderbook_events(chain_id,block_number,transaction_hash,transaction_index,log_index,marketplace,event_name,order_id,args)
    SELECT chain_id,4,${H(900)},0,n,marketplace,event_name,n,args||jsonb_build_object('orderId',n::text)
    FROM orderbook_events CROSS JOIN generate_series(100,159) n WHERE event_name='OrderCreated' AND order_id=1`;
      const page = await orderbookPage(
        sql,
        env.deployment.chainId,
        env.deployment.marketplace,
        undefined,
        seller,
      );
      expect(page.items).toHaveLength(50);
      expect(page.nextCursor).not.toBeNull();
      expect(page.totalLockedPayment).toBe("6060");
    });
    it("unknown historical accounts default on; opt-out persists across deployment settings", async () => {
      const a = new PostgresAutomaticStore(sql, 421614, "v1", A(70)),
        b = new PostgresAutomaticStore(sql, 421614, "v2", A(71));
      expect(await a.enabled(A(88))).toBe(true);
      await a.setEnabled(A(88), false);
      expect(await b.enabled(A(88))).toBe(false);
      await b.setEnabled(A(88), true);
      expect(await a.enabled(A(88))).toBe(true);
    });
    it("persists signed intent, CAS broadcast and nonce exclusion; API never returns signed bytes", async () => {
      const a = new PostgresAutomaticStore(sql, 421614, "v2", A(70));
      const action = {
        key: "claim:1",
        owner: trader,
        kind: "winner",
        target: vault,
        data: "0x1234" as const,
        requiresClaimPreference: true,
      };
      const tx = {
        raw: "0xabcd" as const,
        hash: H(700),
        nonce: 0n,
        maximumCost: 50n,
      };
      const r = await a.save(action, tx);
      expect((await a.pending())[0]?.raw).toBe(tx.raw);
      expect(
        (
          await Promise.all([
            a.markBroadcasting(r.id),
            a.markBroadcasting(r.id),
          ])
        ).filter(Boolean),
      ).toHaveLength(1);
      await a.unknown(r.id);
      expect((await a.pending())[0]?.state).toBe("unknown");
      await expect(a.save({ ...action, key: "other" }, tx)).rejects.toThrow();
      expect(JSON.stringify(await a.publicStatus(trader))).not.toContain(
        tx.raw,
      );
      await a.finish(r.id, {
        status: "success",
        blockNumber: 4n,
        blockHash: H(4),
      });
      expect(await a.pending()).toHaveLength(0);
      expect(await a.spentToday()).toBe(50n);
      const [saved] =
        await sql`SELECT raw_transaction FROM automation_transactions WHERE id=${r.id}`;
      expect(saved?.raw_transaction).toBeNull();
    });
    it("reports a blocked claims queue to other owners without leaking transactions, and clears after confirmation", async () => {
      const a = new PostgresAutomaticStore(sql, 421614, "queue-test", A(72));
      const r = await a.save({key:"blocked-claim",owner:A(73),kind:"winner",target:vault,data:"0x1234",requiresClaimPreference:true}, {raw:"0xabcd",hash:H(701),nonce:0n,maximumCost:10n});
      await a.markBroadcasting(r.id); await a.unknown(r.id);
      await sql`UPDATE automation_transactions SET broadcast_at=now()-interval '5 minutes' WHERE id=${r.id}`;
      expect(await a.oldestPendingSeconds()).toBeGreaterThan(290);
      const status = await a.publicStatus(A(74));
      expect(status.reason).toBe("queue_blocked_unknown_transaction");
      expect(status.transactions).toEqual([]);
      expect(JSON.stringify(status)).not.toContain(H(701));
      const unrelated = new PostgresAutomaticStore(sql,421614,"other-deployment",A(75));
      expect((await unrelated.publicStatus(A(74))).reason).toBe("waiting_for_entitlement");
      await a.finish(r.id,{status:"success",blockNumber:4n,blockHash:H(4)});
      expect((await a.publicStatus(A(74))).reason).toBe("waiting_for_entitlement");
      expect(await a.oldestPendingSeconds()).toBe(0);
    });
    it("advisory lock excludes simultaneous workers and releases after exception", async () => {
      const a = new PostgresAutomaticStore(sql, 421614, "v2", A(90)),
        b = new PostgresAutomaticStore(sql, 421614, "v1", A(90));
      await a.exclusive(async () =>
        expect(await b.exclusive(async () => true)).toBeUndefined(),
      );
      await expect(
        a.exclusive(async () => {
          throw Error("crash");
        }),
      ).rejects.toThrow("crash");
      expect(await b.exclusive(async () => true)).toBe(true);
    });
  },
);
