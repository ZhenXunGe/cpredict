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

export interface MarketView {
  chainId: number;
  market: Address;
  creator: Address;
  deploymentMode: number;
  outcomeCount: number | null;
  closeAt: bigint | null;
  marketPrimaryCap: bigint | null;
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
