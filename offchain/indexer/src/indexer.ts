import {
  getAddress,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { scopedAccountLogs } from "./scoped-logs.js";
import { completeMarketCreationLogs } from "./creation-logs.js";
import type { ProtocolVersion } from "../../sdk/src/legacy-protocol.js";
import { confirmationFor, discoverMarketAddresses } from "./derived.js";
import {
  normalizeLog,
  type CanonicalBatch,
  type CanonicalBlock,
  type CanonicalMode,
  type ChainCheckpoint,
  type EventStore,
  type IndexedEvent,
} from "./store.js";

export interface IndexerOptions {
  chainId: number;
  deploymentBlock: bigint;
  confirmations: bigint;
  batchSize: bigint;
  /** Maximum concurrent canonical-block reads. Defaults to 4 for existing providers. */
  blockConcurrency?: number;
  canonicalMode?: CanonicalMode;
  telemetry?: IndexerIngestionTelemetry;
  /** Core contracts that must always be scanned, such as Factory and Marketplace. */
  addresses: readonly Address[];
  /** Enables atomic, same-block discovery of Factory-created market vaults. */
  factoryAddress?: Address;
  protocol?: ProtocolVersion;
  financial?: {
    paymentToken: Address;
    accounts(): Promise<readonly Address[]>;
    scanned(
      accounts: readonly Address[],
      from: bigint,
      to: bigint,
      hash: Hex,
    ): Promise<void>;
    backfill(): Promise<void>;
  };
}

export interface BatchResult {
  fromBlock: bigint;
  toBlock: bigint;
  blockCount: number;
  anchorCount: number;
  eventCount: number;
  discoveredMarkets: number;
  confirmationStatus: "provisional" | "confirmed";
  /** True when this batch ended at the safe head observed before scanning. */
  caughtUp: boolean;
}

export type BlockHeaderReadPurpose =
  | "head"
  | "fence"
  | "event"
  | "recovery"
  | "backfill"
  | "time_lookup";

export interface IndexerIngestionTelemetry {
  blockHeaderRead(purpose: BlockHeaderReadPurpose): void;
  fenceFailure(): void;
  rollback(batchCount: number, blockCount: bigint): void;
}

/**
 * Canonical event ingestion with arbitrary-depth reorg recovery.
 *
 * Dense mode persists every scanned block. Sparse mode persists range endpoints and event blocks;
 * endpoint hashes commit to the intervening parent chain. Before each batch, the indexer finds the
 * newest matching range endpoint (and retained dense history for deeper reorgs), then asks the
 * store to atomically delete and rebuild all raw and derived state above that ancestor.
 */
export class ChainIndexer {
  constructor(
    private readonly client: PublicClient,
    private readonly store: EventStore,
    private readonly options: IndexerOptions,
  ) {
    if (options.batchSize < 1n || options.batchSize > 10_000n) {
      throw new RangeError("batchSize must be within [1, 10000]");
    }
    if (options.confirmations < 0n)
      throw new RangeError("confirmations must be non-negative");
    const blockConcurrency = options.blockConcurrency ?? 4;
    if (
      !Number.isInteger(blockConcurrency) ||
      blockConcurrency < 1 ||
      blockConcurrency > 32
    )
      throw new RangeError(
        "blockConcurrency must be an integer within [1, 32]",
      );
    if (
      options.addresses.length === 0 &&
      options.factoryAddress === undefined
    ) {
      throw new RangeError("at least one core or Factory address is required");
    }
    if (
      options.canonicalMode !== undefined &&
      options.canonicalMode !== "dense" &&
      options.canonicalMode !== "sparse"
    )
      throw new RangeError("canonicalMode must be dense or sparse");
  }

  async runBatch(): Promise<BatchResult | undefined> {
    const checkpoint = await syncStage("reconcile", () =>
      this.reconcileCheckpoint(),
    );
    if (this.options.financial)
      await syncStage("event-logs", () => this.options.financial!.backfill());
    const chainHead = await syncStage("chain-head", () =>
      this.client.getBlockNumber(),
    );
    if (chainHead < this.options.confirmations) return undefined;
    const safeHead = chainHead - this.options.confirmations;
    const fromBlock =
      checkpoint === undefined
        ? this.options.deploymentBlock
        : checkpoint.blockNumber + 1n;
    if (fromBlock > safeHead) return undefined;
    const toBlock = min(fromBlock + this.options.batchSize - 1n, safeHead);
    const confirmationStatus = confirmationFor(this.options.confirmations);

    const discoveryLogs = await syncStage("discovery-logs", () =>
      this.discoveryLogs(fromBlock, toBlock),
    );
    const discovered = discoverMarketAddresses(discoveryLogs);
    const registered = await syncStage("registered-markets", () =>
      this.store.registeredMarkets(this.options.chainId),
    );
    const addresses = uniqueAddresses([
      ...this.options.addresses,
      ...(this.options.factoryAddress === undefined
        ? []
        : [this.options.factoryAddress]),
      ...registered,
      ...discovered,
    ]);
    let logs = await syncStage("event-logs", () =>
      this.client.getLogs({
        address: [...addresses],
        fromBlock,
        toBlock,
      }),
    );
    // Discovery and range queries can hit RPC nodes at different indexing stages.
    // Include vaults first seen in the second query across the whole batch too.
    const lateMarkets =
      this.options.factoryAddress === undefined
        ? []
        : discoverMarketAddresses(
            logs.filter(
              (log) =>
                log.address.toLowerCase() ===
                this.options.factoryAddress!.toLowerCase(),
            ),
          ).filter(
            (market) =>
              !addresses.some(
                (address) => address.toLowerCase() === market.toLowerCase(),
              ),
          );
    if (lateMarkets.length > 0) {
      const lateLogs = await syncStage("event-logs", () =>
        this.client.getLogs({
          address: [...lateMarkets],
          fromBlock,
          toBlock,
        }),
      );
      logs = [...logs, ...lateLogs];
    }
    const creationLogs =
      this.options.factoryAddress === undefined
        ? [...discoveryLogs, ...logs]
        : await syncStage("event-logs", () =>
            completeMarketCreationLogs(
              this.client,
              deduplicateLogs([...discoveryLogs, ...logs]),
              this.options.factoryAddress!,
              this.options.chainId,
              this.options.protocol,
            ),
          );
    const tracked = this.options.financial
      ? await this.options.financial.accounts()
      : [];
    const scoped = this.options.financial
      ? await syncStage("event-logs", () =>
          scopedAccountLogs(
            this.client,
            this.options.financial!.paymentToken,
            tracked,
            fromBlock,
            toBlock,
          ),
        )
      : [];
    const events = deduplicateLogs([...creationLogs, ...scoped])
      .map((log) => normalizeLog(this.options.chainId, log, confirmationStatus))
      .sort(compareEvents);
    const anchors = await syncStage("canonical-blocks", () =>
      this.loadCanonicalAnchors(
        fromBlock,
        toBlock,
        confirmationStatus,
        new Set(events.map((event) => event.blockNumber)),
      ),
    );
    if ((this.options.canonicalMode ?? "dense") === "dense")
      validateLineage(anchors, checkpoint);
    else validateAdjacentAnchors(anchors, checkpoint);
    const canonicalHashes = new Map(
      anchors.map((block) => [block.blockNumber, block.blockHash]),
    );
    if (
      events.some(
        (event) => canonicalHashes.get(event.blockNumber) !== event.blockHash,
      )
    )
      throw new Error("event logs do not match canonical batch");
    const endBlock = anchors.find((block) => block.blockNumber === toBlock);
    if (endBlock === undefined)
      throw new Error("canonical batch endpoint is missing");
    const next: ChainCheckpoint = {
      chainId: this.options.chainId,
      blockNumber: endBlock.blockNumber,
      blockHash: endBlock.blockHash,
    };
    await syncStage("canonical-blocks", () =>
      this.verifyCommitFence(next),
    );
    const batch: CanonicalBatch = {
      range: {
        chainId: this.options.chainId,
        fromBlock,
        toBlock,
        predecessor: checkpoint,
        endBlockHash: endBlock.blockHash,
        confirmationStatus,
        mode: this.options.canonicalMode ?? "dense",
      },
      anchors,
      events,
      checkpoint: next,
    };
    await syncStage("batch-write", () =>
      this.store.applyBatch(batch),
    );
    if (this.options.financial)
      await syncStage("batch-write", () =>
        this.options.financial!.scanned(
          tracked,
          fromBlock,
          toBlock,
          endBlock.blockHash,
        ),
      );
    return {
      fromBlock,
      toBlock,
      blockCount: Number(toBlock - fromBlock + 1n),
      anchorCount: anchors.length,
      eventCount: events.length,
      discoveredMarkets: uniqueAddresses([...discovered, ...lateMarkets])
        .length,
      confirmationStatus,
      caughtUp: toBlock === safeHead,
    };
  }

  private async discoveryLogs(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<readonly Log[]> {
    if (this.options.factoryAddress === undefined) return [];
    return this.client.getLogs({
      address: this.options.factoryAddress,
      fromBlock,
      toBlock,
    });
  }

  private async reconcileCheckpoint(): Promise<ChainCheckpoint | undefined> {
    const checkpoint = await this.store.checkpoint(this.options.chainId);
    if (checkpoint === undefined) return undefined;
    let commonAncestor: bigint | undefined;
    const ranges = await this.store.scanRanges(this.options.chainId);
    for (const range of ranges) {
      if (range.toBlock > checkpoint.blockNumber) continue;
      const stored = await this.store.canonicalBlock(
        this.options.chainId,
        range.toBlock,
      );
      if (stored?.blockHash !== range.endBlockHash)
        throw new Error(`missing persisted range endpoint ${range.toBlock.toString()}`);
      const canonical = await this.readBlock(range.toBlock, range.toBlock === checkpoint.blockNumber ? "fence" : "recovery");
      if (canonical.hash === stored.blockHash) {
        commonAncestor = range.toBlock;
        break;
      }
      if (range.mode === "dense") {
        let cursor = range.toBlock - 1n;
        while (cursor >= range.fromBlock) {
          const dense = await this.store.canonicalBlock(this.options.chainId, cursor);
          if (dense === undefined)
            throw new Error(`missing persisted canonical block ${cursor.toString()}`);
          if ((await this.readBlock(cursor, "recovery")).hash === dense.blockHash) {
            commonAncestor = cursor;
            break;
          }
          if (cursor === range.fromBlock) break;
          cursor -= 1n;
        }
        if (commonAncestor !== undefined) break;
      }
    }

    if (commonAncestor === undefined) {
      const oldest = ranges.at(-1);
      let cursor = oldest?.predecessor?.blockNumber ??
        (ranges.length === 0 ? checkpoint.blockNumber : undefined);
      while (cursor !== undefined && cursor >= this.options.deploymentBlock) {
        const stored = await this.store.canonicalBlock(this.options.chainId, cursor);
        if (stored === undefined)
          throw new Error(`missing persisted canonical block ${cursor.toString()}`);
        const canonical = await this.readBlock(cursor, cursor === checkpoint.blockNumber ? "fence" : "recovery");
        if (canonical.hash === stored.blockHash) {
          commonAncestor = cursor;
          break;
        }
        if (cursor === this.options.deploymentBlock) break;
        cursor -= 1n;
      }
    }

    if (commonAncestor === checkpoint.blockNumber) return checkpoint;
    const rolledBackRanges = ranges.filter(
      (range) => commonAncestor === undefined || range.toBlock > commonAncestor,
    ).length;
    this.options.telemetry?.rollback(
      rolledBackRanges,
      commonAncestor === undefined
        ? checkpoint.blockNumber - this.options.deploymentBlock + 1n
        : checkpoint.blockNumber - commonAncestor,
    );
    await this.store.rollbackAfter(this.options.chainId, commonAncestor);
    return this.store.checkpoint(this.options.chainId);
  }

  private async loadCanonicalAnchors(
    fromBlock: bigint,
    toBlock: bigint,
    confirmationStatus: "provisional" | "confirmed",
    eventBlocks: ReadonlySet<bigint>,
  ): Promise<readonly CanonicalBlock[]> {
    const numbers: bigint[] = [];
    if ((this.options.canonicalMode ?? "dense") === "dense") {
      for (let number = fromBlock; number <= toBlock; number += 1n)
        numbers.push(number);
    } else {
      numbers.push(...eventBlocks, toBlock);
      numbers.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
    const uniqueNumbers = [...new Set(numbers)];
    const blocks = await mapConcurrent(
      uniqueNumbers,
      this.options.blockConcurrency ?? 4,
      (blockNumber) =>
        this.readBlock(
          blockNumber,
          eventBlocks.has(blockNumber)
            ? "event"
            : blockNumber === toBlock
              ? "fence"
              : "head",
        ),
    );
    return blocks.map((block, index) => {
      const blockNumber = uniqueNumbers[index];
      if (
        block === undefined ||
        blockNumber === undefined ||
        block.hash === null
      ) {
        throw new Error("RPC returned an incomplete canonical block");
      }
      return {
        chainId: this.options.chainId,
        blockNumber,
        blockHash: block.hash,
        parentHash: block.parentHash,
        timestamp: block.timestamp,
        confirmationStatus,
      };
    });
  }

  private async verifyCommitFence(endpoint: ChainCheckpoint): Promise<void> {
    // reconcileCheckpoint verifies the predecessor before the scan. The endpoint hash commits to
    // every parent through that predecessor, so re-reading the endpoint before commit detects a
    // change anywhere in the scanned range without repeating the predecessor header request.
    const end = await this.readBlock(endpoint.blockNumber, "fence");
    if (end.hash !== endpoint.blockHash) {
      this.options.telemetry?.fenceFailure();
      throw new Error("canonical stability fence changed");
    }
  }

  private async readBlock(
    blockNumber: bigint,
    purpose: BlockHeaderReadPurpose,
  ) {
    this.options.telemetry?.blockHeaderRead(purpose);
    return this.client.getBlock({ blockNumber });
  }
}

async function mapConcurrent<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  action: (input: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const outputs = new Array<Output>(inputs.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      while (!failed && cursor < inputs.length) {
        const index = cursor++;
        const input = inputs[index];
        try {
          if (input !== undefined) outputs[index] = await action(input);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    }),
  );
  // Drain in-flight reads before the scheduler may retry this uncommitted batch.
  if (failed) throw failure;
  return outputs;
}

async function syncStage<T>(
  stage:
    | "reconcile"
    | "checkpoint-read"
    | "chain-head"
    | "discovery-logs"
    | "registered-markets"
    | "event-logs"
    | "canonical-blocks"
    | "batch-write",
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch {
    throw new Error(`indexer sync stage failed: ${stage}`);
  }
}

function uniqueAddresses(values: readonly Address[]): readonly Address[] {
  const result = new Map<string, Address>();
  for (const value of values)
    result.set(value.toLowerCase(), getAddress(value));
  return [...result.values()];
}

function deduplicateLogs(logs: readonly Log[]): readonly Log[] {
  const result = new Map<string, Log>();
  for (const log of logs) {
    if (log.transactionHash === null || log.logIndex === null) {
      throw new Error("indexer received a pending or incomplete discovery log");
    }
    result.set(`${log.transactionHash.toLowerCase()}:${log.logIndex}`, log);
  }
  return [...result.values()];
}

function compareEvents(a: IndexedEvent, b: IndexedEvent): number {
  if (a.blockNumber !== b.blockNumber)
    return a.blockNumber < b.blockNumber ? -1 : 1;
  if (a.transactionIndex !== b.transactionIndex)
    return a.transactionIndex - b.transactionIndex;
  return a.logIndex - b.logIndex;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function validateLineage(
  blocks: readonly CanonicalBlock[],
  checkpoint: ChainCheckpoint | undefined,
): void {
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block === undefined)
      throw new Error("canonical block batch contains a gap");
    const expectedParent =
      index === 0 ? checkpoint?.blockHash : blocks[index - 1]?.blockHash;
    if (expectedParent !== undefined && block.parentHash !== expectedParent) {
      throw new Error(
        `canonical lineage changed at block ${block.blockNumber.toString()}`,
      );
    }
  }
}

function validateAdjacentAnchors(
  blocks: readonly CanonicalBlock[],
  checkpoint: ChainCheckpoint | undefined,
): void {
  const ordered = [...blocks].sort((a, b) =>
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
  );
  for (let index = 0; index < ordered.length; index += 1) {
    const block = ordered[index];
    if (block === undefined) throw new Error("canonical anchor batch contains a gap");
    const previous = index === 0 ? checkpoint : ordered[index - 1];
    if (
      previous !== undefined &&
      previous.blockNumber + 1n === block.blockNumber &&
      block.parentHash !== previous.blockHash
    )
      throw new Error(`canonical lineage changed at block ${block.blockNumber.toString()}`);
  }
}
