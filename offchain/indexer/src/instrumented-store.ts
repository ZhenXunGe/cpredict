import type { Address, Hex } from "viem";
import type { IndexerDatabaseTelemetry } from "./telemetry.js";
import type {
  CanonicalBlock,
  ChainCheckpoint,
  ClaimView,
  EventStore,
  FillView,
  IndexedEvent,
  IndexerQueryStore,
  ListingView,
  MarketView,
  PositionView,
  QueryOptions,
  QueryPage,
} from "./store.js";

export interface CloseableEventQueryStore
  extends EventStore, IndexerQueryStore {
  ready(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Measures application database admission and operation latency without claiming visibility into
 * postgres.js internals. The admission limit is deliberately identical to the configured driver
 * connection limit, so queued/in-flight metrics describe the production store rather than a probe.
 */
export class InstrumentedEventQueryStore implements CloseableEventQueryStore {
  private readonly gate: AdmissionGate;

  constructor(
    private readonly delegate: CloseableEventQueryStore,
    maximumConcurrentOperations: number,
    private readonly telemetry: IndexerDatabaseTelemetry,
  ) {
    this.gate = new AdmissionGate(maximumConcurrentOperations, telemetry);
    telemetry.configuredConnections(maximumConcurrentOperations);
    telemetry.queued(0);
    telemetry.inFlight(0);
  }

  checkpoint(chainId: number): Promise<ChainCheckpoint | undefined> {
    return this.measure("checkpoint", () => this.delegate.checkpoint(chainId));
  }

  canonicalBlock(
    chainId: number,
    blockNumber: bigint,
  ): Promise<CanonicalBlock | undefined> {
    return this.measure("canonical_block", () =>
      this.delegate.canonicalBlock(chainId, blockNumber),
    );
  }

  registeredMarkets(chainId: number): Promise<readonly Address[]> {
    return this.measure("registered_markets", () =>
      this.delegate.registeredMarkets(chainId),
    );
  }

  applyBatch(
    events: readonly IndexedEvent[],
    blocks: readonly CanonicalBlock[],
    checkpoint: ChainCheckpoint,
  ): Promise<void> {
    return this.measure("apply_batch", () =>
      this.delegate.applyBatch(events, blocks, checkpoint),
    );
  }

  rollbackAfter(
    chainId: number,
    blockNumber: bigint | undefined,
  ): Promise<void> {
    return this.measure("rollback_after", () =>
      this.delegate.rollbackAfter(chainId, blockNumber),
    );
  }

  listMarkets(
    chainId: number,
    options: QueryOptions,
  ): Promise<QueryPage<MarketView>> {
    return this.measure("list_markets", () =>
      this.delegate.listMarkets(chainId, options),
    );
  }

  market(chainId: number, market: Address): Promise<MarketView | undefined> {
    return this.measure("market", () => this.delegate.market(chainId, market));
  }

  listListings(
    chainId: number,
    options: QueryOptions & {
      vault?: Address | undefined;
      active?: boolean | undefined;
    },
  ): Promise<QueryPage<ListingView>> {
    return this.measure("list_listings", () =>
      this.delegate.listListings(chainId, options),
    );
  }

  listFills(
    chainId: number,
    options: QueryOptions & {
      vault?: Address | undefined;
      listingId?: Hex | undefined;
    },
  ): Promise<QueryPage<FillView>> {
    return this.measure("list_fills", () =>
      this.delegate.listFills(chainId, options),
    );
  }

  listPositions(
    chainId: number,
    owner: Address,
    options: QueryOptions & { vault?: Address | undefined },
  ): Promise<QueryPage<PositionView>> {
    return this.measure("list_positions", () =>
      this.delegate.listPositions(chainId, owner, options),
    );
  }

  listClaims(
    chainId: number,
    owner: Address,
    options: QueryOptions & { vault?: Address | undefined },
  ): Promise<QueryPage<ClaimView>> {
    return this.measure("list_claims", () =>
      this.delegate.listClaims(chainId, owner, options),
    );
  }

  ready(): Promise<void> {
    return this.measure("ready", () => this.delegate.ready());
  }

  close(): Promise<void> {
    return this.delegate.close();
  }

  private async measure<T>(
    operation: string,
    execute: () => Promise<T>,
  ): Promise<T> {
    const release = await this.gate.acquire();
    const started = process.hrtime.bigint();
    try {
      return await execute();
    } finally {
      this.telemetry.operationDuration(
        operation,
        Number(process.hrtime.bigint() - started) / 1e9,
      );
      release();
    }
  }
}

class AdmissionGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly maximum: number,
    private readonly telemetry: IndexerDatabaseTelemetry,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100) {
      throw new RangeError(
        "maximumConcurrentOperations must be within [1, 100]",
      );
    }
  }

  async acquire(): Promise<() => void> {
    const started = process.hrtime.bigint();
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        this.telemetry.queued(this.waiters.length);
      });
    }
    this.active += 1;
    this.telemetry.queued(this.waiters.length);
    this.telemetry.inFlight(this.active);
    this.telemetry.admissionWait(
      Number(process.hrtime.bigint() - started) / 1e9,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.telemetry.inFlight(this.active);
      this.waiters.shift()?.();
      this.telemetry.queued(this.waiters.length);
    };
  }
}
