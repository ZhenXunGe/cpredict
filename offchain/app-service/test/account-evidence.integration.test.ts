import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import {
  A,
  H,
  env,
  appAccount,
  operation,
} from "../../app-core/test/fixtures.js";
import { environmentKey } from "../../app-core/src/contracts.js";
import {
  claimReceiptsSchema,
  sponsoredGasSchema,
} from "../../app-core/src/orderbook-contracts.js";
import type { LedgerFact } from "../../app-core/src/ledger-contracts.js";
import { applyPublicSiteMigrations } from "../src/migrations.js";
import { PostgresAccountEvidence } from "../src/account-evidence.js";
import { backfillAutomaticGas } from "../../workers/src/automatic-gas.js";
import type { AutomationChain } from "../../workers/src/automatic-claims.js";
import { PostgresAutomaticStore } from "../../workers/src/automatic-store.js";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "canonical personal claim and sponsored Gas evidence",
  () => {
    const schema = `cpredict_evidence_${process.pid}_${Date.now()}`;
    let admin: ReturnType<typeof postgres>,
      sql: ReturnType<typeof postgres>,
      store: PostgresAccountEvidence;
    const owner = appAccount.address.toLowerCase(),
      other = A(99).toLowerCase();
    beforeAll(async () => {
      admin = postgres(url!, { max: 1, onnotice: () => undefined });
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      const scoped = new URL(url!);
      scoped.searchParams.set("options", `-csearch_path=${schema}`);
      sql = postgres(scoped.toString(), { max: 1, onnotice: () => undefined });
      await applyPublicSiteMigrations(sql);
      await sql`INSERT INTO cpredict_environment_identity(singleton,identity) VALUES(true,${environmentKey(env)})`;
      await sql`INSERT INTO ledger_environment(singleton,identity,deployment_block,indexed_block,indexed_hash,coverage_start,coverage_complete) VALUES(true,${environmentKey(env)},1,20,${H(20)},1,true)`;
      await sql`INSERT INTO canonical_blocks(chain_id,block_number,block_hash,parent_hash,block_timestamp,confirmation_status) VALUES(${env.deployment.chainId},20,${H(20)},${H(19)},1789142420,'confirmed')`;
      await sql`INSERT INTO app_accounts(id,environment,deployment_id,controller,address,record) VALUES(${appAccount.id},${env.id},${env.deployment.id},${appAccount.controller},${owner},${sql.json(appAccount)})`;
      store = new PostgresAccountEvidence(sql, env);
      await store.ready();
    });
    beforeEach(async () => {
      await sql`TRUNCATE ledger_facts,automation_transactions,app_operations CASCADE`;
      await sql`UPDATE ledger_environment SET epoch=1,coverage_complete=true`;
    });
    afterAll(async () => {
      await sql?.end();
      if (admin) {
        await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    });
    async function fact(
      kind: LedgerFact["kind"],
      tx: number,
      log: number,
      amount: string,
      extra: Record<string, string | boolean> = {},
      recipient = owner,
    ) {
      const f: LedgerFact = {
        id: `${tx}:${log}`,
        kind,
        blockNumber: "20",
        blockHash: H(20),
        transactionHash: H(tx),
        transactionIndex: tx,
        logIndex: log,
        factIndex: 0,
        timestamp: "1789142420",
        market: kind === "user-operation" ? null : A(50),
        owner: recipient as typeof appAccount.address,
        counterparty: null,
        outcomeId: kind === "winner-claimed" ? "0" : null,
        listingId: null,
        units: null,
        amount,
        extra,
      };
      await sql`INSERT INTO ledger_facts(chain_id,block_number,transaction_hash,transaction_index,log_index,fact_index,occurred_at,kind,market,owner,fact) VALUES(${env.deployment.chainId},20,${f.transactionHash},${tx},${log},0,${f.timestamp},${kind},${f.market?.toLowerCase() ?? null},${recipient},${sql.json(f)})`;
      return f;
    }
    async function manual(
      tx: number,
      userOp: number,
      cost: string,
      payment = "sponsored",
      state = "confirmed",
    ) {
      const record = {
        ...operation,
        id: randomUUID(),
        account: owner,
        deploymentId: env.deployment.id,
        kind: "claim-winner",
        transactionHash: H(tx),
        userOperationHash: H(userOp),
        blockNumber: "20",
        blockHash: H(20),
        state,
        updatedAt: "2026-09-11T16:00:20.000Z",
      };
      await sql`INSERT INTO app_operations(id,subject,idempotency_key,request_hash,account_id,sender,nonce,call_hash,state,kind,lane,created_at,updated_at,expires_at,max_gas_cost,record,billing) VALUES(${record.id},'test',${randomUUID()},${H(1)},${appAccount.id},${owner},${userOp},${H(2)},${state},'claim-winner','exit',now(),now(),now()+interval '1 hour',999999,${sql.json(record)},${sql.json({ gasPayment: payment })})`;
      return record;
    }
    async function automation(
      tx: number,
      kind = "winner",
      recipient = owner,
      cost: string | null = "42",
      deployment = env.deployment.id,
      state = "confirmed",
    ) {
      const id = randomUUID();
      await sql`INSERT INTO automation_transactions(id,chain_id,deployment_id,job_key,owner,kind,target,calldata,signer,nonce,tx_hash,state,reserved_wei,receipt_block,receipt_hash,canonical_status,actual_gas_cost_wei) VALUES(${id},${env.deployment.chainId},${deployment},${id},${recipient},${kind},${A(2)},'0x',${A(80).toLowerCase()},${tx},${H(tx)},${state},999999,20,${H(20)},'canonical',${cost})`;
      return id;
    }
    const receipts = (limit = 10, cursor?: string) =>
      store
        .claimReceipts(appAccount.address, {
          limit,
          ...(cursor ? { cursor } : {}),
        })
        .then(claimReceiptsSchema.parse);
    const gas = (limit = 10, cursor?: string) =>
      store
        .sponsoredGas(appAccount.address, {
          limit,
          ...(cursor ? { cursor } : {}),
        })
        .then(sponsoredGasSchema.parse);
    it("reads keeper fees and automatic provenance from a separate control database", async () => {
      const controlSchema = `${schema}_control`;
      await admin`CREATE SCHEMA ${admin(controlSchema)}`;
      const u = new URL(url!);
      u.searchParams.set("options", `-csearch_path=${controlSchema}`);
      const control = postgres(u.toString(), {
        max: 1,
        onnotice: () => undefined,
      });
      try {
        await applyPublicSiteMigrations(control);
        await automation(999, "winner", owner, "999"); // stale local automation table must not be consulted
        await control`INSERT INTO automation_transactions SELECT * FROM ${control(schema)}.automation_transactions WHERE tx_hash=${H(999)}`;
        await control`UPDATE automation_transactions SET tx_hash=${H(101)},actual_gas_cost_wei=42`;
        await fact("winner-claimed", 101, 1, "9800000");
        const separate = new PostgresAccountEvidence(sql, env, control);
        await separate.ready();
        expect(
          claimReceiptsSchema.parse(
            await separate.claimReceipts(appAccount.address, { limit: 10 }),
          ).items[0],
        ).toMatchObject({ source: "automatic", actualGasCostWei: "42" });
        expect(
          sponsoredGasSchema.parse(
            await separate.sponsoredGas(appAccount.address, { limit: 10 }),
          ),
        ).toMatchObject({ knownActualWei: "42", missingCount: 0 });
      } finally {
        await control.end();
        await admin`DROP SCHEMA ${admin(controlSchema)} CASCADE`;
      }
    });
    it("keeps distinct payouts in one transaction and does not guess an unlinked AA source", async () => {
      await fact("winner-claimed", 107, 1, "9800000");
      await fact("early-bird-claimed", 107, 2, "32000");
      await fact("user-operation", 107, 3, "12", {
        userOpHash: H(307),
        success: true,
      });
      const r = await receipts();
      expect(r.items).toHaveLength(2);
      expect(r.items.map((i) => i.source)).toEqual(["unknown", "unknown"]);
      expect(new Set(r.items.map((i) => i.fact.id)).size).toBe(2);
    });
    it("backfills sparse receipt anchors and invalidates them with the indexed epoch", async () => {
      const id = await automation(777, "winner", owner, null);
      await sql`UPDATE automation_transactions SET receipt_block=19,receipt_hash=${H(19)},gas_checked_at=NULL WHERE id=${id}`;
      const journal = new PostgresAutomaticStore(
        sql,
        env.deployment.chainId,
        env.deployment.id,
        A(80),
      );
      const chain = {
        receipt: async () => ({
          status: "success",
          blockNumber: 19n,
          blockHash: H(19),
          gasUsed: 3n,
          effectiveGasPrice: 7n,
          blockTimestamp: 1789142419,
        }),
        canonicalFinal: async () => true,
      } as unknown as AutomationChain;
      await backfillAutomaticGas(journal, chain, sql);
      expect(await gas()).toMatchObject({
        knownActualWei: "21",
        missingCount: 0,
        totalActualWei: "21",
      });
      await sql`UPDATE ledger_environment SET epoch=2`;
      expect(await gas()).toMatchObject({
        knownActualWei: "0",
        missingCount: 1,
        totalActualWei: null,
      });
      await sql`UPDATE automation_transactions SET gas_checked_at=NULL WHERE id=${id}`;
      await backfillAutomaticGas(journal, chain, sql);
      expect(await gas()).toMatchObject({
        knownActualWei: "21",
        missingCount: 0,
      });
    });
    it("shows canonical automatic, manual and direct payouts without estimates", async () => {
      await fact("winner-claimed", 101, 1, "9800000");
      await automation(101);
      await fact("early-bird-claimed", 102, 1, "32000");
      await fact("user-operation", 102, 2, "12", {
        userOpHash: H(202),
        success: true,
      });
      await manual(102, 202, "12");
      await fact("refunded", 103, 1, "10000000");
      await fact("winner-claimed", 104, 1, "999", {}, other);
      const r = await receipts();
      expect(r.items.map((i) => i.source)).toEqual([
        "direct",
        "manual",
        "automatic",
      ]);
      expect(r.items.map((i) => i.fact.amount)).toEqual([
        "10000000",
        "32000",
        "9800000",
      ]);
      expect(r.items[1]?.actualGasCostWei).toBe("12");
      expect(r.items[2]?.actualGasCostWei).toBe("42");
    });
    it("associates two operations in one bundle to their own claim log ranges", async () => {
      await fact("winner-claimed", 110, 1, "10");
      await fact("user-operation", 110, 2, "7", {
        userOpHash: H(210),
        success: true,
      });
      await manual(110, 210, "7");
      await fact("early-bird-claimed", 110, 3, "3");
      await fact("user-operation", 110, 4, "11", {
        userOpHash: H(211),
        success: true,
      });
      await manual(110, 211, "11");
      expect((await receipts()).items.map((i) => i.actualGasCostWei)).toEqual([
        "11",
        "7",
      ]);
      expect((await gas()).knownActualWei).toBe("18");
    });
    it("separates actual personal and public fees, self funded and old deployment", async () => {
      await automation(120);
      await automation(121, "match-orders", other, "17");
      await automation(122, "settle-bond:market", owner, "8");
      await automation(123, "winner", owner, "900", "old-deployment");
      await fact("user-operation", 124, 1, "100", {
        userOpHash: H(224),
        success: true,
      });
      await manual(124, 224, "100", "self-funded");
      const r = await gas();
      expect(r.knownActualWei).toBe("42");
      expect(r.shared.knownActualWei).toBe("25");
      expect(r.items).toHaveLength(1);
      expect(r.totalActualWei).toBe("42");
    });
    it("keeps missing receipt or sponsorship evidence unknown instead of budget or zero", async () => {
      await automation(130, "winner", owner, null);
      await fact("user-operation", 131, 1, "77", {
        userOpHash: H(231),
        success: true,
      });
      await manual(131, 231, "77", "unknown");
      await automation(
        132,
        "match-orders",
        other,
        "8",
        env.deployment.id,
        "unknown",
      );
      const r = await gas();
      expect(r.knownActualWei).toBe("0");
      expect(r.totalActualWei).toBeNull();
      expect(r.missingCount).toBe(2);
      expect(r.shared.totalActualWei).toBeNull();
      expect(r.items.every((i) => i.actualGasCostWei === null)).toBe(true);
    });
    it("counts failed but canonically executed transactions", async () => {
      await automation(
        140,
        "winner",
        owner,
        "9",
        env.deployment.id,
        "reverted",
      );
      await fact("user-operation", 141, 1, "6", {
        userOpHash: H(241),
        success: false,
      });
      await manual(141, 241, "6", "sponsored", "reverted");
      expect((await gas()).knownActualWei).toBe("15");
      expect((await gas()).items.every((i) => i.state === "reverted")).toBe(
        true,
      );
    });
    it("paginates every receipt once and rejects reorg or another account cursor", async () => {
      for (let n = 150; n < 153; n++) {
        await fact("winner-claimed", n, 1, "1");
        await automation(n);
      }
      const a = await receipts(1),
        b = await receipts(1, a.nextCursor!),
        c = await receipts(1, b.nextCursor!);
      expect(
        new Set([...a.items, ...b.items, ...c.items].map((i) => i.fact.id))
          .size,
      ).toBe(3);
      const fees = await gas(1);
      await expect(
        store.sponsoredGas(A(99), { limit: 1, cursor: fees.nextCursor! }),
      ).rejects.toThrow("cursor_filter_mismatch");
      await sql`DELETE FROM ledger_facts WHERE transaction_hash=${H(152)}`;
      await sql`UPDATE ledger_environment SET epoch=2`;
      await sql`UPDATE automation_transactions SET canonical_status='orphaned' WHERE tx_hash=${H(152)}`;
      await expect(receipts(1, a.nextCursor!)).rejects.toMatchObject({
        code: "snapshot_invalidated",
      });
      expect((await receipts()).items).toHaveLength(2);
      expect((await gas()).knownActualWei).toBe("84");
    });
    it("receipt enrichment is idempotent and rejects stale canonical anchors", async () => {
      const id = await automation(160, "winner", owner, null),
        keeper = new PostgresAutomaticStore(
          sql,
          env.deployment.chainId,
          env.deployment.id,
          A(80),
          "claims",
        );
      await keeper.saveReceiptGas(id, H(160), {
        status: "success",
        blockNumber: 20n,
        blockHash: H(19),
        gasUsed: 3n,
        effectiveGasPrice: 7n,
      });
      expect((await gas()).missingCount).toBe(1);
      const r = {
        status: "success" as const,
        blockNumber: 20n,
        blockHash: H(20),
        gasUsed: 3n,
        effectiveGasPrice: 7n,
      };
      await keeper.saveReceiptGas(id, H(160), r);
      await keeper.saveReceiptGas(id, H(160), r);
      expect((await gas()).knownActualWei).toBe("21");
    });
    it("incomplete ledger coverage never reports a complete Gas total", async () => {
      await automation(170);
      await sql`UPDATE ledger_environment SET coverage_complete=false`;
      const r = await gas();
      expect(r.knownActualWei).toBe("42");
      expect(r.totalActualWei).toBeNull();
      expect(r.shared.totalActualWei).toBeNull();
    });
  },
);
