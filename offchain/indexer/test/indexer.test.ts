import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbiItem,
  toHex,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { ChainIndexer } from "../src/indexer.js";
import { MemoryEventStore } from "../src/memory-store.js";
import { normalizeLog } from "../src/store.js";
import {
  evidenceUriFromHash,
  ZERO_EVIDENCE_HASH,
} from "../../sdk/src/evidence.js";

const CHAIN_ID = 31_337;
const FACTORY = getAddress("0x000000000000000000000000000000000000F001");
const MARKETPLACE = getAddress("0x000000000000000000000000000000000000F002");
const CREATOR = getAddress("0x000000000000000000000000000000000000C001");
const ALICE = getAddress("0x000000000000000000000000000000000000A001");
const MARKET_A = getAddress("0x0000000000000000000000000000000000001001");
const MARKET_B = getAddress("0x0000000000000000000000000000000000001002");
const ZERO = getAddress("0x0000000000000000000000000000000000000000");

const marketCreatedEvent = parseAbiItem(
  "event MarketCreated(address indexed market,address indexed creator,uint8 indexed deploymentMode,address implementation,bytes32 salt,bytes32 runtimeCodeHash,uint256 creatorNonce,uint256 creationFee,uint256 creatorBond)",
);
const marketInitializedEvent = parseAbiItem(
  "event MarketInitialized(address indexed market,address indexed creator,uint8 indexed mode,uint8 outcomeCount,uint64 closeAt,uint64 resolutionWindow,uint128 marketPrimaryCap,uint128 creatorBond)",
);
const marketMetadataUpdatedEvent = parseAbiItem(
  "event MarketMetadataUpdated(bytes32 indexed rulesHash,string metadataURI,bytes32 indexed resolutionSourceHash,string resolutionSourceURI,uint64 closeAt,uint64 earlyBirdStart,address indexed creatorTreasury,uint256 featureFlags)",
);
const primaryPurchasedEvent = parseAbiItem(
  "event PrimaryPurchased(address indexed buyer,uint256 indexed outcomeId,uint256 desiredUnits,uint256 filledUnits,uint256 payment,uint8 earlyBirdWeight,uint256 cumulativeUserPrimary,uint256 totalPrincipal)",
);
const transferSingleEvent = parseAbiItem(
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
);
const listingCreatedEvent = parseAbiItem(
  "event ListingCreated(bytes32 indexed listingId,address indexed vault,address indexed seller,uint256 outcomeId,uint256 amount,uint256 unitPrice,uint64 expiresAt,uint256 sellerNonce)",
);
const listingFilledEvent = parseAbiItem(
  "event ListingFilled(bytes32 indexed listingId,address indexed buyer,address indexed seller,uint256 desiredUnits,uint256 filledUnits,uint256 gross,uint256 sellerProceeds,uint256 platformFee,uint256 creatorFee,uint256 remainingUnits)",
);
const winnerClaimedEvent = parseAbiItem(
  "event WinnerClaimed(address indexed owner,address indexed caller,uint256 burnedUnits,uint256 payout)",
);
const marketResolvedEvent = parseAbiItem(
  "event MarketResolved(uint256 indexed winningOutcome,uint256 totalPrincipal,uint256 totalRake,uint256 protocolFee,uint256 creatorFee,uint256 earlyBirdPool,uint256 winnerPool,bytes32 indexed evidenceHash)",
);
const marketVoidedEvent = parseAbiItem(
  "event MarketVoided(uint8 indexed terminalState,address indexed caller,uint256 refundPrincipal,bytes32 indexed evidenceHash)",
);
const LISTING_ID = hash(700n);
const EVIDENCE_HASH = hash(701n);

describe("ChainIndexer canonical ingestion", () => {
  it("normalizes RPC contract addresses before projection and filtering", () => {
    const log = transferLog(2n, MARKET_A, ZERO, ALICE, 0n, 10n);
    const normalized = normalizeLog(
      CHAIN_ID,
      { ...log, address: MARKET_A.toLowerCase() as Address } as Log,
      "provisional",
    );

    expect(normalized.address).toBe(MARKET_A);
  });

  it("persists eventless blocks, discovers a market, and deduplicates discovery logs", async () => {
    const client = new FakeClient(4n, [
      marketCreatedLog(2n, MARKET_A),
      marketInitializedLog(2n, MARKET_A),
    ]);
    const store = new MemoryEventStore();
    const indexer = createIndexer(client, store);

    const result = await indexer.runBatch();

    expect(result).toMatchObject({
      blockCount: 4,
      eventCount: 2,
      discoveredMarkets: 1,
    });
    expect(store.blockCount(CHAIN_ID)).toBe(4);
    expect(store.eventCount(CHAIN_ID)).toBe(2);
    expect(await store.canonicalBlock(CHAIN_ID, 3n)).toMatchObject({
      blockNumber: 3n,
    });
    expect(await store.registeredMarkets(CHAIN_ID)).toEqual([MARKET_A]);
    expect(await store.market(CHAIN_ID, MARKET_A)).toMatchObject({
      outcomeCount: 2,
      closeAt: 1_000n,
    });
  });

  it("bounds canonical block RPC concurrency for public providers", async () => {
    const client = new FakeClient(12n, [], 2);
    await createIndexer(client, new MemoryEventStore()).runBatch();
    expect(client.maximumBlockConcurrency).toBeGreaterThan(1);
    expect(client.maximumBlockConcurrency).toBeLessThanOrEqual(4);
  });

  it("removes a one-block orphan and replays the replacement without duplicate rows", async () => {
    const client = new FakeClient(4n, [
      marketCreatedLog(4n, MARKET_A),
      marketInitializedLog(4n, MARKET_A),
    ]);
    const store = new MemoryEventStore();
    const indexer = createIndexer(client, store);
    await indexer.runBatch();

    client.replaceFrom(4n, [
      marketCreatedLog(4n, MARKET_B),
      marketInitializedLog(4n, MARKET_B),
    ]);
    const replay = await indexer.runBatch();

    expect(replay).toMatchObject({ fromBlock: 4n, toBlock: 4n, eventCount: 2 });
    expect(await store.registeredMarkets(CHAIN_ID)).toEqual([MARKET_B]);
    expect(await store.market(CHAIN_ID, MARKET_A)).toBeUndefined();
    expect(store.eventCount(CHAIN_ID)).toBe(2);
  });

  it("finds the common ancestor across a multi-block reorg with an eventless ancestor", async () => {
    const client = new FakeClient(6n, [
      marketCreatedLog(2n, MARKET_A),
      marketInitializedLog(2n, MARKET_A),
      transferLog(5n, MARKET_A, ZERO, ALICE, 0n, 10n),
    ]);
    const store = new MemoryEventStore();
    const indexer = createIndexer(client, store);
    await indexer.runBatch();
    expect(
      (await store.listPositions(CHAIN_ID, ALICE, { limit: 10 })).items[0]
        ?.balance,
    ).toBe(10n);

    // Blocks 4-6 are replaced; block 3 is the common ancestor and contains no event.
    client.replaceFrom(4n, [transferLog(6n, MARKET_A, ZERO, ALICE, 1n, 7n)]);
    const replay = await indexer.runBatch();

    expect(replay).toMatchObject({ fromBlock: 4n, toBlock: 6n });
    const positions = (
      await store.listPositions(CHAIN_ID, ALICE, { limit: 10 })
    ).items;
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ outcomeId: 1n, balance: 7n });
    expect(await store.checkpoint(CHAIN_ID)).toMatchObject({ blockNumber: 6n });
    expect(store.blockCount(CHAIN_ID)).toBe(6);
  });

  it("is idempotent when the store receives duplicate raw logs", async () => {
    const store = new MemoryEventStore();
    const client = new FakeClient(2n, [
      marketCreatedLog(2n, MARKET_A),
      marketInitializedLog(2n, MARKET_A),
    ]);
    const indexer = createIndexer(client, store);
    await indexer.runBatch();
    const checkpoint = await store.checkpoint(CHAIN_ID);
    const block = await store.canonicalBlock(CHAIN_ID, 2n);
    expect(checkpoint).toBeDefined();
    expect(block).toBeDefined();
    if (checkpoint === undefined || block === undefined)
      throw new Error("missing fixture state");
    const duplicate = normalizeFixture(marketCreatedLog(2n, MARKET_A));
    await store.applyBatch([duplicate, duplicate], [block], checkpoint);
    expect(store.eventCount(CHAIN_ID)).toBe(2);
    expect(await store.registeredMarkets(CHAIN_ID)).toEqual([MARKET_A]);
  });

  it("materializes listings, fills, positions, and claims for API queries", async () => {
    const client = new FakeClient(5n, [
      marketCreatedLog(1n, MARKET_A),
      marketInitializedLog(1n, MARKET_A),
      transferLog(2n, MARKET_A, ZERO, ALICE, 0n, 10n),
      listingCreatedLog(3n, MARKET_A),
      listingFilledLog(4n),
      winnerClaimedLog(5n, MARKET_A),
    ]);
    const store = new MemoryEventStore();
    await createIndexer(client, store).runBatch();

    expect(
      (await store.listListings(CHAIN_ID, { limit: 10 })).items[0],
    ).toMatchObject({
      listingId: LISTING_ID,
      remainingUnits: 5n,
      active: true,
    });
    expect(
      (await store.listFills(CHAIN_ID, { limit: 10 })).items[0],
    ).toMatchObject({
      listingId: LISTING_ID,
      vault: MARKET_A,
      filledUnits: 5n,
      gross: 4n,
    });
    expect(
      (await store.listPositions(CHAIN_ID, ALICE, { limit: 10 })).items[0],
    ).toMatchObject({
      balance: 10n,
    });
    expect(
      (await store.listClaims(CHAIN_ID, ALICE, { limit: 10 })).items[0],
    ).toMatchObject({
      claimKind: "winner",
      units: 10n,
      amount: 15n,
    });
  });

  it("materializes metadata, primary totals, catalog filters, and wallet activity", async () => {
    const rulesHash = hash(801n);
    const sourceHash = hash(802n);
    const client = new FakeClient(4n, [
      marketCreatedLog(1n, MARKET_A),
      marketInitializedLog(1n, MARKET_A),
      marketMetadataUpdatedLog(2n, MARKET_A, rulesHash, sourceHash),
      primaryPurchasedLog(3n, MARKET_A),
    ]);
    const store = new MemoryEventStore();
    await createIndexer(client, store).runBatch();

    expect(await store.market(CHAIN_ID, MARKET_A)).toMatchObject({
      resolutionWindow: 86_400n,
      rulesHash,
      metadataUri: "https://metadata.example/markets/{id}.json",
      resolutionSourceHash: sourceHash,
      resolutionSourceUri: "https://source.example/result",
      earlyBirdStart: 900n,
      creatorTreasury: CREATOR,
      featureFlags: 3n,
      primaryFilledUnits: 7n,
      primaryPayment: 7n,
    });

    expect(
      (await store.listMarketCatalog(CHAIN_ID, { limit: 10, owner: ALICE }))
        .items,
    ).toHaveLength(1);
    expect(
      (await store.listMarketCatalog(CHAIN_ID, { limit: 10, status: "open" }))
        .items,
    ).toHaveLength(1);
    expect(
      (await store.listMarketCatalog(CHAIN_ID, {
        limit: 10,
        status: "resolved",
      })).items,
    ).toHaveLength(0);

    expect(
      (await store.listActivity(CHAIN_ID, ALICE, { limit: 10 })).items[0],
    ).toMatchObject({
      kind: "primary-purchased",
      vault: MARKET_A,
      actor: ALICE,
      outcomeId: 1n,
      units: 7n,
      amount: 7n,
    });
  });

  it("uses stable keyset cursors for the market catalog", async () => {
    const client = new FakeClient(2n, [
      marketCreatedLog(1n, MARKET_A),
      marketInitializedLog(1n, MARKET_A),
      marketCreatedLog(2n, MARKET_B),
      marketInitializedLog(2n, MARKET_B),
    ]);
    const store = new MemoryEventStore();
    await createIndexer(client, store).runBatch();

    const first = await store.listMarketCatalog(CHAIN_ID, { limit: 1 });
    expect(first.items.map((market) => market.market)).toEqual([MARKET_B]);
    expect(first.nextCursor).toBeDefined();
    const second = await store.listMarketCatalog(CHAIN_ID, {
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((market) => market.market)).toEqual([MARKET_A]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("materializes deterministic evidence for resolve, creator void, and timeout void", async () => {
    const scenarios = [
      {
        terminal: marketResolvedLog(2n, MARKET_A, EVIDENCE_HASH),
        state: 1,
        winningOutcome: 1n,
        evidenceHash: EVIDENCE_HASH,
      },
      {
        terminal: marketVoidedLog(2n, MARKET_A, 2, EVIDENCE_HASH),
        state: 2,
        winningOutcome: null,
        evidenceHash: EVIDENCE_HASH,
      },
      {
        terminal: marketVoidedLog(2n, MARKET_A, 3, ZERO_EVIDENCE_HASH),
        state: 3,
        winningOutcome: null,
        evidenceHash: null,
      },
    ] as const;

    for (const scenario of scenarios) {
      const client = new FakeClient(2n, [
        marketCreatedLog(1n, MARKET_A),
        marketInitializedLog(1n, MARKET_A),
        scenario.terminal,
      ]);
      const store = new MemoryEventStore();
      await createIndexer(client, store).runBatch();
      expect(await store.market(CHAIN_ID, MARKET_A)).toMatchObject({
        state: scenario.state,
        winningOutcome: scenario.winningOutcome,
        evidenceHash: scenario.evidenceHash,
        evidenceUri:
          scenario.evidenceHash === null
            ? null
            : evidenceUriFromHash(scenario.evidenceHash),
      });
    }
  });
});

function createIndexer(
  client: FakeClient,
  store: MemoryEventStore,
): ChainIndexer {
  return new ChainIndexer(client as unknown as PublicClient, store, {
    chainId: CHAIN_ID,
    deploymentBlock: 1n,
    confirmations: 0n,
    batchSize: 100n,
    addresses: [FACTORY, MARKETPLACE],
    factoryAddress: FACTORY,
  });
}

class FakeClient {
  private readonly blocks = new Map<bigint, FakeBlock>();
  private logs: readonly Log[];
  private generation = 1n;
  private activeBlockRequests = 0;
  maximumBlockConcurrency = 0;

  constructor(
    private readonly head: bigint,
    logs: readonly Log[],
    private readonly blockDelayMs = 0,
  ) {
    this.logs = logs;
    this.buildBlocks(1n);
  }

  async getBlockNumber(): Promise<bigint> {
    return this.head;
  }

  async getBlock({ blockNumber }: { blockNumber: bigint }): Promise<FakeBlock> {
    this.activeBlockRequests += 1;
    this.maximumBlockConcurrency = Math.max(
      this.maximumBlockConcurrency,
      this.activeBlockRequests,
    );
    try {
      if (this.blockDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, this.blockDelayMs));
      const block = this.blocks.get(blockNumber);
      if (block === undefined)
        throw new Error(`missing fake block ${blockNumber.toString()}`);
      return block;
    } finally {
      this.activeBlockRequests -= 1;
    }
  }

  async getLogs(input: {
    address?: Address | readonly Address[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly Log[]> {
    const addresses =
      input.address === undefined
        ? undefined
        : new Set(
            (Array.isArray(input.address)
              ? input.address
              : [input.address]
            ).map((value) => value.toLowerCase()),
          );
    return this.logs.filter((log) => {
      const number = log.blockNumber;
      return (
        number !== null &&
        number >= input.fromBlock &&
        number <= input.toBlock &&
        (addresses === undefined || addresses.has(log.address.toLowerCase()))
      );
    });
  }

  replaceFrom(blockNumber: bigint, logs: readonly Log[]): void {
    this.generation += 1n;
    this.logs = logs;
    this.buildBlocks(blockNumber);
    this.logs = this.logs.map((log) =>
      withCanonicalBlock(log, this.block(log.blockNumber ?? 0n)),
    );
  }

  private buildBlocks(from: bigint): void {
    for (let number = from; number <= this.head; number += 1n) {
      const parent = number === 1n ? hash(0n) : this.block(number - 1n).hash;
      this.blocks.set(number, {
        hash: hash(this.generation * 1_000n + number),
        parentHash: parent,
        timestamp: number * 10n,
      });
    }
    this.logs = this.logs.map((log) =>
      withCanonicalBlock(log, this.block(log.blockNumber ?? 0n)),
    );
  }

  private block(number: bigint): FakeBlock {
    const block = this.blocks.get(number);
    if (block === undefined) throw new Error("missing fake block");
    return block;
  }
}

interface FakeBlock {
  hash: Hex;
  parentHash: Hex;
  timestamp: bigint;
}

function marketCreatedLog(blockNumber: bigint, market: Address): Log {
  return fixtureLog(
    FACTORY,
    blockNumber,
    0,
    encodeEventTopics({
      abi: [marketCreatedEvent],
      eventName: "MarketCreated",
      args: { market, creator: CREATOR, deploymentMode: 0 },
    }) as unknown as readonly Hex[],
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [ZERO, hash(91n), hash(92n), 0n, 0n, 10_000_000n],
    ),
  );
}

function marketInitializedLog(blockNumber: bigint, market: Address): Log {
  return fixtureLog(
    market,
    blockNumber,
    1,
    encodeEventTopics({
      abi: [marketInitializedEvent],
      eventName: "MarketInitialized",
      args: { market, creator: CREATOR, mode: 0 },
    }) as unknown as readonly Hex[],
    encodeAbiParameters(
      [
        { type: "uint8" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint128" },
        { type: "uint128" },
      ],
      [2, 1_000n, 86_400n, 500_000_000n, 10_000_000n],
    ),
  );
}

function marketMetadataUpdatedLog(
  blockNumber: bigint,
  market: Address,
  rulesHash: Hex,
  sourceHash: Hex,
): Log {
  return fixtureLog(
    market,
    blockNumber,
    7,
    encodeEventTopics({
      abi: [marketMetadataUpdatedEvent],
      eventName: "MarketMetadataUpdated",
      args: {
        rulesHash,
        resolutionSourceHash: sourceHash,
        creatorTreasury: CREATOR,
      },
    }) as unknown as readonly Hex[],
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "string" },
        { type: "uint64" },
        { type: "uint64" },
        { type: "uint256" },
      ],
      [
        "https://metadata.example/markets/{id}.json",
        "https://source.example/result",
        1_000n,
        900n,
        3n,
      ],
    ),
  );
}

function primaryPurchasedLog(blockNumber: bigint, market: Address): Log {
  return fixtureLog(
    market,
    blockNumber,
    8,
    encodeEventTopics({
      abi: [primaryPurchasedEvent],
      eventName: "PrimaryPurchased",
      args: { buyer: ALICE, outcomeId: 1n },
    }) as unknown as readonly Hex[],
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint8" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [10n, 7n, 7n, 3, 7n, 7n],
    ),
  );
}

function transferLog(
  blockNumber: bigint,
  vault: Address,
  from: Address,
  to: Address,
  outcomeId: bigint,
  value: bigint,
): Log {
  return fixtureLog(
    vault,
    blockNumber,
    2,
    encodeEventTopics({
      abi: [transferSingleEvent],
      eventName: "TransferSingle",
      args: { operator: CREATOR, from, to },
    }) as unknown as readonly Hex[],
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [outcomeId, value],
    ),
  );
}

function listingCreatedLog(blockNumber: bigint, vault: Address): Log {
  return fixtureLog(
    MARKETPLACE,
    blockNumber,
    3,
    encodeEventTopics({
      abi: [listingCreatedEvent],
      eventName: "ListingCreated",
      args: { listingId: LISTING_ID, vault, seller: ALICE },
    }) as unknown as readonly Hex[],
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint64" },
        { type: "uint256" },
      ],
      [0n, 10n, 900_000n, 2_000n, 0n],
    ),
  );
}

function listingFilledLog(blockNumber: bigint): Log {
  return fixtureLog(
    MARKETPLACE,
    blockNumber,
    4,
    encodeEventTopics({
      abi: [listingFilledEvent],
      eventName: "ListingFilled",
      args: { listingId: LISTING_ID, buyer: CREATOR, seller: ALICE },
    }) as unknown as readonly Hex[],
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [5n, 5n, 4n, 4n, 0n, 0n, 5n],
    ),
  );
}

function winnerClaimedLog(blockNumber: bigint, vault: Address): Log {
  return fixtureLog(
    vault,
    blockNumber,
    5,
    encodeEventTopics({
      abi: [winnerClaimedEvent],
      eventName: "WinnerClaimed",
      args: { owner: ALICE, caller: CREATOR },
    }) as unknown as readonly Hex[],
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [10n, 15n]),
  );
}

function marketResolvedLog(
  blockNumber: bigint,
  vault: Address,
  evidenceHash: Hex,
): Log {
  return fixtureLog(
    vault,
    blockNumber,
    6,
    encodeEventTopics({
      abi: [marketResolvedEvent],
      eventName: "MarketResolved",
      args: { winningOutcome: 1n, evidenceHash },
    }) as unknown as readonly Hex[],
    encodeAbiParameters(
      Array.from({ length: 6 }, () => ({ type: "uint256" as const })),
      [100n, 10n, 2n, 3n, 1n, 90n],
    ),
  );
}

function marketVoidedLog(
  blockNumber: bigint,
  vault: Address,
  terminalState: number,
  evidenceHash: Hex,
): Log {
  return fixtureLog(
    vault,
    blockNumber,
    6,
    encodeEventTopics({
      abi: [marketVoidedEvent],
      eventName: "MarketVoided",
      args: { terminalState, caller: CREATOR, evidenceHash },
    }) as unknown as readonly Hex[],
    encodeAbiParameters([{ type: "uint256" }], [100n]),
  );
}

function fixtureLog(
  address: Address,
  blockNumber: bigint,
  logIndex: number,
  topics: readonly Hex[],
  data: Hex,
): Log {
  return {
    address,
    blockHash: hash(1_000n + blockNumber),
    blockNumber,
    data,
    logIndex,
    removed: false,
    topics,
    transactionHash: hash(blockNumber * 100n + BigInt(logIndex + 1)),
    transactionIndex: 0,
  } as Log;
}

function withCanonicalBlock(log: Log, block: FakeBlock): Log {
  return { ...log, blockHash: block.hash } as Log;
}

function normalizeFixture(log: Log) {
  if (
    log.blockNumber === null ||
    log.blockHash === null ||
    log.transactionHash === null ||
    log.transactionIndex === null ||
    log.logIndex === null
  )
    throw new Error("invalid fixture log");
  return {
    chainId: CHAIN_ID,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    address: log.address,
    topics: log.topics,
    data: log.data,
    confirmationStatus: "provisional" as const,
  };
}

function hash(value: bigint): Hex {
  return toHex(value, { size: 32 });
}
