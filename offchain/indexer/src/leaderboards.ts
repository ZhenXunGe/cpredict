import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AppError,
  accountSchema,
  type AppAccount,
} from "../../app-core/src/contracts.js";
import { ledgerFactSchema } from "../../app-core/src/ledger-contracts.js";
import {
  leaderboardPeriodSchema,
  leaderboardSnapshotSchema,
  type LeaderboardPeriod,
} from "../../app-core/src/report-contracts.js";
import { scoreLeaderboard } from "../../app-core/src/leaderboard.js";
import type { PostgresFinancialLedger } from "./financial-store.js";
import type { Address, Hex } from "viem";

export class Leaderboards {
  constructor(readonly ledger: PostgresFinancialLedger) {}
  async register(input: unknown, now = new Date()): Promise<void> {
    const period = leaderboardPeriodSchema.parse(input),
      current = BigInt(Math.floor(now.getTime() / 1000));
    if (
      BigInt(period.publishedAt) !== current ||
      BigInt(period.startsAt) <= current
    )
      throw new AppError("roster_must_precede_scoring");
    await this.ledger.sql.begin(async (db) => {
      for (const item of period.markets) {
        const row = (
          await db<
            { market: string }[]
          >`SELECT market FROM registered_markets WHERE chain_id=${this.ledger.environment.deployment.chainId} AND lower(market)=${item.market.toLowerCase()}`
        )[0];
        if (!row) throw new AppError("market_not_registered");
      }
      await db`INSERT INTO leaderboard_periods(id,starts_at,ends_at,market_roster,published_at) VALUES(${period.id},${period.startsAt},${period.endsAt},${db.json(period.markets)},${period.publishedAt})`;
    });
  }
  async periods(): Promise<LeaderboardPeriod[]> {
    const rows = await this.ledger.sql<
      {
        id: string;
        starts_at: string;
        ends_at: string;
        market_roster: unknown;
        published_at: string;
      }[]
    >`SELECT * FROM leaderboard_periods ORDER BY starts_at DESC,id LIMIT 100`;
    return rows.map((row) =>
      leaderboardPeriodSchema.parse({
        id: row.id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        markets: row.market_roster,
        publishedAt: row.published_at,
      }),
    );
  }
  async publish(periodId: string): Promise<void> {
    await this.ledger.sql.begin(
      "isolation level repeatable read",
      async (db) => {
        await db`SELECT pg_advisory_xact_lock(hashtextextended('leaderboard-publication',0))`;
        const row = (
          await db<
            {
              id: string;
              starts_at: string;
              ends_at: string;
              market_roster: unknown;
              published_at: string;
            }[]
          >`SELECT * FROM leaderboard_periods WHERE id=${periodId}`
        )[0];
        if (!row) throw new AppError("period_not_found", 404);
        const period = leaderboardPeriodSchema.parse({
          id: row.id,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          publishedAt: row.published_at,
          markets: row.market_roster,
        });
        let snapshot = await this.ledger.snapshot(db);
        if (!snapshot.complete || snapshot.status !== "active")
          throw new AppError("ledger_not_reconciled", 409);
        const rows = await db<
          { record: unknown; through_block: string | null }[]
        >`SELECT a.record,t.through_block FROM app_accounts a LEFT JOIN ledger_tracked_accounts t ON t.address=lower(a.address) ORDER BY a.address LIMIT 10001`;
        if (rows.length > 10000)
          throw new AppError("leaderboard_capacity_exceeded", 503);
        const accounts: AppAccount[] = rows.map((r) =>
          accountSchema.parse(r.record),
        );
        // Freeze the common block only after each verified account has its scoped transfer history.
        if (rows.some((r) => r.through_block === null))
          throw new AppError("account_backfill_pending", 409);
        const commonBlock = rows.reduce(
          (n, r) =>
            BigInt(r.through_block!) < n ? BigInt(r.through_block!) : n,
          BigInt(snapshot.blockNumber),
        );
        const lastPeriodBlock = (
          await db<
            { block_number: string }[]
          >`SELECT block_number FROM canonical_blocks WHERE chain_id=${this.ledger.environment.deployment.chainId} AND block_number<=${commonBlock.toString()} AND block_timestamp<${period.endsAt} ORDER BY block_number DESC LIMIT 1`
        )[0];
        if (!lastPeriodBlock) throw new AppError("period_not_started", 409);
        const blockNumber = BigInt(lastPeriodBlock.block_number);
        const block = (
          await db<
            { block_hash: Hex; block_timestamp: string }[]
          >`SELECT block_hash,block_timestamp FROM canonical_blocks WHERE chain_id=${this.ledger.environment.deployment.chainId} AND block_number=${blockNumber.toString()}`
        )[0];
        if (!block) throw new AppError("index_not_ready", 503);
        snapshot = {
          ...snapshot,
          blockNumber: blockNumber.toString(),
          blockHash: block.block_hash,
          timestamp: block.block_timestamp,
        };
        if (BigInt(snapshot.timestamp) < BigInt(period.startsAt))
          throw new AppError("period_not_started", 409);
        const facts = (
          await db<
            { fact: unknown }[]
          >`SELECT fact FROM ledger_facts WHERE block_number<=${snapshot.blockNumber} AND market IN ${db(period.markets.map((m) => m.market.toLowerCase()))} ORDER BY block_number,transaction_index,log_index,fact_index LIMIT 100001`
        ).map((r) => ledgerFactSchema.parse(r.fact));
        if (facts.length > 100000)
          throw new AppError("leaderboard_capacity_exceeded", 503);
        const creators = new Map(
          (
            await db<
              { market: Address; creator: Address }[]
            >`SELECT market,creator FROM markets WHERE lower(market) IN ${db(period.markets.map((m) => m.market.toLowerCase()))}`
          ).map((r) => [r.market.toLowerCase(), r.creator]),
        );
        if (creators.size !== period.markets.length)
          throw new AppError("roster_data_incomplete", 409);
        const scores = scoreLeaderboard(
          period,
          accounts,
          facts,
          creators,
          new Set(accounts.map((a) => a.address.toLowerCase())),
        );
        const digest = createHash("sha256")
          .update(JSON.stringify([snapshot.epoch, snapshot.blockHash, scores]))
          .digest("hex");
        const previous = (
          await db<
            {
              id: string;
              version: number;
              epoch: string;
              block_hash: Hex;
              input_digest: string;
              block_number: string;
            }[]
          >`SELECT id,version,epoch,block_hash,input_digest,block_number FROM leaderboard_snapshots WHERE period_id=${period.id} ORDER BY version DESC LIMIT 1`
        )[0];
        if (previous?.input_digest === digest) return;
        if (
          previous?.epoch === snapshot.epoch &&
          BigInt(previous.block_number) > blockNumber
        )
          throw new AppError("account_backfill_pending", 409);
        const id = randomUUID(),
          version = (previous?.version ?? 0) + 1,
          correction =
            previous &&
            (previous.epoch !== snapshot.epoch ||
              previous.block_hash === snapshot.blockHash)
              ? "链重组、影子回放或账户验证数据更正后重新计算；旧快照已保留。"
              : null;
        const result = leaderboardSnapshotSchema.parse({
          id,
          period,
          version,
          statisticsVersion: "weighted-average-v1",
          data: snapshot,
          createdAt: new Date().toISOString(),
          ...scores,
          correction,
        });
        await db`INSERT INTO leaderboard_snapshots(id,period_id,version,block_number,block_hash,epoch,snapshot,input_digest) VALUES(${id},${period.id},${version},${snapshot.blockNumber},${snapshot.blockHash},${snapshot.epoch},${db.json(result)},${digest})`;
        if (previous && correction)
          await db`UPDATE leaderboard_snapshots SET corrected_by=${id} WHERE id=${previous.id}`;
      },
    );
  }
  async page(input: unknown) {
    const q = z
        .object({
          period: z.string().max(96).optional(),
          cursor: z.string().max(2048).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .parse(input),
      periods = await this.periods();
    const base = { periods, snapshot: null, items: [], nextCursor: null };
    if (!this.ledger.environment.features.leaderboard)
      return { ...base, status: "disabled" };
    if (!periods.length) return { ...base, status: "awaiting-roster" };
    const period = q.period ?? periods[0]!.id;
    let cursor: { id: string; period: string; offset: number } | undefined;
    if (q.cursor) {
      try {
        cursor = z
          .strictObject({
            id: z.string().uuid(),
            period: z.string(),
            offset: z.number().int().min(0).max(10000),
          })
          .parse(
            JSON.parse(Buffer.from(q.cursor, "base64url").toString("utf8")),
          );
      } catch {
        throw new AppError("invalid_cursor");
      }
      if (cursor.period !== period)
        throw new AppError("cursor_filter_mismatch");
    }
    const row = (
      await this.ledger.sql<
        { snapshot: unknown }[]
      >`SELECT snapshot FROM leaderboard_snapshots WHERE period_id=${period} AND (${cursor?.id ?? null}::uuid IS NULL OR id=${cursor?.id ?? null}::uuid) ORDER BY version DESC LIMIT 1`
    )[0];
    if (!row) {
      if (cursor) throw new AppError("invalid_cursor");
      return { ...base, status: "awaiting-snapshot" };
    }
    const snapshot = leaderboardSnapshotSchema.parse(row.snapshot);
    try {
      await this.ledger.assertSnapshot(snapshot.data);
    } catch (error) {
      if (error instanceof AppError && error.code === "snapshot_invalidated") {
        if (cursor) throw error;
        return { ...base, status: "correction-pending" };
      }
      throw error;
    }
    const offset = cursor?.offset ?? 0,
      items = snapshot.entries.slice(offset, offset + q.limit),
      { entries: _, ...summary } = snapshot;
    return {
      periods,
      snapshot: summary,
      items,
      nextCursor:
        offset + items.length < snapshot.entries.length
          ? Buffer.from(
              JSON.stringify({
                id: snapshot.id,
                period,
                offset: offset + items.length,
              }),
            ).toString("base64url")
          : null,
      status: "available",
    };
  }
}
