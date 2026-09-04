import postgres, { type Sql, type TransactionSql } from "postgres";
import { getAddress, type Address, type Hex } from "viem";
import {
  evidenceUriFromHash,
  normalizeEvidenceHash,
} from "../../sdk/src/evidence.js";
import { deriveMutations, type DerivedMutation } from "./derived.js";
import type {
  ActivityKind,
  ActivityView,
  CanonicalBlock,
  ChainCheckpoint,
  ClaimView,
  ConfirmationStatus,
  EventStore,
  FillView,
  IndexedEvent,
  IndexerQueryStore,
  ListingView,
  MarketCatalogOptions,
  MarketView,
  PositionView,
  QueryOptions,
  QueryPage,
} from "./store.js";
import {
  decodeOpaqueCursor,
  encodeOpaqueCursor,
  marketState,
  positionMarketSnapshot,
} from "./store.js";

type Db = Sql | TransactionSql;

/** PostgreSQL event store with canonical-block lineage and transactionally rebuilt projections. */
export class PostgresEventStore implements EventStore, IndexerQueryStore {
  private readonly sql: Sql;

  constructor(connectionString: string, maximumConnections = 10) {
    if (
      !connectionString.startsWith("postgres://") &&
      !connectionString.startsWith("postgresql://")
    ) {
      throw new TypeError("DATABASE_URL must use postgres:// or postgresql://");
    }
    if (
      !Number.isSafeInteger(maximumConnections) ||
      maximumConnections < 1 ||
      maximumConnections > 100
    ) {
      throw new RangeError("maximumConnections must be within [1, 100]");
    }
    this.sql = postgres(connectionString, {
      max: maximumConnections,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: true,
      onnotice: () => undefined,
    });
  }

  async checkpoint(chainId: number): Promise<ChainCheckpoint | undefined> {
    const rows = await this.sql<
      Array<{ block_number: string; block_hash: Hex }>
    >`
      SELECT block_number, block_hash FROM chain_checkpoints WHERE chain_id = ${chainId}
    `;
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          chainId,
          blockNumber: BigInt(row.block_number),
          blockHash: row.block_hash,
        };
  }

  async canonicalBlock(
    chainId: number,
    blockNumber: bigint,
  ): Promise<CanonicalBlock | undefined> {
    const rows = await this.sql<Array<CanonicalBlockRow>>`
      SELECT block_number, block_hash, parent_hash, block_timestamp, confirmation_status
      FROM canonical_blocks
      WHERE chain_id = ${chainId} AND block_number = ${blockNumber.toString()}
    `;
    return rows[0] === undefined ? undefined : mapBlock(chainId, rows[0]);
  }

  async registeredMarkets(chainId: number): Promise<readonly Address[]> {
    const rows = await this.sql<Array<{ market: Address }>>`
      SELECT market FROM registered_markets WHERE chain_id = ${chainId} ORDER BY market
    `;
    return rows.map((row) => getAddress(row.market));
  }

  async applyBatch(
    events: readonly IndexedEvent[],
    blocks: readonly CanonicalBlock[],
    checkpoint: ChainCheckpoint,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      for (const block of blocks)
        await insertCanonicalBlock(transaction, block);
      for (const event of events) {
        const inserted = await insertRawEvent(transaction, event);
        if (inserted) await applyProjection(transaction, event);
      }
      const checkpointBlocks = await transaction<Array<{ block_hash: Hex }>>`
        SELECT block_hash FROM canonical_blocks
        WHERE chain_id = ${checkpoint.chainId}
          AND block_number = ${checkpoint.blockNumber.toString()}
      `;
      if (checkpointBlocks[0]?.block_hash !== checkpoint.blockHash) {
        throw new Error(
          "checkpoint does not match the persisted canonical block",
        );
      }
      await transaction`
        INSERT INTO chain_checkpoints (chain_id, block_number, block_hash)
        VALUES (${checkpoint.chainId}, ${checkpoint.blockNumber.toString()}, ${checkpoint.blockHash})
        ON CONFLICT (chain_id) DO UPDATE SET
          block_number = EXCLUDED.block_number,
          block_hash = EXCLUDED.block_hash,
          updated_at = NOW()
      `;
    });
  }

  async rollbackAfter(
    chainId: number,
    blockNumber: bigint | undefined,
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`DELETE FROM chain_checkpoints WHERE chain_id = ${chainId}`;
      if (blockNumber === undefined) {
        await transaction`DELETE FROM canonical_blocks WHERE chain_id = ${chainId}`;
      } else {
        await transaction`
          DELETE FROM canonical_blocks
          WHERE chain_id = ${chainId} AND block_number > ${blockNumber.toString()}
        `;
      }
      await clearProjections(transaction, chainId);
      const retained = await transaction<Array<RawEventRow>>`
        SELECT block_number, block_hash, transaction_hash, transaction_index, log_index,
               contract_address, topics, data, confirmation_status
        FROM chain_events
        WHERE chain_id = ${chainId}
        ORDER BY block_number, transaction_index, log_index
      `;
      for (const row of retained)
        await applyProjection(transaction, mapRawEvent(chainId, row));

      if (blockNumber !== undefined) {
        const blocks = await transaction<Array<{ block_hash: Hex }>>`
          SELECT block_hash FROM canonical_blocks
          WHERE chain_id = ${chainId} AND block_number = ${blockNumber.toString()}
        `;
        const block = blocks[0];
        if (block === undefined)
          throw new Error("rollback ancestor canonical block is missing");
        await transaction`
          INSERT INTO chain_checkpoints (chain_id, block_number, block_hash)
          VALUES (${chainId}, ${blockNumber.toString()}, ${block.block_hash})
        `;
      }
    });
  }

  async listMarkets(
    chainId: number,
    options: QueryOptions,
  ): Promise<QueryPage<MarketView>> {
    const { limit, offset } = pageInput(options);
    const rows = await this.sql<Array<MarketRow>>`
      SELECT * FROM markets WHERE chain_id = ${chainId}
      ORDER BY created_block DESC, market DESC OFFSET ${offset} LIMIT ${limit + 1}
    `;
    return page(rows.map(mapMarket), limit, offset);
  }

  async market(
    chainId: number,
    market: Address,
  ): Promise<MarketView | undefined> {
    const rows = await this.sql<Array<MarketRow>>`
      SELECT * FROM markets WHERE chain_id = ${chainId} AND market = ${getAddress(market)}
    `;
    return rows[0] === undefined ? undefined : mapMarket(rows[0]);
  }

  async listMarketCatalog(
    chainId: number,
    options: MarketCatalogOptions,
  ): Promise<QueryPage<MarketView>> {
    validateLimit(options.limit);
    const statusFilter =
      options.status === undefined
        ? this.sql``
        : this.sql`AND m.state = ${marketState(options.status)}`;
    const ownerFilter =
      options.owner === undefined
        ? this.sql``
        : this.sql`AND (
            m.creator = ${getAddress(options.owner)}
            OR EXISTS (
              SELECT 1
              FROM activities a
              JOIN activity_participants ap
                ON ap.chain_id = a.chain_id
               AND ap.transaction_hash = a.transaction_hash
               AND ap.log_index = a.log_index
              WHERE a.chain_id = m.chain_id
                AND a.vault = m.market
                AND ap.participant = ${getAddress(options.owner)}
            )
          )`;
    const cursor =
      options.cursor === undefined ? undefined : marketCursor(options.cursor);
    const cursorFilter =
      cursor === undefined
        ? this.sql``
        : this.sql`AND (
            m.created_block < ${cursor.block.toString()}
            OR (m.created_block = ${cursor.block.toString()} AND m.market < ${cursor.market})
          )`;
    const rows = await this.sql<Array<MarketRow>>`
      SELECT m.* FROM markets m
      WHERE m.chain_id = ${chainId} ${statusFilter} ${ownerFilter} ${cursorFilter}
      ORDER BY m.created_block DESC, m.market DESC
      LIMIT ${options.limit + 1}
    `;
    const items = rows.slice(0, options.limit).map(mapMarket);
    const last = items.at(-1);
    return rows.length > options.limit && last !== undefined
      ? {
          items,
          nextCursor: encodeOpaqueCursor({
            block: last.createdBlock.toString(),
            market: last.market,
          }),
        }
      : { items };
  }

  async listListings(
    chainId: number,
    options: QueryOptions & {
      vault?: Address | undefined;
      active?: boolean | undefined;
    },
  ): Promise<QueryPage<ListingView>> {
    const { limit, offset } = pageInput(options);
    const vaultFilter =
      options.vault === undefined
        ? this.sql``
        : this.sql`AND vault = ${getAddress(options.vault)}`;
    const activeFilter =
      options.active === undefined
        ? this.sql``
        : this.sql`AND active = ${options.active}`;
    const rows = await this.sql<Array<ListingRow>>`
      SELECT * FROM listings WHERE chain_id = ${chainId} ${vaultFilter} ${activeFilter}
      ORDER BY updated_block DESC, listing_id DESC OFFSET ${offset} LIMIT ${limit + 1}
    `;
    return page(rows.map(mapListing), limit, offset);
  }

  async listFills(
    chainId: number,
    options: QueryOptions & {
      vault?: Address | undefined;
      listingId?: Hex | undefined;
    },
  ): Promise<QueryPage<FillView>> {
    const { limit, offset } = pageInput(options);
    const vaultFilter =
      options.vault === undefined
        ? this.sql``
        : this.sql`AND vault = ${getAddress(options.vault)}`;
    const listingFilter =
      options.listingId === undefined
        ? this.sql``
        : this.sql`AND listing_id = ${options.listingId}`;
    const rows = await this.sql<Array<FillRow>>`
      SELECT * FROM fills WHERE chain_id = ${chainId} ${vaultFilter} ${listingFilter}
      ORDER BY block_number DESC, log_index DESC OFFSET ${offset} LIMIT ${limit + 1}
    `;
    return page(rows.map(mapFill), limit, offset);
  }

  async listPositions(
    chainId: number,
    owner: Address,
    options: QueryOptions & { vault?: Address | undefined },
  ): Promise<QueryPage<PositionView>> {
    const { limit, offset } = pageInput(options);
    const vaultFilter =
      options.vault === undefined
        ? this.sql``
        : this.sql`AND p.vault = ${getAddress(options.vault)}`;
    const rows = await this.sql<Array<PositionRow>>`
      SELECT
        p.chain_id,
        p.vault,
        p.owner,
        p.outcome_id,
        p.balance,
        p.updated_block,
        p.confirmation_status,
        m.state AS market_state,
        m.winning_outcome
      FROM positions p
      LEFT JOIN markets m
        ON m.chain_id = p.chain_id AND m.market = p.vault
      WHERE p.chain_id = ${chainId} AND p.owner = ${getAddress(owner)} ${vaultFilter} AND p.balance > 0
      ORDER BY p.updated_block DESC, p.vault, p.outcome_id OFFSET ${offset} LIMIT ${limit + 1}
    `;
    return page(rows.map(mapPosition), limit, offset);
  }

  async listClaims(
    chainId: number,
    owner: Address,
    options: QueryOptions & { vault?: Address | undefined },
  ): Promise<QueryPage<ClaimView>> {
    const { limit, offset } = pageInput(options);
    const vaultFilter =
      options.vault === undefined
        ? this.sql``
        : this.sql`AND vault = ${getAddress(options.vault)}`;
    const rows = await this.sql<Array<ClaimRow>>`
      SELECT * FROM claims
      WHERE chain_id = ${chainId} AND owner = ${getAddress(owner)} ${vaultFilter}
      ORDER BY block_number DESC, log_index DESC OFFSET ${offset} LIMIT ${limit + 1}
    `;
    return page(rows.map(mapClaim), limit, offset);
  }

  async listActivity(
    chainId: number,
    owner: Address,
    options: QueryOptions,
  ): Promise<QueryPage<ActivityView>> {
    validateLimit(options.limit);
    const cursor =
      options.cursor === undefined ? undefined : activityCursor(options.cursor);
    const cursorFilter =
      cursor === undefined
        ? this.sql``
        : this.sql`AND (
            a.block_number < ${cursor.block.toString()}
            OR (
              a.block_number = ${cursor.block.toString()}
              AND a.transaction_hash < ${cursor.transactionHash}
            )
            OR (
              a.block_number = ${cursor.block.toString()}
              AND a.transaction_hash = ${cursor.transactionHash}
              AND a.log_index < ${cursor.logIndex}
            )
          )`;
    const rows = await this.sql<Array<ActivityRow>>`
      SELECT a.*
      FROM activities a
      JOIN activity_participants ap
        ON ap.chain_id = a.chain_id
       AND ap.transaction_hash = a.transaction_hash
       AND ap.log_index = a.log_index
      WHERE a.chain_id = ${chainId}
        AND ap.participant = ${getAddress(owner)}
        ${cursorFilter}
      ORDER BY a.block_number DESC, a.transaction_hash DESC, a.log_index DESC
      LIMIT ${options.limit + 1}
    `;
    const items = rows.slice(0, options.limit).map(mapActivity);
    const last = items.at(-1);
    return rows.length > options.limit && last !== undefined
      ? {
          items,
          nextCursor: encodeOpaqueCursor({
            block: last.blockNumber.toString(),
            transactionHash: last.transactionHash,
            logIndex: last.logIndex,
          }),
        }
      : { items };
  }

  async ready(): Promise<void> {
    const rows = await this.sql<
      Array<{
        canonical_blocks: string | null;
        chain_events: string | null;
        chain_checkpoints: string | null;
        markets: string | null;
        markets_evidence_hash: boolean;
        markets_rules_hash: boolean;
        markets_time_fields: boolean;
        activities: string | null;
        activity_participants: string | null;
        markets_chain_created_idx: string | null;
        markets_chain_state_created_idx: string | null;
        listings_chain_active_updated_idx: string | null;
        fills_listing_block_idx: string | null;
        positions_owner_updated_idx: string | null;
      }>
    >`
      SELECT
        to_regclass('canonical_blocks')::text AS canonical_blocks,
        to_regclass('chain_events')::text AS chain_events,
        to_regclass('chain_checkpoints')::text AS chain_checkpoints,
        to_regclass('markets')::text AS markets,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'markets'
            AND column_name = 'evidence_hash'
        ) AS markets_evidence_hash,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'markets'
            AND column_name = 'rules_hash'
        ) AS markets_rules_hash,
        (SELECT count(*) = 3 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'markets'
            AND column_name IN ('created_at', 'event_starts_at', 'outcome_deadline_at')
        ) AS markets_time_fields,
        to_regclass('activities')::text AS activities,
        to_regclass('activity_participants')::text AS activity_participants,
        to_regclass('markets_chain_created_idx')::text AS markets_chain_created_idx,
        to_regclass('markets_chain_state_created_idx')::text AS markets_chain_state_created_idx,
        to_regclass('listings_chain_active_updated_idx')::text AS listings_chain_active_updated_idx,
        to_regclass('fills_listing_block_idx')::text AS fills_listing_block_idx,
        to_regclass('positions_owner_updated_idx')::text AS positions_owner_updated_idx
    `;
    const row = rows[0];
    if (
      row === undefined ||
      row.canonical_blocks === null ||
      row.chain_events === null ||
      row.chain_checkpoints === null ||
      row.markets === null ||
      !row.markets_evidence_hash ||
      !row.markets_time_fields ||
      !row.markets_rules_hash ||
      row.activities === null ||
      row.activity_participants === null ||
      row.markets_chain_created_idx === null ||
      row.markets_chain_state_created_idx === null ||
      row.listings_chain_active_updated_idx === null ||
      row.fills_listing_block_idx === null ||
      row.positions_owner_updated_idx === null
    ) {
      throw new Error("indexer database migration is not applied");
    }
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

async function insertCanonicalBlock(
  db: Db,
  block: CanonicalBlock,
): Promise<void> {
  await db`
    INSERT INTO canonical_blocks (
      chain_id, block_number, block_hash, parent_hash, block_timestamp, confirmation_status
    ) VALUES (
      ${block.chainId}, ${block.blockNumber.toString()}, ${block.blockHash}, ${block.parentHash},
      ${block.timestamp.toString()}, ${block.confirmationStatus}
    ) ON CONFLICT (chain_id, block_number) DO NOTHING
  `;
  const rows = await db<Array<{ block_hash: Hex }>>`
    SELECT block_hash FROM canonical_blocks
    WHERE chain_id = ${block.chainId} AND block_number = ${block.blockNumber.toString()}
  `;
  if (rows[0]?.block_hash !== block.blockHash) {
    throw new Error(
      `canonical hash conflict at block ${block.blockNumber.toString()}`,
    );
  }
}

async function insertRawEvent(db: Db, event: IndexedEvent): Promise<boolean> {
  const canonical = await db<Array<{ block_hash: Hex }>>`
    SELECT block_hash FROM canonical_blocks
    WHERE chain_id = ${event.chainId} AND block_number = ${event.blockNumber.toString()}
  `;
  if (canonical[0]?.block_hash !== event.blockHash) {
    throw new Error(
      `event hash does not match canonical block ${event.blockNumber.toString()}`,
    );
  }
  const rows = await db<Array<{ transaction_hash: Hex }>>`
    INSERT INTO chain_events (
      chain_id, block_number, block_hash, transaction_hash, transaction_index, log_index,
      contract_address, topics, data, confirmation_status
    ) VALUES (
      ${event.chainId}, ${event.blockNumber.toString()}, ${event.blockHash}, ${event.transactionHash},
      ${event.transactionIndex}, ${event.logIndex}, ${event.address},
      ${db.json([...event.topics])}, ${event.data}, ${event.confirmationStatus}
    ) ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING
    RETURNING transaction_hash
  `;
  return rows.length === 1;
}

async function applyProjection(db: Db, event: IndexedEvent): Promise<void> {
  for (const mutation of deriveMutations(event))
    await applyMutation(db, event, mutation);
}

async function applyMutation(
  db: Db,
  event: IndexedEvent,
  mutation: DerivedMutation,
): Promise<void> {
  switch (mutation.kind) {
    case "market-created":
      await db`
        INSERT INTO registered_markets (
          chain_id, market, registered_block, transaction_hash, log_index
        ) VALUES (
          ${event.chainId}, ${mutation.market}, ${event.blockNumber.toString()},
          ${event.transactionHash}, ${event.logIndex}
        ) ON CONFLICT (chain_id, market) DO NOTHING
      `;
      await db`
        INSERT INTO markets (
          chain_id, market, creator, deployment_mode, creator_bond, state,
          created_block, updated_block, confirmation_status
        ) VALUES (
          ${event.chainId}, ${mutation.market}, ${mutation.creator}, ${mutation.deploymentMode},
          ${mutation.creatorBond.toString()}, 0, ${event.blockNumber.toString()},
          ${event.blockNumber.toString()}, ${event.confirmationStatus}
        ) ON CONFLICT (chain_id, market) DO NOTHING
      `;
      await recordActivity(db, event, {
        kind: "market-created",
        vault: mutation.market,
        actor: mutation.creator,
        amount: mutation.creatorBond,
      });
      return;
    case "market-initialized":
      await db`
        INSERT INTO markets (
          chain_id, market, creator, deployment_mode, outcome_count, created_at, close_at, event_starts_at, outcome_deadline_at, resolution_window,
          market_primary_cap, creator_bond, state, created_block, updated_block,
          confirmation_status
        ) VALUES (
          ${event.chainId}, ${mutation.market}, ${mutation.creator}, ${mutation.deploymentMode},
          ${mutation.outcomeCount}, ${mutation.createdAt.toString()}, ${mutation.closeAt.toString()},
          ${mutation.eventStartsAt?.toString() ?? null}, ${mutation.outcomeDeadlineAt.toString()}, ${mutation.resolutionWindow.toString()},
          ${mutation.marketPrimaryCap.toString()}, ${mutation.creatorBond.toString()}, 0,
          ${event.blockNumber.toString()}, ${event.blockNumber.toString()},
          ${event.confirmationStatus}
        ) ON CONFLICT (chain_id, market) DO UPDATE SET
          outcome_count = EXCLUDED.outcome_count,
          created_at = EXCLUDED.created_at,
          close_at = EXCLUDED.close_at,
          event_starts_at = EXCLUDED.event_starts_at,
          outcome_deadline_at = EXCLUDED.outcome_deadline_at,
          resolution_window = EXCLUDED.resolution_window,
          market_primary_cap = EXCLUDED.market_primary_cap,
          creator_bond = EXCLUDED.creator_bond,
          updated_block = EXCLUDED.updated_block,
          confirmation_status = EXCLUDED.confirmation_status
      `;
      return;
    case "market-metadata":
      await db`
        UPDATE markets SET
          rules_hash = ${mutation.rulesHash},
          metadata_uri = ${mutation.metadataUri},
          resolution_source_hash = ${mutation.resolutionSourceHash},
          resolution_source_uri = ${mutation.resolutionSourceUri},
          close_at = ${mutation.closeAt.toString()},
          event_starts_at = ${mutation.eventStartsAt?.toString() ?? null},
          outcome_deadline_at = ${mutation.outcomeDeadlineAt.toString()},
          creator_treasury = ${mutation.creatorTreasury},
          feature_flags = ${mutation.featureFlags.toString()},
          updated_block = ${event.blockNumber.toString()},
          confirmation_status = ${event.confirmationStatus}
        WHERE chain_id = ${event.chainId} AND market = ${mutation.market}
      `;
      return;
    case "primary-purchased":
      await db`
        UPDATE markets SET
          primary_filled_units = primary_filled_units + ${mutation.filledUnits.toString()},
          primary_payment = ${mutation.totalPrincipal.toString()},
          updated_block = ${event.blockNumber.toString()},
          confirmation_status = ${event.confirmationStatus}
        WHERE chain_id = ${event.chainId} AND market = ${mutation.market}
      `;
      await recordActivity(db, event, {
        kind: "primary-purchased",
        vault: mutation.market,
        actor: mutation.buyer,
        outcomeId: mutation.outcomeId,
        units: mutation.filledUnits,
        amount: mutation.payment,
      });
      return;
    case "market-terminal": {
      const participantRows = await db<Array<{ participant: Address }>>`
        SELECT creator AS participant FROM markets
        WHERE chain_id = ${event.chainId} AND market = ${mutation.market}
        UNION
        SELECT owner AS participant FROM positions
        WHERE chain_id = ${event.chainId}
          AND vault = ${mutation.market}
          AND balance > 0
      `;
      await db`
        UPDATE markets SET state = ${mutation.state},
          void_reason = ${mutation.voidReason},
          winning_outcome = ${nullableBigint(mutation.winningOutcome)},
          evidence_hash = ${mutation.evidenceHash},
          updated_block = ${event.blockNumber.toString()}, confirmation_status = ${event.confirmationStatus}
        WHERE chain_id = ${event.chainId} AND market = ${mutation.market}
      `;
      await recordActivity(
        db,
        event,
        {
          kind: terminalActivityKind(mutation.terminalKind),
          vault: mutation.market,
          actor: mutation.caller,
        },
        participantRows.map((row) => row.participant),
      );
      return;
    }
    case "listing-created":
      await db`
        INSERT INTO listings (
          chain_id, listing_id, vault, seller, outcome_id, remaining_units, unit_price,
          expires_at, active, created_block, updated_block, confirmation_status
        ) VALUES (
          ${event.chainId}, ${mutation.listingId}, ${mutation.vault}, ${mutation.seller},
          ${mutation.outcomeId.toString()}, ${mutation.amount.toString()},
          ${mutation.unitPrice.toString()}, ${mutation.expiresAt.toString()}, TRUE,
          ${event.blockNumber.toString()}, ${event.blockNumber.toString()},
          ${event.confirmationStatus}
        ) ON CONFLICT (chain_id, listing_id) DO NOTHING
      `;
      await recordActivity(db, event, {
        kind: "listing-created",
        vault: mutation.vault,
        actor: mutation.seller,
        outcomeId: mutation.outcomeId,
        listingId: mutation.listingId,
        units: mutation.amount,
        amount: mutation.unitPrice,
      });
      return;
    case "listing-filled": {
      const listings = await db<Array<{ vault: Address; outcome_id: string }>>`
        UPDATE listings SET remaining_units = ${mutation.remainingUnits.toString()},
          active = ${mutation.remainingUnits !== 0n}, updated_block = ${event.blockNumber.toString()},
          confirmation_status = ${event.confirmationStatus}
        WHERE chain_id = ${event.chainId} AND listing_id = ${mutation.listingId}
        RETURNING vault, outcome_id
      `;
      const listing = listings[0];
      if (listing === undefined)
        throw new Error(
          `fill references unknown listing ${mutation.listingId}`,
        );
      await db`
        INSERT INTO fills (
          chain_id, transaction_hash, log_index, listing_id, vault, buyer, seller,
          filled_units, gross, block_number, confirmation_status
        ) VALUES (
          ${event.chainId}, ${event.transactionHash}, ${event.logIndex}, ${mutation.listingId},
          ${listing.vault}, ${mutation.buyer}, ${mutation.seller}, ${mutation.filledUnits.toString()},
          ${mutation.gross.toString()}, ${event.blockNumber.toString()}, ${event.confirmationStatus}
        ) ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING
      `;
      await recordActivity(db, event, {
        kind: "listing-filled",
        vault: listing.vault,
        actor: mutation.buyer,
        counterparty: mutation.seller,
        outcomeId: BigInt(listing.outcome_id),
        listingId: mutation.listingId,
        units: mutation.filledUnits,
        amount: mutation.gross,
      });
      return;
    }
    case "listing-closed": {
      const listings = await db<Array<{ vault: Address; outcome_id: string }>>`
        UPDATE listings SET remaining_units = 0, active = FALSE,
          updated_block = ${event.blockNumber.toString()}, confirmation_status = ${event.confirmationStatus}
        WHERE chain_id = ${event.chainId} AND listing_id = ${mutation.listingId}
        RETURNING vault, outcome_id
      `;
      const listing = listings[0];
      if (listing === undefined)
        throw new Error(
          `close references unknown listing ${mutation.listingId}`,
        );
      await recordActivity(db, event, {
        kind: mutation.closeKind,
        vault: listing.vault,
        actor: mutation.caller,
        counterparty:
          mutation.caller === mutation.seller ? null : mutation.seller,
        outcomeId: BigInt(listing.outcome_id),
        listingId: mutation.listingId,
      });
      return;
    }
    case "position-delta":
      if (mutation.delta >= 0n) {
        await db`
          INSERT INTO positions (
            chain_id, vault, owner, outcome_id, balance, updated_block, confirmation_status
          ) VALUES (
            ${event.chainId}, ${mutation.vault}, ${mutation.owner}, ${mutation.outcomeId.toString()},
            ${mutation.delta.toString()}, ${event.blockNumber.toString()}, ${event.confirmationStatus}
          ) ON CONFLICT (chain_id, vault, owner, outcome_id) DO UPDATE SET
            balance = positions.balance + EXCLUDED.balance,
            updated_block = EXCLUDED.updated_block,
            confirmation_status = EXCLUDED.confirmation_status
        `;
        return;
      }
      const debited = await db<Array<{ balance: string }>>`
        UPDATE positions SET
          balance = balance + ${mutation.delta.toString()},
          updated_block = ${event.blockNumber.toString()},
          confirmation_status = ${event.confirmationStatus}
        WHERE chain_id = ${event.chainId}
          AND vault = ${mutation.vault}
          AND owner = ${mutation.owner}
          AND outcome_id = ${mutation.outcomeId.toString()}
          AND balance >= ${(-mutation.delta).toString()}
        RETURNING balance
      `;
      if (debited.length !== 1)
        throw new Error("position debit exceeds indexed balance");
      return;
    case "claim":
      await db`
        INSERT INTO claims (
          chain_id, transaction_hash, log_index, vault, owner, caller, claim_kind,
          units, amount, block_number, confirmation_status
        ) VALUES (
          ${event.chainId}, ${event.transactionHash}, ${event.logIndex}, ${mutation.vault},
          ${mutation.owner}, ${mutation.caller}, ${mutation.claimKind}, ${mutation.units.toString()},
          ${mutation.amount.toString()}, ${event.blockNumber.toString()}, ${event.confirmationStatus}
        ) ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING
      `;
      await recordActivity(db, event, {
        kind: claimActivityKind(mutation.claimKind),
        vault: mutation.vault,
        actor: mutation.caller,
        counterparty:
          mutation.caller === mutation.owner ? null : mutation.owner,
        units: mutation.units,
        amount: mutation.amount,
      });
  }
}

async function recordActivity(
  db: Db,
  event: IndexedEvent,
  input: {
    kind: ActivityKind;
    vault: Address;
    actor: Address | null;
    counterparty?: Address | null;
    outcomeId?: bigint | null;
    listingId?: Hex | null;
    units?: bigint | null;
    amount?: bigint | null;
  },
  extraParticipants: readonly Address[] = [],
): Promise<void> {
  const counterparty = input.counterparty ?? null;
  await db`
    INSERT INTO activities (
      chain_id, transaction_hash, log_index, activity_kind, vault, actor,
      counterparty, outcome_id, listing_id, units, amount, block_number,
      confirmation_status
    ) VALUES (
      ${event.chainId}, ${event.transactionHash}, ${event.logIndex}, ${input.kind},
      ${input.vault}, ${input.actor}, ${counterparty},
      ${nullableBigint(input.outcomeId ?? null)}, ${input.listingId ?? null},
      ${nullableBigint(input.units ?? null)}, ${nullableBigint(input.amount ?? null)},
      ${event.blockNumber.toString()}, ${event.confirmationStatus}
    ) ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING
  `;
  const participants = new Set(
    [input.actor, counterparty, ...extraParticipants]
      .filter((participant): participant is Address => participant !== null)
      .map(getAddress),
  );
  for (const participant of participants) {
    await db`
      INSERT INTO activity_participants (
        chain_id, transaction_hash, log_index, participant
      ) VALUES (
        ${event.chainId}, ${event.transactionHash}, ${event.logIndex}, ${participant}
      ) ON CONFLICT DO NOTHING
    `;
  }
}

async function clearProjections(db: Db, chainId: number): Promise<void> {
  await db`DELETE FROM activity_participants WHERE chain_id = ${chainId}`;
  await db`DELETE FROM activities WHERE chain_id = ${chainId}`;
  await db`DELETE FROM claims WHERE chain_id = ${chainId}`;
  await db`DELETE FROM fills WHERE chain_id = ${chainId}`;
  await db`DELETE FROM positions WHERE chain_id = ${chainId}`;
  await db`DELETE FROM listings WHERE chain_id = ${chainId}`;
  await db`DELETE FROM markets WHERE chain_id = ${chainId}`;
  await db`DELETE FROM registered_markets WHERE chain_id = ${chainId}`;
}

interface CanonicalBlockRow {
  block_number: string;
  block_hash: Hex;
  parent_hash: Hex;
  block_timestamp: string;
  confirmation_status: ConfirmationStatus;
}

interface RawEventRow {
  block_number: string;
  block_hash: Hex;
  transaction_hash: Hex;
  transaction_index: number;
  log_index: number;
  contract_address: Address;
  topics: readonly Hex[];
  data: Hex;
  confirmation_status: ConfirmationStatus;
}

interface MarketRow {
  chain_id: string;
  market: Address;
  creator: Address;
  deployment_mode: number;
  outcome_count: number | null;
  close_at: string | null;
  created_at: string | null;
  event_starts_at: string | null;
  outcome_deadline_at: string | null;
  resolution_window: string | null;
  rules_hash: Hex | null;
  metadata_uri: string | null;
  resolution_source_hash: Hex | null;
  resolution_source_uri: string | null;
  creator_treasury: Address | null;
  feature_flags: string | null;
  market_primary_cap: string | null;
  primary_filled_units: string;
  primary_payment: string;
  creator_bond: string;
  state: number;
  void_reason: number;
  winning_outcome: string | null;
  evidence_hash: Hex | null;
  created_block: string;
  updated_block: string;
  confirmation_status: ConfirmationStatus;
}

interface ListingRow {
  chain_id: string;
  listing_id: Hex;
  vault: Address;
  seller: Address;
  outcome_id: string;
  remaining_units: string;
  unit_price: string;
  expires_at: string;
  active: boolean;
  created_block: string;
  updated_block: string;
  confirmation_status: ConfirmationStatus;
}

interface FillRow {
  chain_id: string;
  transaction_hash: Hex;
  log_index: number;
  listing_id: Hex;
  vault: Address;
  buyer: Address;
  seller: Address;
  filled_units: string;
  gross: string;
  block_number: string;
  confirmation_status: ConfirmationStatus;
}

interface PositionRow {
  chain_id: string;
  vault: Address;
  owner: Address;
  outcome_id: string;
  balance: string;
  updated_block: string;
  confirmation_status: ConfirmationStatus;
  market_state: number | string | null;
  winning_outcome: string | null;
}

interface ClaimRow {
  chain_id: string;
  transaction_hash: Hex;
  log_index: number;
  vault: Address;
  owner: Address;
  caller: Address;
  claim_kind: string;
  units: string;
  amount: string;
  block_number: string;
  confirmation_status: ConfirmationStatus;
}

interface ActivityRow {
  chain_id: string;
  transaction_hash: Hex;
  log_index: number;
  activity_kind: ActivityKind;
  vault: Address;
  actor: Address | null;
  counterparty: Address | null;
  outcome_id: string | null;
  listing_id: Hex | null;
  units: string | null;
  amount: string | null;
  block_number: string;
  confirmation_status: ConfirmationStatus;
}

function mapBlock(chainId: number, row: CanonicalBlockRow): CanonicalBlock {
  return {
    chainId,
    blockNumber: BigInt(row.block_number),
    blockHash: row.block_hash,
    parentHash: row.parent_hash,
    timestamp: BigInt(row.block_timestamp),
    confirmationStatus: row.confirmation_status,
  };
}

function mapRawEvent(chainId: number, row: RawEventRow): IndexedEvent {
  // Corrupt JSON must abort the rebuilding transaction, not turn known events
  // into unknown topics and silently erase their projections.
  if (
    !Array.isArray(row.topics) ||
    row.topics.length > 4 ||
    !row.topics.every(
      (topic) => typeof topic === "string" && /^0x[0-9a-fA-F]{64}$/.test(topic),
    )
  ) {
    throw new Error(
      "persisted event topics must be an array of bytes32 values",
    );
  }
  return {
    chainId,
    blockNumber: BigInt(row.block_number),
    blockHash: row.block_hash,
    transactionHash: row.transaction_hash,
    transactionIndex: row.transaction_index,
    logIndex: row.log_index,
    address: getAddress(row.contract_address),
    topics: row.topics,
    data: row.data,
    confirmationStatus: row.confirmation_status,
  };
}

function mapMarket(row: MarketRow): MarketView {
  const evidenceHash =
    row.evidence_hash === null
      ? null
      : normalizeEvidenceHash(row.evidence_hash);
  return {
    chainId: Number(row.chain_id),
    market: getAddress(row.market),
    creator: getAddress(row.creator),
    deploymentMode: row.deployment_mode,
    outcomeCount: row.outcome_count,
    closeAt: row.close_at === null ? null : BigInt(row.close_at),
    createdAt: row.created_at === null ? null : BigInt(row.created_at),
    eventStartsAt:
      row.event_starts_at === null ? null : BigInt(row.event_starts_at),
    outcomeDeadlineAt:
      row.outcome_deadline_at === null ? null : BigInt(row.outcome_deadline_at),
    resolutionWindow:
      row.resolution_window === null ? null : BigInt(row.resolution_window),
    rulesHash: row.rules_hash,
    metadataUri: row.metadata_uri,
    resolutionSourceHash: row.resolution_source_hash,
    resolutionSourceUri: row.resolution_source_uri,
    creatorTreasury:
      row.creator_treasury === null ? null : getAddress(row.creator_treasury),
    featureFlags: row.feature_flags === null ? null : BigInt(row.feature_flags),
    marketPrimaryCap:
      row.market_primary_cap === null ? null : BigInt(row.market_primary_cap),
    primaryFilledUnits: BigInt(row.primary_filled_units),
    primaryPayment: BigInt(row.primary_payment),
    creatorBond: BigInt(row.creator_bond),
    state: row.state,
    voidReason: row.void_reason,
    winningOutcome:
      row.winning_outcome === null ? null : BigInt(row.winning_outcome),
    evidenceHash,
    evidenceUri:
      evidenceHash === null ? null : evidenceUriFromHash(evidenceHash),
    createdBlock: BigInt(row.created_block),
    updatedBlock: BigInt(row.updated_block),
    confirmationStatus: row.confirmation_status,
  };
}

function mapListing(row: ListingRow): ListingView {
  return {
    chainId: Number(row.chain_id),
    listingId: row.listing_id,
    vault: getAddress(row.vault),
    seller: getAddress(row.seller),
    outcomeId: BigInt(row.outcome_id),
    remainingUnits: BigInt(row.remaining_units),
    unitPrice: BigInt(row.unit_price),
    expiresAt: BigInt(row.expires_at),
    active: row.active,
    createdBlock: BigInt(row.created_block),
    updatedBlock: BigInt(row.updated_block),
    confirmationStatus: row.confirmation_status,
  };
}

function mapFill(row: FillRow): FillView {
  return {
    chainId: Number(row.chain_id),
    transactionHash: row.transaction_hash,
    logIndex: row.log_index,
    listingId: row.listing_id,
    vault: getAddress(row.vault),
    buyer: getAddress(row.buyer),
    seller: getAddress(row.seller),
    filledUnits: BigInt(row.filled_units),
    gross: BigInt(row.gross),
    blockNumber: BigInt(row.block_number),
    confirmationStatus: row.confirmation_status,
  };
}

function mapPosition(row: PositionRow): PositionView {
  return {
    chainId: Number(row.chain_id),
    vault: getAddress(row.vault),
    owner: getAddress(row.owner),
    outcomeId: BigInt(row.outcome_id),
    balance: BigInt(row.balance),
    updatedBlock: BigInt(row.updated_block),
    confirmationStatus: row.confirmation_status,
    ...positionMarketSnapshot(
      row.market_state == null
        ? undefined
        : {
            state: Number(row.market_state),
            winningOutcome:
              row.winning_outcome == null ? null : BigInt(row.winning_outcome),
          },
    ),
  };
}

function mapClaim(row: ClaimRow): ClaimView {
  return {
    chainId: Number(row.chain_id),
    transactionHash: row.transaction_hash,
    logIndex: row.log_index,
    vault: getAddress(row.vault),
    owner: getAddress(row.owner),
    caller: getAddress(row.caller),
    claimKind: row.claim_kind,
    units: BigInt(row.units),
    amount: BigInt(row.amount),
    blockNumber: BigInt(row.block_number),
    confirmationStatus: row.confirmation_status,
  };
}

function mapActivity(row: ActivityRow): ActivityView {
  return {
    chainId: Number(row.chain_id),
    transactionHash: row.transaction_hash,
    logIndex: row.log_index,
    kind: row.activity_kind,
    vault: getAddress(row.vault),
    actor: row.actor === null ? null : getAddress(row.actor),
    counterparty:
      row.counterparty === null ? null : getAddress(row.counterparty),
    outcomeId: row.outcome_id === null ? null : BigInt(row.outcome_id),
    listingId: row.listing_id,
    units: row.units === null ? null : BigInt(row.units),
    amount: row.amount === null ? null : BigInt(row.amount),
    blockNumber: BigInt(row.block_number),
    confirmationStatus: row.confirmation_status,
  };
}

function pageInput(options: QueryOptions): { limit: number; offset: number } {
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    throw new RangeError("limit must be an integer within [1, 100]");
  }
  const offset =
    options.cursor === undefined ? 0 : Number.parseInt(options.cursor, 10);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100_000 ||
    String(offset) !== (options.cursor ?? "0")
  ) {
    throw new RangeError("invalid cursor");
  }
  return { limit: options.limit, offset };
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("limit must be an integer within [1, 100]");
}

interface MarketCursor {
  block: bigint;
  market: Address;
}

function marketCursor(value: string): MarketCursor {
  const decoded = decodeOpaqueCursor<{ block?: unknown; market?: unknown }>(
    value,
  );
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof decoded.block !== "string" ||
    !/^\d+$/.test(decoded.block) ||
    typeof decoded.market !== "string"
  ) {
    throw new RangeError("invalid cursor");
  }
  try {
    return { block: BigInt(decoded.block), market: getAddress(decoded.market) };
  } catch {
    throw new RangeError("invalid cursor");
  }
}

interface ActivityCursor {
  block: bigint;
  transactionHash: Hex;
  logIndex: number;
}

function activityCursor(value: string): ActivityCursor {
  const decoded = decodeOpaqueCursor<{
    block?: unknown;
    transactionHash?: unknown;
    logIndex?: unknown;
  }>(value);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof decoded.block !== "string" ||
    !/^\d+$/.test(decoded.block) ||
    typeof decoded.transactionHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(decoded.transactionHash) ||
    typeof decoded.logIndex !== "number" ||
    !Number.isSafeInteger(decoded.logIndex) ||
    decoded.logIndex < 0
  ) {
    throw new RangeError("invalid cursor");
  }
  return {
    block: BigInt(decoded.block),
    transactionHash: decoded.transactionHash as Hex,
    logIndex: decoded.logIndex,
  };
}

function terminalActivityKind(
  value:
    | "resolved"
    | "voided-creator"
    | "voided-no-winning-supply"
    | "voided-timeout",
): ActivityKind {
  switch (value) {
    case "resolved":
      return "market-resolved";
    case "voided-creator":
      return "market-voided-creator";
    case "voided-no-winning-supply":
      return "market-voided-no-winning-supply";
    case "voided-timeout":
      return "market-voided-timeout";
  }
}

function claimActivityKind(value: string): ActivityKind {
  switch (value) {
    case "winner":
      return "winner-claimed";
    case "early-bird":
      return "early-bird-claimed";
    case "principal-refund":
      return "principal-refunded";
    case "timeout-bonus":
      return "timeout-bonus-claimed";
    default:
      throw new RangeError(`unknown claim kind ${value}`);
  }
}

function page<T>(
  rows: readonly T[],
  limit: number,
  offset: number,
): QueryPage<T> {
  const items = rows.slice(0, limit);
  return rows.length > limit
    ? { items, nextCursor: String(offset + limit) }
    : { items };
}

function nullableBigint(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}
