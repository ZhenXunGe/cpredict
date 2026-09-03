import { getAddress, type Address, type Hex, type Log } from "viem";

export type ConfirmationStatus = "provisional" | "confirmed";

export interface IndexedEvent {
  chainId: number;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  confirmationStatus: ConfirmationStatus;
}

export interface CanonicalBlock {
  chainId: number;
  blockNumber: bigint;
  blockHash: Hex;
  parentHash: Hex;
  timestamp: bigint;
  confirmationStatus: ConfirmationStatus;
}

export interface ChainCheckpoint {
  chainId: number;
  blockNumber: bigint;
  blockHash: Hex;
}

export interface IndexerSyncStatus {
  chainId: number;
  indexedBlock: bigint | null;
  safeBlock: bigint;
}

export interface MarketView {
  chainId: number;
  market: Address;
  creator: Address;
  deploymentMode: number;
  outcomeCount: number | null;
  closeAt: bigint | null;
  resolutionWindow: bigint | null;
  rulesHash: Hex | null;
  metadataUri: string | null;
  resolutionSourceHash: Hex | null;
  resolutionSourceUri: string | null;
  earlyBirdStart: bigint | null;
  creatorTreasury: Address | null;
  featureFlags: bigint | null;
  marketPrimaryCap: bigint | null;
  primaryFilledUnits: bigint;
  primaryPayment: bigint;
  creatorBond: bigint;
  state: number;
  winningOutcome: bigint | null;
  evidenceHash: Hex | null;
  evidenceUri: `ipfs://${string}` | null;
  createdBlock: bigint;
  updatedBlock: bigint;
  confirmationStatus: ConfirmationStatus;
}

export interface ListingView {
  chainId: number;
  listingId: Hex;
  vault: Address;
  seller: Address;
  outcomeId: bigint;
  remainingUnits: bigint;
  unitPrice: bigint;
  expiresAt: bigint;
  active: boolean;
  createdBlock: bigint;
  updatedBlock: bigint;
  confirmationStatus: ConfirmationStatus;
}

export interface FillView {
  chainId: number;
  transactionHash: Hex;
  logIndex: number;
  listingId: Hex;
  vault: Address;
  buyer: Address;
  seller: Address;
  filledUnits: bigint;
  gross: bigint;
  blockNumber: bigint;
  confirmationStatus: ConfirmationStatus;
}

export interface PositionView {
  chainId: number;
  vault: Address;
  owner: Address;
  outcomeId: bigint;
  balance: bigint;
  updatedBlock: bigint;
  confirmationStatus: ConfirmationStatus;
  marketState: number | null;
  winningOutcome: bigint | null;
}

export function positionMarketSnapshot(
  market: Pick<MarketView, "state" | "winningOutcome"> | undefined,
): Pick<PositionView, "marketState" | "winningOutcome"> {
  return {
    marketState: market?.state ?? null,
    winningOutcome: market?.winningOutcome ?? null,
  };
}

export interface ClaimView {
  chainId: number;
  transactionHash: Hex;
  logIndex: number;
  vault: Address;
  owner: Address;
  caller: Address;
  claimKind: string;
  units: bigint;
  amount: bigint;
  blockNumber: bigint;
  confirmationStatus: ConfirmationStatus;
}

export type MarketStatus =
  "open" | "resolved" | "voided-creator" | "voided-timeout";

export interface MarketCatalogOptions {
  limit: number;
  cursor?: string | undefined;
  status?: MarketStatus | undefined;
  owner?: Address | undefined;
}

export type ActivityKind =
  | "market-created"
  | "primary-purchased"
  | "listing-created"
  | "listing-filled"
  | "listing-cancelled"
  | "terminal-listing-returned"
  | "market-resolved"
  | "market-voided-creator"
  | "market-voided-timeout"
  | "winner-claimed"
  | "early-bird-claimed"
  | "principal-refunded"
  | "timeout-bonus-claimed";

export interface ActivityView {
  chainId: number;
  transactionHash: Hex;
  logIndex: number;
  kind: ActivityKind;
  vault: Address;
  actor: Address | null;
  counterparty: Address | null;
  outcomeId: bigint | null;
  listingId: Hex | null;
  units: bigint | null;
  amount: bigint | null;
  blockNumber: bigint;
  confirmationStatus: ConfirmationStatus;
}

export interface QueryPage<T> {
  items: readonly T[];
  nextCursor?: string;
}

export interface QueryOptions {
  limit: number;
  cursor?: string | undefined;
}

export interface EventStore {
  checkpoint(chainId: number): Promise<ChainCheckpoint | undefined>;
  canonicalBlock(
    chainId: number,
    blockNumber: bigint,
  ): Promise<CanonicalBlock | undefined>;
  registeredMarkets(chainId: number): Promise<readonly Address[]>;
  applyBatch(
    events: readonly IndexedEvent[],
    blocks: readonly CanonicalBlock[],
    checkpoint: ChainCheckpoint,
  ): Promise<void>;
  /** `blockNumber=undefined` removes the entire indexed chain. */
  rollbackAfter(
    chainId: number,
    blockNumber: bigint | undefined,
  ): Promise<void>;
}

export interface IndexerQueryStore {
  listMarkets(
    chainId: number,
    options: QueryOptions,
  ): Promise<QueryPage<MarketView>>;
  market(chainId: number, market: Address): Promise<MarketView | undefined>;
  listMarketCatalog(
    chainId: number,
    options: MarketCatalogOptions,
  ): Promise<QueryPage<MarketView>>;
  listListings(
    chainId: number,
    options: QueryOptions & {
      vault?: Address | undefined;
      active?: boolean | undefined;
    },
  ): Promise<QueryPage<ListingView>>;
  listFills(
    chainId: number,
    options: QueryOptions & {
      vault?: Address | undefined;
      listingId?: Hex | undefined;
    },
  ): Promise<QueryPage<FillView>>;
  listPositions(
    chainId: number,
    owner: Address,
    options: QueryOptions & { vault?: Address | undefined },
  ): Promise<QueryPage<PositionView>>;
  listClaims(
    chainId: number,
    owner: Address,
    options: QueryOptions & { vault?: Address | undefined },
  ): Promise<QueryPage<ClaimView>>;
  listActivity(
    chainId: number,
    owner: Address,
    options: QueryOptions,
  ): Promise<QueryPage<ActivityView>>;
}

export function marketState(status: MarketStatus): number {
  switch (status) {
    case "open":
      return 0;
    case "resolved":
      return 1;
    case "voided-creator":
      return 2;
    case "voided-timeout":
      return 3;
  }
}

export function marketStatus(state: number): MarketStatus {
  switch (state) {
    case 0:
      return "open";
    case 1:
      return "resolved";
    case 2:
      return "voided-creator";
    case 3:
      return "voided-timeout";
    default:
      throw new RangeError(`unknown market state ${state}`);
  }
}

export function encodeOpaqueCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeOpaqueCursor<T>(value: string): T {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(value))
    throw new RangeError("invalid cursor");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new RangeError("invalid cursor");
  }
  return parsed as T;
}

export function normalizeLog(
  chainId: number,
  log: Log,
  confirmationStatus: ConfirmationStatus,
): IndexedEvent {
  if (
    log.blockNumber === null ||
    log.blockHash === null ||
    log.transactionHash === null ||
    log.transactionIndex === null ||
    log.logIndex === null
  ) {
    throw new Error("indexer received a pending or incomplete log");
  }
  return {
    chainId,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    address: getAddress(log.address),
    topics: log.topics,
    data: log.data,
    confirmationStatus,
  };
}
