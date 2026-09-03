import { getAddress, type Address, type Hex } from "viem";
import { deriveMutations, type DerivedMutation } from "./derived.js";
import { evidenceUriFromHash } from "../../sdk/src/evidence.js";
import type {
  ActivityKind,
  ActivityView,
  CanonicalBlock,
  ChainCheckpoint,
  ClaimView,
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

/** Deterministic store used by unit tests and local embedders; mirrors PostgreSQL semantics. */
export class MemoryEventStore implements EventStore, IndexerQueryStore {
  private readonly checkpoints = new Map<number, ChainCheckpoint>();
  private readonly blocks = new Map<string, CanonicalBlock>();
  private readonly events = new Map<string, IndexedEvent>();
  private readonly registered = new Map<string, Address>();
  private readonly markets = new Map<string, MarketView>();
  private readonly listings = new Map<string, ListingView>();
  private readonly fills = new Map<string, FillView>();
  private readonly positions = new Map<string, PositionView>();
  private readonly claims = new Map<string, ClaimView>();
  private readonly activities = new Map<string, ActivityView>();
  private readonly activityParticipants = new Map<string, Set<Address>>();

  async checkpoint(chainId: number): Promise<ChainCheckpoint | undefined> {
    return this.checkpoints.get(chainId);
  }

  async canonicalBlock(
    chainId: number,
    blockNumber: bigint,
  ): Promise<CanonicalBlock | undefined> {
    return this.blocks.get(blockKey(chainId, blockNumber));
  }

  async registeredMarkets(chainId: number): Promise<readonly Address[]> {
    return [...this.registered.entries()]
      .filter(([key]) => key.startsWith(`${chainId}:`))
      .map(([, address]) => address)
      .sort();
  }

  async applyBatch(
    events: readonly IndexedEvent[],
    blocks: readonly CanonicalBlock[],
    checkpoint: ChainCheckpoint,
  ): Promise<void> {
    for (const block of blocks) {
      const key = blockKey(block.chainId, block.blockNumber);
      const current = this.blocks.get(key);
      if (current !== undefined && current.blockHash !== block.blockHash) {
        throw new Error(
          `canonical hash conflict at block ${block.blockNumber.toString()}`,
        );
      }
      this.blocks.set(key, block);
    }
    for (const event of events) {
      const canonical = this.blocks.get(
        blockKey(event.chainId, event.blockNumber),
      );
      if (canonical?.blockHash !== event.blockHash) {
        throw new Error(
          `event hash does not match canonical block ${event.blockNumber.toString()}`,
        );
      }
      const key = eventKey(event);
      if (this.events.has(key)) continue;
      this.events.set(key, event);
      this.project(event);
    }
    const checkpointBlock = this.blocks.get(
      blockKey(checkpoint.chainId, checkpoint.blockNumber),
    );
    if (checkpointBlock?.blockHash !== checkpoint.blockHash) {
      throw new Error(
        "checkpoint does not match the persisted canonical block",
      );
    }
    this.checkpoints.set(checkpoint.chainId, checkpoint);
  }

  async rollbackAfter(
    chainId: number,
    blockNumber: bigint | undefined,
  ): Promise<void> {
    this.checkpoints.delete(chainId);
    for (const [key, block] of this.blocks) {
      if (
        block.chainId === chainId &&
        (blockNumber === undefined || block.blockNumber > blockNumber)
      ) {
        this.blocks.delete(key);
      }
    }
    for (const [key, event] of this.events) {
      if (
        event.chainId === chainId &&
        (blockNumber === undefined || event.blockNumber > blockNumber)
      ) {
        this.events.delete(key);
      }
    }
    this.clearProjections(chainId);
    const retained = [...this.events.values()]
      .filter((event) => event.chainId === chainId)
      .sort(compareEvents);
    for (const event of retained) this.project(event);
    if (blockNumber !== undefined) {
      const block = this.blocks.get(blockKey(chainId, blockNumber));
      if (block === undefined)
        throw new Error("rollback ancestor canonical block is missing");
      this.checkpoints.set(chainId, {
        chainId,
        blockNumber,
        blockHash: block.blockHash,
      });
    }
  }

  async listMarkets(
    chainId: number,
    options: QueryOptions,
  ): Promise<QueryPage<MarketView>> {
    return queryPage(
      [...this.markets.values()]
        .filter((market) => market.chainId === chainId)
        .sort((a, b) => compareBigintDesc(a.createdBlock, b.createdBlock)),
      options,
    );
  }

  async market(
    chainId: number,
    market: Address,
  ): Promise<MarketView | undefined> {
    return this.markets.get(addressKey(chainId, market));
  }

  async listMarketCatalog(
    chainId: number,
    options: MarketCatalogOptions,
  ): Promise<QueryPage<MarketView>> {
    validateLimit(options.limit);
    const owner =
      options.owner === undefined ? undefined : getAddress(options.owner);
    const cursor =
      options.cursor === undefined ? undefined : marketCursor(options.cursor);
    const items = [...this.markets.values()]
      .filter((market) => market.chainId === chainId)
      .filter(
        (market) =>
          options.status === undefined ||
          market.state === marketState(options.status),
      )
      .filter((market) => {
        if (owner === undefined) return true;
        if (market.creator === owner) return true;
        return [...this.activities.entries()].some(
          ([key, activity]) =>
            activity.chainId === chainId &&
            activity.vault === market.market &&
            this.activityParticipants.get(key)?.has(owner) === true,
        );
      })
      .filter(
        (market) =>
          cursor === undefined ||
          market.createdBlock < cursor.block ||
          (market.createdBlock === cursor.block &&
            market.market.toLowerCase() < cursor.market.toLowerCase()),
      )
      .sort(compareMarketsDesc);
    const pageItems = items.slice(0, options.limit);
    const last = pageItems.at(-1);
    return items.length > options.limit && last !== undefined
      ? {
          items: pageItems,
          nextCursor: encodeOpaqueCursor({
            block: last.createdBlock.toString(),
            market: last.market,
          }),
        }
      : { items: pageItems };
  }

  async listListings(
    chainId: number,
    options: QueryOptions & {
      vault?: Address | undefined;
      active?: boolean | undefined;
    },
  ): Promise<QueryPage<ListingView>> {
    return queryPage(
      [...this.listings.values()]
        .filter((listing) => listing.chainId === chainId)
        .filter(
          (listing) =>
            options.vault === undefined ||
            listing.vault === getAddress(options.vault),
        )
        .filter(
          (listing) =>
            options.active === undefined || listing.active === options.active,
        )
        .sort((a, b) => compareBigintDesc(a.updatedBlock, b.updatedBlock)),
      options,
    );
  }

  async listFills(
    chainId: number,
    options: QueryOptions & {
      vault?: Address | undefined;
      listingId?: Hex | undefined;
    },
  ): Promise<QueryPage<FillView>> {
    return queryPage(
      [...this.fills.values()]
        .filter((fill) => fill.chainId === chainId)
        .filter(
          (fill) =>
            options.listingId === undefined ||
            fill.listingId === options.listingId,
        )
        .filter((fill) => {
          if (options.vault === undefined) return true;
          return (
            this.listings.get(hexKey(chainId, fill.listingId))?.vault ===
            getAddress(options.vault)
          );
        })
        .sort((a, b) => compareBigintDesc(a.blockNumber, b.blockNumber)),
      options,
    );
  }

  async listPositions(
    chainId: number,
    owner: Address,
    options: QueryOptions & { vault?: Address | undefined },
  ): Promise<QueryPage<PositionView>> {
    const normalizedOwner = getAddress(owner);
    return queryPage(
      [...this.positions.values()]
        .filter(
          (position) =>
            position.chainId === chainId && position.owner === normalizedOwner,
        )
        .filter((position) => position.balance > 0n)
        .filter(
          (position) =>
            options.vault === undefined ||
            position.vault === getAddress(options.vault),
        )
        .sort((a, b) => compareBigintDesc(a.updatedBlock, b.updatedBlock))
        .map((position) => ({
          ...position,
          ...positionMarketSnapshot(
            this.markets.get(addressKey(position.chainId, position.vault)),
          ),
        })),
      options,
    );
  }

  async listClaims(
    chainId: number,
    owner: Address,
    options: QueryOptions & { vault?: Address | undefined },
  ): Promise<QueryPage<ClaimView>> {
    const normalizedOwner = getAddress(owner);
    return queryPage(
      [...this.claims.values()]
        .filter(
          (claim) =>
            claim.chainId === chainId && claim.owner === normalizedOwner,
        )
        .filter(
          (claim) =>
            options.vault === undefined ||
            claim.vault === getAddress(options.vault),
        )
        .sort((a, b) => compareBigintDesc(a.blockNumber, b.blockNumber)),
      options,
    );
  }

  async listActivity(
    chainId: number,
    owner: Address,
    options: QueryOptions,
  ): Promise<QueryPage<ActivityView>> {
    validateLimit(options.limit);
    const normalizedOwner = getAddress(owner);
    const cursor =
      options.cursor === undefined ? undefined : activityCursor(options.cursor);
    const items = [...this.activities.entries()]
      .filter(
        ([key, activity]) =>
          activity.chainId === chainId &&
          this.activityParticipants.get(key)?.has(normalizedOwner) === true,
      )
      .map(([, activity]) => activity)
      .filter(
        (activity) =>
          cursor === undefined || compareActivityToCursor(activity, cursor) > 0,
      )
      .sort(compareActivitiesDesc);
    const pageItems = items.slice(0, options.limit);
    const last = pageItems.at(-1);
    return items.length > options.limit && last !== undefined
      ? {
          items: pageItems,
          nextCursor: encodeOpaqueCursor({
            block: last.blockNumber.toString(),
            transactionHash: last.transactionHash,
            logIndex: last.logIndex,
          }),
        }
      : { items: pageItems };
  }

  eventCount(chainId: number): number {
    return [...this.events.values()].filter(
      (event) => event.chainId === chainId,
    ).length;
  }

  blockCount(chainId: number): number {
    return [...this.blocks.values()].filter(
      (block) => block.chainId === chainId,
    ).length;
  }

  private project(event: IndexedEvent): void {
    for (const mutation of deriveMutations(event))
      this.applyMutation(event, mutation);
  }

  private applyMutation(event: IndexedEvent, mutation: DerivedMutation): void {
    switch (mutation.kind) {
      case "market-created": {
        const key = addressKey(event.chainId, mutation.market);
        this.registered.set(key, mutation.market);
        if (!this.markets.has(key)) {
          this.markets.set(key, {
            chainId: event.chainId,
            market: mutation.market,
            creator: mutation.creator,
            deploymentMode: mutation.deploymentMode,
            outcomeCount: null,
            closeAt: null,
            resolutionWindow: null,
            rulesHash: null,
            metadataUri: null,
            resolutionSourceHash: null,
            resolutionSourceUri: null,
            earlyBirdStart: null,
            creatorTreasury: null,
            featureFlags: null,
            marketPrimaryCap: null,
            primaryFilledUnits: 0n,
            primaryPayment: 0n,
            creatorBond: mutation.creatorBond,
            state: 0,
            winningOutcome: null,
            evidenceHash: null,
            evidenceUri: null,
            createdBlock: event.blockNumber,
            updatedBlock: event.blockNumber,
            confirmationStatus: event.confirmationStatus,
          });
        }
        this.recordActivity(event, {
          kind: "market-created",
          vault: mutation.market,
          actor: mutation.creator,
          amount: mutation.creatorBond,
        });
        return;
      }
      case "market-initialized": {
        const key = addressKey(event.chainId, mutation.market);
        const current = this.markets.get(key);
        this.markets.set(key, {
          chainId: event.chainId,
          market: mutation.market,
          creator: mutation.creator,
          deploymentMode: mutation.deploymentMode,
          outcomeCount: mutation.outcomeCount,
          closeAt: mutation.closeAt,
          resolutionWindow: mutation.resolutionWindow,
          rulesHash: current?.rulesHash ?? null,
          metadataUri: current?.metadataUri ?? null,
          resolutionSourceHash: current?.resolutionSourceHash ?? null,
          resolutionSourceUri: current?.resolutionSourceUri ?? null,
          earlyBirdStart: current?.earlyBirdStart ?? null,
          creatorTreasury: current?.creatorTreasury ?? null,
          featureFlags: current?.featureFlags ?? null,
          marketPrimaryCap: mutation.marketPrimaryCap,
          primaryFilledUnits: current?.primaryFilledUnits ?? 0n,
          primaryPayment: current?.primaryPayment ?? 0n,
          creatorBond: mutation.creatorBond,
          state: current?.state ?? 0,
          winningOutcome: current?.winningOutcome ?? null,
          evidenceHash: current?.evidenceHash ?? null,
          evidenceUri: current?.evidenceUri ?? null,
          createdBlock: current?.createdBlock ?? event.blockNumber,
          updatedBlock: event.blockNumber,
          confirmationStatus: event.confirmationStatus,
        });
        return;
      }
      case "market-metadata": {
        const key = addressKey(event.chainId, mutation.market);
        const current = this.markets.get(key);
        if (current === undefined)
          throw new Error(
            `metadata event references unknown market ${mutation.market}`,
          );
        this.markets.set(key, {
          ...current,
          rulesHash: mutation.rulesHash,
          metadataUri: mutation.metadataUri,
          resolutionSourceHash: mutation.resolutionSourceHash,
          resolutionSourceUri: mutation.resolutionSourceUri,
          closeAt: mutation.closeAt,
          earlyBirdStart: mutation.earlyBirdStart,
          creatorTreasury: mutation.creatorTreasury,
          featureFlags: mutation.featureFlags,
          updatedBlock: event.blockNumber,
          confirmationStatus: event.confirmationStatus,
        });
        return;
      }
      case "primary-purchased": {
        const key = addressKey(event.chainId, mutation.market);
        const current = this.markets.get(key);
        if (current === undefined)
          throw new Error(
            `purchase event references unknown market ${mutation.market}`,
          );
        this.markets.set(key, {
          ...current,
          primaryFilledUnits: current.primaryFilledUnits + mutation.filledUnits,
          primaryPayment: mutation.totalPrincipal,
          updatedBlock: event.blockNumber,
          confirmationStatus: event.confirmationStatus,
        });
        this.recordActivity(event, {
          kind: "primary-purchased",
          vault: mutation.market,
          actor: mutation.buyer,
          outcomeId: mutation.outcomeId,
          units: mutation.filledUnits,
          amount: mutation.payment,
        });
        return;
      }
      case "market-terminal": {
        const key = addressKey(event.chainId, mutation.market);
        const current = this.markets.get(key);
        if (current === undefined)
          throw new Error(
            `terminal event references unknown market ${mutation.market}`,
          );
        this.markets.set(key, {
          ...current,
          state: mutation.state,
          winningOutcome: mutation.winningOutcome,
          evidenceHash: mutation.evidenceHash,
          evidenceUri:
            mutation.evidenceHash === null
              ? null
              : evidenceUriFromHash(mutation.evidenceHash),
          updatedBlock: event.blockNumber,
          confirmationStatus: event.confirmationStatus,
        });
        const participants = [
          current.creator,
          ...[...this.positions.values()]
            .filter(
              (position) =>
                position.chainId === event.chainId &&
                position.vault === mutation.market &&
                position.balance > 0n,
            )
            .map((position) => position.owner),
        ];
        this.recordActivity(
          event,
          {
            kind: terminalActivityKind(mutation.terminalKind),
            vault: mutation.market,
            actor: mutation.caller,
          },
          participants,
        );
        return;
      }
      case "listing-created":
        this.listings.set(hexKey(event.chainId, mutation.listingId), {
          chainId: event.chainId,
          listingId: mutation.listingId,
          vault: mutation.vault,
          seller: mutation.seller,
          outcomeId: mutation.outcomeId,
          remainingUnits: mutation.amount,
          unitPrice: mutation.unitPrice,
          expiresAt: mutation.expiresAt,
          active: true,
          createdBlock: event.blockNumber,
          updatedBlock: event.blockNumber,
          confirmationStatus: event.confirmationStatus,
        });
        this.recordActivity(event, {
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
        const key = hexKey(event.chainId, mutation.listingId);
        const listing = this.listings.get(key);
        if (listing === undefined)
          throw new Error(
            `fill references unknown listing ${mutation.listingId}`,
          );
        this.listings.set(key, {
          ...listing,
          remainingUnits: mutation.remainingUnits,
          active: mutation.remainingUnits !== 0n,
          updatedBlock: event.blockNumber,
          confirmationStatus: event.confirmationStatus,
        });
        this.fills.set(eventKey(event), {
          chainId: event.chainId,
          transactionHash: event.transactionHash,
          logIndex: event.logIndex,
          listingId: mutation.listingId,
          vault: listing.vault,
          buyer: mutation.buyer,
          seller: mutation.seller,
          filledUnits: mutation.filledUnits,
          gross: mutation.gross,
          blockNumber: event.blockNumber,
          confirmationStatus: event.confirmationStatus,
        });
        this.recordActivity(event, {
          kind: "listing-filled",
          vault: listing.vault,
          actor: mutation.buyer,
          counterparty: mutation.seller,
          outcomeId: listing.outcomeId,
          listingId: mutation.listingId,
          units: mutation.filledUnits,
          amount: mutation.gross,
        });
        return;
      }
      case "listing-closed": {
        const key = hexKey(event.chainId, mutation.listingId);
        const listing = this.listings.get(key);
        if (listing === undefined)
          throw new Error(
            `close references unknown listing ${mutation.listingId}`,
          );
        this.listings.set(key, {
          ...listing,
          remainingUnits: 0n,
          active: false,
          updatedBlock: event.blockNumber,
          confirmationStatus: event.confirmationStatus,
        });
        this.recordActivity(event, {
          kind: mutation.closeKind,
          vault: listing.vault,
          actor: mutation.caller,
          counterparty:
            mutation.caller === mutation.seller ? null : mutation.seller,
          outcomeId: listing.outcomeId,
          listingId: mutation.listingId,
        });
        return;
      }
      case "position-delta": {
        const key = positionKey(
          event.chainId,
          mutation.vault,
          mutation.owner,
          mutation.outcomeId,
        );
        const current = this.positions.get(key);
        const balance = (current?.balance ?? 0n) + mutation.delta;
        if (balance < 0n)
          throw new Error("position projection would become negative");
        this.positions.set(key, {
          chainId: event.chainId,
          vault: mutation.vault,
          owner: mutation.owner,
          outcomeId: mutation.outcomeId,
          balance,
          updatedBlock: event.blockNumber,
          confirmationStatus: event.confirmationStatus,
          ...positionMarketSnapshot(undefined),
        });
        return;
      }
      case "claim":
        this.claims.set(eventKey(event), {
          chainId: event.chainId,
          transactionHash: event.transactionHash,
          logIndex: event.logIndex,
          vault: mutation.vault,
          owner: mutation.owner,
          caller: mutation.caller,
          claimKind: mutation.claimKind,
          units: mutation.units,
          amount: mutation.amount,
          blockNumber: event.blockNumber,
          confirmationStatus: event.confirmationStatus,
        });
        this.recordActivity(event, {
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

  private recordActivity(
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
  ): void {
    const key = eventKey(event);
    const activity: ActivityView = {
      chainId: event.chainId,
      transactionHash: event.transactionHash,
      logIndex: event.logIndex,
      kind: input.kind,
      vault: input.vault,
      actor: input.actor,
      counterparty: input.counterparty ?? null,
      outcomeId: input.outcomeId ?? null,
      listingId: input.listingId ?? null,
      units: input.units ?? null,
      amount: input.amount ?? null,
      blockNumber: event.blockNumber,
      confirmationStatus: event.confirmationStatus,
    };
    this.activities.set(key, activity);
    this.activityParticipants.set(
      key,
      new Set(
        [activity.actor, activity.counterparty, ...extraParticipants]
          .filter((participant): participant is Address => participant !== null)
          .map(getAddress),
      ),
    );
  }

  private clearProjections(chainId: number): void {
    for (const map of [
      this.registered,
      this.markets,
      this.listings,
      this.fills,
      this.positions,
      this.claims,
      this.activities,
    ]) {
      for (const key of map.keys())
        if (key.startsWith(`${chainId}:`)) map.delete(key);
    }
    for (const key of this.activityParticipants.keys())
      if (key.startsWith(`${chainId}:`)) this.activityParticipants.delete(key);
  }
}

function queryPage<T>(
  items: readonly T[],
  options: QueryOptions,
): QueryPage<T> {
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
    String(offset) !== (options.cursor ?? "0")
  ) {
    throw new RangeError("invalid cursor");
  }
  const pageItems = items.slice(offset, offset + options.limit);
  return offset + options.limit < items.length
    ? { items: pageItems, nextCursor: String(offset + options.limit) }
    : { items: pageItems };
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

function compareMarketsDesc(a: MarketView, b: MarketView): number {
  if (a.createdBlock !== b.createdBlock)
    return compareBigintDesc(a.createdBlock, b.createdBlock);
  return b.market.toLowerCase().localeCompare(a.market.toLowerCase());
}

function compareActivitiesDesc(a: ActivityView, b: ActivityView): number {
  if (a.blockNumber !== b.blockNumber)
    return compareBigintDesc(a.blockNumber, b.blockNumber);
  const tx = b.transactionHash
    .toLowerCase()
    .localeCompare(a.transactionHash.toLowerCase());
  return tx === 0 ? b.logIndex - a.logIndex : tx;
}

function compareActivityToCursor(
  activity: ActivityView,
  cursor: ActivityCursor,
): number {
  if (activity.blockNumber !== cursor.block)
    return activity.blockNumber < cursor.block ? 1 : -1;
  const tx = activity.transactionHash
    .toLowerCase()
    .localeCompare(cursor.transactionHash.toLowerCase());
  if (tx !== 0) return tx < 0 ? 1 : -1;
  if (activity.logIndex === cursor.logIndex) return 0;
  return activity.logIndex < cursor.logIndex ? 1 : -1;
}

function terminalActivityKind(
  value: "resolved" | "voided-creator" | "voided-timeout",
): ActivityKind {
  switch (value) {
    case "resolved":
      return "market-resolved";
    case "voided-creator":
      return "market-voided-creator";
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

function blockKey(chainId: number, blockNumber: bigint): string {
  return `${chainId}:${blockNumber.toString()}`;
}

function addressKey(chainId: number, address: Address): string {
  return `${chainId}:${getAddress(address)}`;
}

function hexKey(chainId: number, value: Hex): string {
  return `${chainId}:${value.toLowerCase()}`;
}

function eventKey(event: IndexedEvent): string {
  return `${event.chainId}:${event.transactionHash.toLowerCase()}:${event.logIndex}`;
}

function positionKey(
  chainId: number,
  vault: Address,
  owner: Address,
  outcomeId: bigint,
): string {
  return `${chainId}:${getAddress(vault)}:${getAddress(owner)}:${outcomeId.toString()}`;
}

function compareEvents(a: IndexedEvent, b: IndexedEvent): number {
  if (a.blockNumber !== b.blockNumber)
    return a.blockNumber < b.blockNumber ? -1 : 1;
  if (a.transactionIndex !== b.transactionIndex)
    return a.transactionIndex - b.transactionIndex;
  return a.logIndex - b.logIndex;
}

function compareBigintDesc(a: bigint, b: bigint): number {
  return a === b ? 0 : a > b ? -1 : 1;
}
