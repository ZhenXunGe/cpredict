import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAutomaticStore } from "../src/automatic-store.js";

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
