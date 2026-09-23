import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CleanupQuotaExceeded, type AutomaticAction } from "../src/automatic-claims.js";
import { cleanupQuotaLimits, PostgresAutomaticStore } from "../src/automatic-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const owner = "0x1111111111111111111111111111111111111111";
const signer = "0x2222222222222222222222222222222222222222";
const market = "0x3333333333333333333333333333333333333333";
const hash = `0x${"44".repeat(32)}`;

describe.skipIf(databaseUrl === undefined)(
  "PostgresAutomaticStore history integration",
  () => {
    const schema = `cpredict_automatic_history_${process.pid}_${Date.now()}`;
    let admin: ReturnType<typeof postgres>;
    let sql: ReturnType<typeof postgres>;

    beforeAll(async () => {
      if (databaseUrl === undefined)
        throw new Error("TEST_DATABASE_URL is required");
      admin = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
      await admin.unsafe(`CREATE SCHEMA ${schema}`);
      const scoped = new URL(databaseUrl);
      scoped.searchParams.set("options", `-csearch_path=${schema}`);
      sql = postgres(scoped.toString(), { max: 1, onnotice: () => undefined });
      for (const name of [
        "007_order_automation.sql",
        "008_automation_status_scope.sql",
        "009_automation_canonical_audit.sql",
        "010_automation_cleanup_quotas.sql",
      ]) {
        const migration = await readFile(
          new URL(`../../app-service/migrations/${name}`, import.meta.url),
          "utf8",
        );
        await sql.unsafe(migration);
      }
      await sql.unsafe(`
        CREATE TABLE ledger_facts (
          chain_id bigint NOT NULL,
          transaction_hash char(66) NOT NULL,
          block_number numeric(78,0) NOT NULL DEFAULT 100,
          occurred_at numeric(78,0) NOT NULL,
          kind text NOT NULL,
          transaction_index integer NOT NULL DEFAULT 0,
          log_index integer NOT NULL DEFAULT 0,
          fact_index integer NOT NULL DEFAULT 0,
          market text,
          owner text,
          fact jsonb NOT NULL
        )
      `);
      await sql.unsafe(`
        CREATE TABLE public_market_metadata (
          market text PRIMARY KEY,
          verified boolean NOT NULL DEFAULT false,
          question text,
          rules jsonb
        )
      `);
      await sql.unsafe(`CREATE TABLE chain_checkpoints (chain_id bigint PRIMARY KEY, block_number numeric(78,0) NOT NULL)`);
      await sql`INSERT INTO chain_checkpoints(chain_id,block_number) VALUES(421614,100)`;
      for (let index = 0; index < 7; index += 1) {
        const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
        await sql`
          INSERT INTO automation_transactions(
            id,chain_id,deployment_id,job_key,owner,kind,target,calldata,signer,
            requires_claim_preference,nonce,tx_hash,raw_transaction,state,
            reserved_wei,created_at,updated_at
          ) VALUES(
            ${id},421614,'deployment',${`winner:${index}`},${owner},'winner',
            ${market},'0x',${signer},true,${String(index)},
            ${index === 0 ? hash : `0x${String(index + 1).repeat(64)}`},
            NULL,'confirmed',0,
            ${new Date(Date.UTC(2026, 8, 21, 9, 0, 6 - index))},
            ${new Date(Date.UTC(2026, 8, 21, 9, 1, 6 - index))}
          )
        `;
      }
      await sql`
        INSERT INTO ledger_facts(chain_id,transaction_hash,occurred_at,kind,market,owner,fact)
        VALUES(421614,${hash},'1789981320','winner-claimed',${market},${owner},${sql.json({ amount: "1234567" })})
      `;
    });

    afterAll(async () => {
      await sql?.end();
      if (admin) {
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });

    it("returns newest-first pages with confirmed market, amount and chain time", async () => {
      const store = new PostgresAutomaticStore(
        sql,
        421614,
        "deployment",
        signer,
      );
      const first = await store.publicStatus(owner, { limit: 5 });
      expect(first.transactions).toHaveLength(5);
      expect(first.transactions[0]).toMatchObject({
        id: "00000000-0000-4000-8000-000000000001",
        market,
        amount: "1234567",
      });
      expect(first.transactions[0]?.completed_at).toEqual(
        new Date("2026-09-21T09:02:00.000Z"),
      );
      expect(first.nextCursor).toBe("00000000-0000-4000-8000-000000000005");

      const second = await store.publicStatus(owner, {
        limit: 5,
        cursor: first.nextCursor!,
      });
      expect(second.transactions.map((transaction) => transaction.id)).toEqual([
        "00000000-0000-4000-8000-000000000006",
        "00000000-0000-4000-8000-000000000007",
      ]);
      expect(second.nextCursor).toBeNull();
    });

    it("detects an indexed canonical payout without its matching owner fact", async () => {
      const missingHash = `0x${"ab".repeat(32)}`;
      const id = "00000000-0000-4000-8000-000000000098";
      const store = new PostgresAutomaticStore(sql, 421614, "deployment", signer);
      await sql`
        INSERT INTO automation_transactions(
          id,chain_id,deployment_id,job_key,owner,kind,target,calldata,signer,
          requires_claim_preference,nonce,tx_hash,raw_transaction,state,
          reserved_wei,receipt_block,receipt_hash,canonical_status,created_at,updated_at
        ) VALUES(
          ${id},421614,'deployment','timeout-bonus:missing',${owner},'timeout-bonus',
          ${market},'0x','0x4444444444444444444444444444444444444444',true,'98',${missingHash},NULL,'confirmed',0,
          100,${hash},'canonical',now()-interval '5 minutes',now()-interval '5 minutes'
        )`;
      expect(await store.missingFinancialFacts()).toEqual([{ kind: "timeout-bonus", count: 1 }]);
      await sql`
        INSERT INTO ledger_facts(chain_id,transaction_hash,occurred_at,kind,market,owner,fact)
        VALUES(421614,${missingHash},'1789981320','timeout-claimed',${market},${signer},${sql.json({ amount: "5000000" })})`;
      expect(await store.missingFinancialFacts()).toEqual([{ kind: "timeout-bonus", count: 1 }]);
      await sql`
        INSERT INTO ledger_facts(chain_id,transaction_hash,occurred_at,kind,market,owner,fact)
        VALUES(421614,${missingHash},'1789981320','timeout-claimed',${market},${owner},${sql.json({ amount: "5000000" })})`;
      expect(await store.missingFinancialFacts()).toEqual([]);
      await sql`DELETE FROM automation_transactions WHERE id=${id}`;
    });

    it("reserves terminal cleanup capacity while limiting routine cleanup by account and market", async () => {
      const quotaOwner = "0x8888888888888888888888888888888888888888";
      const quotaMarket = "0x9999999999999999999999999999999999999999";
      const denied = vi.fn();
      const store = new PostgresAutomaticStore(sql, 421614, "deployment", signer, "claims", denied);
      const action = (index: number, priority: "routine" | "terminal-blocking"): AutomaticAction => ({
        key: `quota-test:${index}`,
        owner: quotaOwner,
        kind: "release-order",
        target: market,
        data: "0x1234",
        requiresClaimPreference: false,
        cleanupMarket: quotaMarket,
        cleanupPriority: priority,
      });
      const prepare = (index: number) => ({
        raw: "0x1234" as const,
        hash: `0x${index.toString(16).padStart(64, "0")}` as const,
        nonce: BigInt(100 + index),
        maximumCost: 1n,
      });
      try {
        for (let i = 0; i < cleanupQuotaLimits.accountRoutine24h; i++)
          await store.save(action(i, "routine"), prepare(i));
        expect(await store.cleanupQuota(action(20, "routine"))).toBe("cleanup_account_quota_exceeded");
        await expect(store.save(action(20, "routine"), prepare(20))).rejects.toBeInstanceOf(CleanupQuotaExceeded);
        expect(denied).toHaveBeenCalledWith("cleanup_account_quota_exceeded");
        for (let i = 4; i < cleanupQuotaLimits.accountTotal24h; i++)
          await store.save(action(i, "terminal-blocking"), prepare(i));
        expect(await store.cleanupQuota(action(21, "terminal-blocking"))).toBe("cleanup_account_quota_exceeded");
        await sql`UPDATE automation_transactions SET created_at=now()-interval '25 hours' WHERE job_key='quota-test:0'`;
        expect(await store.cleanupQuota(action(22, "terminal-blocking"))).toBeNull();
        expect(await store.cleanupQuota(action(23, "routine"))).toBeNull();
        await sql`INSERT INTO automation_transactions(id,chain_id,deployment_id,job_key,owner,kind,target,calldata,signer,requires_claim_preference,state,reserved_wei,cleanup_market,cleanup_priority)
          SELECT gen_random_uuid(),421614,'deployment','quota-test:market:'||g,'0x'||lpad(to_hex(g+100),40,'0'),'release-order',${market},'0x',${signer},false,'confirmed',0,${quotaMarket},'routine'
          FROM generate_series(1,${cleanupQuotaLimits.marketRoutine24h}) g`;
        expect(await store.cleanupQuota({ ...action(24, "routine"), owner: "0x7777777777777777777777777777777777777777" })).toBe("cleanup_market_quota_exceeded");
        expect(await store.cleanupQuota({ ...action(25, "terminal-blocking"), owner: "0x7777777777777777777777777777777777777777" })).toBeNull();
      } finally {
        await sql`DELETE FROM automation_transactions WHERE job_key LIKE 'quota-test:%'`;
      }
    });

    it("serializes quota reservations from separate signer lanes", async () => {
      const quotaOwner = "0x8888888888888888888888888888888888888888";
      const quotaMarket = "0x9999999999999999999999999999999999999999";
      const scoped = new URL(databaseUrl!);
      scoped.searchParams.set("options", `-csearch_path=${schema}`);
      const secondSql = postgres(scoped.toString(), { max: 1, onnotice: () => undefined });
      try {
        for (let i = 0; i < cleanupQuotaLimits.accountTotal24h - 1; i++)
          await sql`INSERT INTO automation_transactions(id,chain_id,deployment_id,job_key,owner,kind,target,calldata,signer,requires_claim_preference,state,reserved_wei,cleanup_market,cleanup_priority)
            VALUES(${randomUUID()},421614,'deployment',${`quota-test:seed:${i}`},${quotaOwner},'release-order',${market},'0x',${signer},false,'confirmed',0,${quotaMarket},'terminal-blocking')`;
        const action = (index: number): AutomaticAction => ({
          key: `quota-test:parallel:${index}`, owner: quotaOwner, kind: "release-order",
          target: market, data: "0x1234", requiresClaimPreference: false,
          cleanupMarket: quotaMarket, cleanupPriority: "terminal-blocking",
        });
        const a = new PostgresAutomaticStore(sql, 421614, "deployment", signer);
        const b = new PostgresAutomaticStore(secondSql, 421614, "deployment", "0x4444444444444444444444444444444444444444");
        const outcomes = await Promise.allSettled([
          a.save(action(1), { raw: "0x1234", hash: hash as `0x${string}`, nonce: 200n, maximumCost: 1n }),
          b.save(action(2), { raw: "0x1234", hash: hash as `0x${string}`, nonce: 200n, maximumCost: 1n }),
        ]);
        expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect((await sql`SELECT count(*)::int AS n FROM automation_transactions WHERE job_key LIKE 'quota-test:%'`)[0]?.n).toBe(cleanupQuotaLimits.accountTotal24h);
      } finally {
        await sql`DELETE FROM automation_transactions WHERE job_key LIKE 'quota-test:%'`;
        await secondSql.end();
      }
    });

    it("returns contributing market names for aggregated creator claims", async () => {
      const creator = "0x5555555555555555555555555555555555555555";
      const secondMarket = "0x6666666666666666666666666666666666666666";
      const oldMarket = "0x7777777777777777777777777777777777777777";
      const claimHash = `0x${"77".repeat(32)}`;
      await sql`
        INSERT INTO automation_transactions(
          id,chain_id,deployment_id,job_key,owner,kind,target,calldata,signer,
          requires_claim_preference,nonce,tx_hash,raw_transaction,state,
          reserved_wei,created_at,updated_at
        ) VALUES(
          '00000000-0000-4000-8000-000000000099',421614,'deployment','fees:creator',
          ${creator},'fees',${market},'0x',${signer},true,'99',${claimHash},NULL,
          'confirmed',0,now(),now()
        )
      `;
      await sql`
        INSERT INTO public_market_metadata(market,verified,question,rules) VALUES
          (${market},true,'市场一',NULL),(${secondMarket},true,'市场二',NULL),
          (${oldMarket},true,'上次已领取市场',NULL)
      `;
      await sql`
        INSERT INTO ledger_facts(
          chain_id,transaction_hash,block_number,occurred_at,kind,
          transaction_index,log_index,fact_index,market,owner,fact
        ) VALUES
          (421614,${`0x${"aa".repeat(32)}`} ,99,1789981280,'fee-accrued',0,0,0,${oldMarket},${creator},${sql.json({ amount: "900000" })}),
          (421614,${`0x${"bb".repeat(32)}`} ,100,1789981290,'fee-claimed',0,0,0,NULL,${creator},${sql.json({ amount: "900000" })}),
          (421614,${`0x${"88".repeat(32)}`} ,101,1789981300,'fee-accrued',0,0,0,${market},${creator},${sql.json({ amount: "100000" })}),
          (421614,${`0x${"99".repeat(32)}`} ,102,1789981310,'fee-accrued',0,0,0,${secondMarket},${creator},${sql.json({ amount: "200000" })}),
          (421614,${claimHash},103,1789981320,'fee-claimed',0,0,0,NULL,${creator},${sql.json({ amount: "300000" })})
      `;
      await sql`
        INSERT INTO automation_transactions(
          id,chain_id,deployment_id,job_key,owner,kind,target,calldata,signer,
          requires_claim_preference,nonce,tx_hash,raw_transaction,state,
          reserved_wei,created_at,updated_at
        ) VALUES(
          '00000000-0000-4000-8000-000000000100',421614,'deployment','fees:pending',
          ${creator},'fees',${market},'0x',${signer},true,'100',
          ${`0x${"cc".repeat(32)}`},NULL,'broadcasting',0,now()+interval '1 second',now()+interval '1 second'
        )
      `;
      await sql`
        INSERT INTO ledger_facts(
          chain_id,transaction_hash,block_number,occurred_at,kind,
          transaction_index,log_index,fact_index,market,owner,fact
        ) VALUES(
          421614,${`0x${"dd".repeat(32)}`},104,1789981330,'fee-accrued',0,0,0,
          ${secondMarket},${creator},${sql.json({ amount: "400000" })}
        )
      `;

      const store = new PostgresAutomaticStore(
        sql,
        421614,
        "deployment",
        signer,
      );
      const result = await store.publicStatus(creator, { limit: 5 });
      const confirmed = result.transactions.find(
        (transaction) =>
          transaction.id === "00000000-0000-4000-8000-000000000099",
      );
      expect(confirmed?.context).toMatchObject({
        amount: "300000",
        relatedMarkets: [
          { market, marketQuestion: "市场一" },
          { market: secondMarket, marketQuestion: "市场二" },
        ],
      });
      const pending = result.transactions.find(
        (transaction) =>
          transaction.id === "00000000-0000-4000-8000-000000000100",
      );
      expect(pending).toMatchObject({
        state: "broadcasting",
        context: {
          amount: null,
          relatedMarkets: [{ market: secondMarket, marketQuestion: "市场二" }],
        },
      });
    });
  },
);
