import { createHash } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import {
  AppError,
  environmentKey,
  uint,
  type Environment,
} from "../../app-core/src/contracts.js";
import {
  ledgerFactSchema,
  snapshotSchema,
  type LedgerFact,
  type LedgerSnapshot,
} from "../../app-core/src/ledger-contracts.js";
import { computePnl, type PnlOptions } from "../../app-core/src/pnl.js";
import { normalizeFinancialFacts } from "./financial-facts.js";
import type { CanonicalBlock, ChainCheckpoint, IndexedEvent } from "./store.js";

type Db = Sql | TransactionSql;
const cursorSchema = z.strictObject({
  snapshot: snapshotSchema,
  filter: z.string().length(64),
  position: z.tuple([
    uint,
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
});
export interface FinancialFilter {
  owner: Address;
  market?: Address;
  kinds?: LedgerFact["kind"][];
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}
export class PostgresFinancialLedger {
  constructor(
    readonly sql: Sql,
    readonly environment: Environment,
  ) {}
  async ready(): Promise<void> {
    const e = this.environment;
    await this
      .sql`INSERT INTO cpredict_environment_identity(singleton,identity) VALUES(true,${environmentKey(e)}) ON CONFLICT DO NOTHING`;
    const identity = await this.sql<
      { identity: string }[]
    >`SELECT identity FROM cpredict_environment_identity WHERE singleton`;
    if (identity[0]?.identity !== environmentKey(e))
      throw new Error("financial database belongs to another deployment");
    await this
      .sql`INSERT INTO ledger_environment(singleton,identity,deployment_block) VALUES(true,${environmentKey(e)},${e.deployment.deploymentBlock}) ON CONFLICT DO NOTHING`;
    const rows = await this.sql<
      { identity: string; projection_version: number }[]
    >`SELECT identity,projection_version FROM ledger_environment WHERE singleton`;
    if (
      rows[0]?.identity !== environmentKey(e) ||
      rows[0].projection_version !== 1
    )
      throw new Error("financial ledger environment or version mismatch");
  }
  async trackedAccounts(): Promise<readonly Address[]> {
    const rows = await this.sql<
      { address: Address }[]
    >`SELECT address FROM ledger_tracked_accounts ORDER BY address`;
    return rows.map((r) => getAddress(r.address));
  }
  async accountScanned(
    accounts: readonly Address[],
    from: bigint,
    to: bigint,
    hash: Hex,
  ): Promise<void> {
    if (!accounts.length) return;
    await this
      .sql`UPDATE ledger_tracked_accounts SET through_block=${to.toString()},through_hash=${hash}
      WHERE address IN ${this.sql(accounts.map((a) => a.toLowerCase()))} AND COALESCE(through_block,from_block-1)+1=${from.toString()}::numeric`;
  }
  async accountBackfillRange(
    to: bigint,
  ): Promise<{ accounts: Address[]; from: bigint; to: bigint } | null> {
    const rows = await this.sql<
      { address: Address; next_block: string }[]
    >`SELECT address,COALESCE(through_block+1,from_block) AS next_block FROM ledger_tracked_accounts WHERE COALESCE(through_block,from_block-1)<${to.toString()}::numeric ORDER BY next_block,address LIMIT 10`;
    if (!rows[0]) return null;
    const from = BigInt(rows[0].next_block),
      end = from + 499n < to ? from + 499n : to;
    return {
      accounts: rows
        .filter((r) => r.next_block === rows[0]!.next_block)
        .map((r) => getAddress(r.address)),
      from,
      to: end,
    };
  }
  async accountSnapshot(
    owner: Address,
    snapshot: LedgerSnapshot,
    db: Db = this.sql,
  ): Promise<LedgerSnapshot> {
    const rows = await db<
      { through_block: string | null }[]
    >`SELECT through_block FROM ledger_tracked_accounts WHERE address=${owner.toLowerCase()}`;
    // Old EOA accounts have public protocol history but no complete payment-token tracking.
    const paymentComplete =
      rows[0]?.through_block !== null &&
      rows[0]?.through_block !== undefined &&
      BigInt(rows[0].through_block) >= BigInt(snapshot.blockNumber);
    return { ...snapshot, complete: snapshot.complete && paymentComplete };
  }
  /** Called from the original event-store transaction, never an independent ingestion transaction. */
  async project(
    db: Db,
    events: readonly IndexedEvent[],
    blocks: readonly CanonicalBlock[],
    checkpoint?: ChainCheckpoint,
  ): Promise<void> {
    const chainId = this.environment.deployment.chainId;
    const [markets, listings, accounts] = await Promise.all([
      db<
        { market: Address }[]
      >`SELECT market FROM registered_markets WHERE chain_id=${chainId}`,
      db<
        {
          listing_id: Hex;
          vault: Address;
          seller: Address;
          outcome_id: string;
        }[]
      >`SELECT listing_id,vault,seller,outcome_id FROM listings WHERE chain_id=${chainId}`,
      db<{ address: Address }[]>`SELECT address FROM ledger_tracked_accounts`,
    ]);
    const facts = normalizeFinancialFacts(events, blocks, {
      environment: this.environment,
      markets: new Set(markets.map((r) => r.market.toLowerCase())),
      listings: new Map(
        listings.map((r) => [
          r.listing_id.toLowerCase(),
          { market: r.vault, seller: r.seller, outcomeId: r.outcome_id },
        ]),
      ),
      trackedAccounts: new Set(accounts.map((r) => r.address.toLowerCase())),
    });
    for (const f of facts)
      await db`INSERT INTO ledger_facts(chain_id,block_number,transaction_hash,transaction_index,log_index,fact_index,occurred_at,kind,market,owner,counterparty,fact)
      VALUES(${chainId},${f.blockNumber},${f.transactionHash},${f.transactionIndex},${f.logIndex},${f.factIndex},${f.timestamp},${f.kind},${f.market?.toLowerCase() ?? null},${f.owner?.toLowerCase() ?? null},${f.counterparty?.toLowerCase() ?? null},${db.json(f)})
      ON CONFLICT(chain_id,transaction_hash,log_index,fact_index,projection_version) DO UPDATE SET fact=EXCLUDED.fact, owner=EXCLUDED.owner,counterparty=EXCLUDED.counterparty,market=EXCLUDED.market`;
    if (checkpoint) {
      const first = blocks[0]?.blockNumber;
      // Completeness starts only with a full configured scanner at deployment, never by inferring it from event counts.
      await db`UPDATE ledger_environment SET
        coverage_start=COALESCE(coverage_start,${first?.toString() ?? null}),
        coverage_complete=CASE WHEN indexed_block=${checkpoint.blockNumber.toString()}::numeric THEN coverage_complete WHEN ${first?.toString() ?? null}::numeric IS NULL THEN false WHEN indexed_block IS NULL THEN ${first?.toString() ?? null}::numeric=deployment_block ELSE coverage_complete AND indexed_block+1=${first?.toString() ?? null}::numeric END,
        indexed_block=${checkpoint.blockNumber.toString()},indexed_hash=${checkpoint.blockHash} WHERE singleton`;
    }
  }
  async rollback(db: Db, blockNumber?: bigint): Promise<void> {
    const rows = await db<
      { epoch: string }[]
    >`UPDATE ledger_environment SET epoch=epoch+1,indexed_block=${blockNumber?.toString() ?? null},
      indexed_hash=(SELECT block_hash FROM canonical_blocks WHERE chain_id=${this.environment.deployment.chainId} AND block_number=${blockNumber?.toString() ?? null}),
      coverage_complete=CASE WHEN ${blockNumber?.toString() ?? null}::numeric IS NULL THEN false ELSE coverage_complete END RETURNING epoch`;
    await db`INSERT INTO ledger_corrections(epoch,from_block,reason) VALUES(${rows[0]!.epoch},${blockNumber === undefined ? this.environment.deployment.deploymentBlock : (blockNumber + 1n).toString()},'chain_reorganization')`;
    await db`UPDATE ledger_tracked_accounts SET through_block=CASE WHEN through_block IS NULL OR ${blockNumber?.toString() ?? null}::numeric IS NULL THEN NULL ELSE LEAST(through_block,${blockNumber?.toString() ?? null}::numeric) END,through_hash=NULL`;
  }
  async snapshot(db: Db = this.sql): Promise<LedgerSnapshot> {
    const rows = await db<
      {
        epoch: string;
        indexed_block: string | null;
        indexed_hash: Hex | null;
        coverage_start: string | null;
        coverage_complete: boolean;
        status: string;
        block_timestamp: string;
      }[]
    >`
      SELECT e.*,b.block_timestamp FROM ledger_environment e LEFT JOIN canonical_blocks b ON b.chain_id=${this.environment.deployment.chainId} AND b.block_number=e.indexed_block WHERE singleton`;
    const row = rows[0];
    if (
      !row?.indexed_block ||
      !row.indexed_hash ||
      row.block_timestamp === undefined
    )
      throw new AppError("index_not_ready", 503, "历史数据尚未完成初次同步");
    return snapshotSchema.parse({
      environment: this.environment.id,
      deploymentId: this.environment.deployment.id,
      version: 1,
      epoch: row.epoch,
      blockNumber: row.indexed_block,
      blockHash: row.indexed_hash,
      timestamp: row.block_timestamp,
      coverageStart: row.coverage_start,
      complete: row.coverage_complete,
      status: row.status,
    });
  }
  async assertSnapshot(
    snapshot: LedgerSnapshot,
    db: Db = this.sql,
  ): Promise<void> {
    const current = await this.snapshot(db);
    if (
      snapshot.environment !== current.environment ||
      snapshot.deploymentId !== current.deploymentId ||
      snapshot.epoch !== current.epoch ||
      BigInt(snapshot.blockNumber) > BigInt(current.blockNumber)
    )
      throw new AppError(
        "snapshot_invalidated",
        409,
        "历史快照已变化，请重新查询",
      );
    const blocks = await db<
      { block_hash: Hex }[]
    >`SELECT block_hash FROM canonical_blocks WHERE chain_id=${this.environment.deployment.chainId} AND block_number=${snapshot.blockNumber}`;
    if (blocks[0]?.block_hash !== snapshot.blockHash)
      throw new AppError(
        "snapshot_invalidated",
        409,
        "链重组使历史快照失效，请重新查询",
      );
  }
  async activity(filter: FinancialFilter): Promise<{
    items: LedgerFact[];
    nextCursor: string | null;
    snapshot: LedgerSnapshot;
  }> {
    if (
      !Number.isInteger(filter.limit) ||
      filter.limit < 1 ||
      filter.limit > 100
    )
      throw new RangeError("invalid page size");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          environment: environmentKey(this.environment),
          owner: filter.owner.toLowerCase(),
          market: filter.market?.toLowerCase() ?? null,
          kinds: [...(filter.kinds ?? [])].sort(),
          from: filter.from ?? null,
          to: filter.to ?? null,
        }),
      )
      .digest("hex");
    let cursor: z.infer<typeof cursorSchema> | undefined;
    if (filter.cursor) {
      try {
        if (filter.cursor.length > 2048) throw new Error();
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(filter.cursor, "base64url").toString("utf8")),
        );
      } catch {
        throw new AppError("invalid_cursor", 400, "分页游标无效");
      }
      if (cursor.filter !== fingerprint)
        throw new AppError("cursor_filter_mismatch", 400, "分页筛选条件已改变");
    }
    return this.sql.begin(
      "isolation level repeatable read read only",
      async (db) => {
        const snapshot = cursor?.snapshot ?? (await this.snapshot(db));
        await this.assertSnapshot(snapshot, db);
        const marketClause = filter.market
          ? db`AND market=${filter.market.toLowerCase()}`
          : db``;
        const kindClause = filter.kinds?.length
          ? db`AND kind IN ${db(filter.kinds)}`
          : db``;
        const fromClause =
          filter.from === undefined
            ? db``
            : db`AND occurred_at>=${filter.from}`;
        const toClause =
          filter.to === undefined ? db`` : db`AND occurred_at<${filter.to}`;
        const p = cursor?.position;
        const positionClause = p
          ? db`AND (block_number,transaction_index,log_index,fact_index)<(${p[0]}::numeric,${p[1]},${p[2]},${p[3]})`
          : db``;
        const rows = await db<
          { fact: unknown }[]
        >`SELECT fact FROM ledger_facts WHERE chain_id=${this.environment.deployment.chainId} AND block_number<=${snapshot.blockNumber}
        AND (owner=${filter.owner.toLowerCase()} OR counterparty=${filter.owner.toLowerCase()} OR (kind IN ('market-resolved','market-voided','timeout-funded','bond-timeout-funded') AND market IN (SELECT market FROM ledger_facts WHERE (owner=${filter.owner.toLowerCase()} OR counterparty=${filter.owner.toLowerCase()}) AND block_number<=${snapshot.blockNumber})))
        ${marketClause} ${kindClause} ${fromClause} ${toClause} ${positionClause} ORDER BY block_number DESC,transaction_index DESC,log_index DESC,fact_index DESC LIMIT ${filter.limit + 1}`;
        const facts = rows.map((r) => ledgerFactSchema.parse(r.fact)),
          items = facts.slice(0, filter.limit),
          last = items.at(-1);
        const nextCursor =
          facts.length > filter.limit && last
            ? Buffer.from(
                JSON.stringify({
                  snapshot,
                  filter: fingerprint,
                  position: [
                    last.blockNumber,
                    last.transactionIndex,
                    last.logIndex,
                    last.factIndex,
                  ],
                }),
              ).toString("base64url")
            : null;
        return { items, nextCursor, snapshot };
      },
    );
  }
  async accountFacts(
    owner: Address,
    snapshot: LedgerSnapshot,
    db: Db = this.sql,
  ): Promise<LedgerFact[]> {
    await this.assertSnapshot(snapshot, db);
    const rows = await db<
      { fact: unknown }[]
    >`WITH owned_markets AS (SELECT DISTINCT market FROM ledger_facts WHERE block_number<=${snapshot.blockNumber} AND (owner=${owner.toLowerCase()} OR counterparty=${owner.toLowerCase()}))
      SELECT fact FROM ledger_facts WHERE chain_id=${this.environment.deployment.chainId} AND block_number<=${snapshot.blockNumber} AND
      (owner=${owner.toLowerCase()} OR counterparty=${owner.toLowerCase()} OR (market IN (SELECT market FROM owned_markets) AND kind IN ('market-resolved','market-voided','timeout-funded','bond-timeout-funded','economic-snapshot')))
      ORDER BY block_number,transaction_index,log_index,fact_index LIMIT 100001`;
    if (rows.length > 100000)
      throw new AppError(
        "history_capacity_exceeded",
        503,
        "该账户历史需要离线汇总，请稍后查询",
      );
    return rows.map((r) => ledgerFactSchema.parse(r.fact));
  }
  async pnl(
    owner: Address,
    options: Omit<PnlOptions, "coverageComplete"> = {},
  ) {
    return this.sql.begin(
      "isolation level repeatable read read only",
      async (db) => {
        const snapshot = await this.accountSnapshot(
            owner,
            await this.snapshot(db),
            db,
          ),
          facts = await this.accountFacts(owner, snapshot, db);
        return {
          pnl: computePnl(owner, facts, {
            ...options,
            coverageComplete: snapshot.complete,
          }),
          snapshot,
        };
      },
    );
  }
}
