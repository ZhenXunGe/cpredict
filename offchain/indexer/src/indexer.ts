import { getAddress, type Address, type Log, type PublicClient } from "viem";
import { confirmationFor, discoverMarketAddresses } from "./derived.js";
import {
  normalizeLog,
  type CanonicalBlock,
  type ChainCheckpoint,
  type EventStore,
  type IndexedEvent,
} from "./store.js";

export interface IndexerOptions {
  chainId: number;
  deploymentBlock: bigint;
  confirmations: bigint;
  batchSize: bigint;
  /** Core contracts that must always be scanned, such as Factory and Marketplace. */
  addresses: readonly Address[];
  /** Enables atomic, same-block discovery of Factory-created market vaults. */
  factoryAddress?: Address;
}

export interface BatchResult {
  fromBlock: bigint;
  toBlock: bigint;
  blockCount: number;
  eventCount: number;
  discoveredMarkets: number;
  confirmationStatus: "provisional" | "confirmed";
}

/**
 * Canonical event ingestion with arbitrary-depth reorg recovery.
 *
 * Every scanned block hash is persisted. Before each batch, the indexer walks stored canonical
 * blocks backwards until it finds a hash that still matches the RPC chain, then asks the store to
 * atomically delete and rebuild all raw and derived state above that ancestor.
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
    if (
      options.addresses.length === 0 &&
      options.factoryAddress === undefined
    ) {
      throw new RangeError("at least one core or Factory address is required");
    }
  }

  async runBatch(): Promise<BatchResult | undefined> {
    await syncStage("reconcile", () => this.reconcileCheckpoint());
    const checkpoint = await syncStage("checkpoint-read", () =>
      this.store.checkpoint(this.options.chainId),
    );
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
    const logs = await syncStage("event-logs", () =>
      this.client.getLogs({
        address: [...addresses],
        fromBlock,
        toBlock,
      }),
    );
    const events = deduplicateLogs([...discoveryLogs, ...logs])
      .map((log) => normalizeLog(this.options.chainId, log, confirmationStatus))
      .sort(compareEvents);
    const blocks = await syncStage("canonical-blocks", () =>
      this.loadCanonicalBlocks(fromBlock, toBlock, confirmationStatus),
    );
    validateLineage(blocks, checkpoint);
    const endBlock = blocks.at(-1);
    if (endBlock === undefined)
      throw new Error("canonical block batch is empty");
    const next: ChainCheckpoint = {
      chainId: this.options.chainId,
      blockNumber: endBlock.blockNumber,
      blockHash: endBlock.blockHash,
    };
    await syncStage("batch-write", () =>
      this.store.applyBatch(events, blocks, next),
    );
    return {
      fromBlock,
      toBlock,
      blockCount: blocks.length,
      eventCount: events.length,
      discoveredMarkets: discovered.length,
      confirmationStatus,
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

  private async reconcileCheckpoint(): Promise<void> {
    const checkpoint = await this.store.checkpoint(this.options.chainId);
    if (checkpoint === undefined) return;

    let cursor = checkpoint.blockNumber;
    let commonAncestor: bigint | undefined;
    while (cursor >= this.options.deploymentBlock) {
      const stored = await this.store.canonicalBlock(
        this.options.chainId,
        cursor,
      );
      if (stored === undefined) {
        throw new Error(
          `missing persisted canonical block ${cursor.toString()}`,
        );
      }
      const canonical = await this.client.getBlock({ blockNumber: cursor });
      if (canonical.hash === stored.blockHash) {
        commonAncestor = cursor;
        break;
      }
      if (cursor === this.options.deploymentBlock) break;
      cursor -= 1n;
    }

    if (commonAncestor === checkpoint.blockNumber) return;
    await this.store.rollbackAfter(this.options.chainId, commonAncestor);
  }

  private async loadCanonicalBlocks(
    fromBlock: bigint,
    toBlock: bigint,
    confirmationStatus: "provisional" | "confirmed",
  ): Promise<readonly CanonicalBlock[]> {
    const numbers: bigint[] = [];
    for (let number = fromBlock; number <= toBlock; number += 1n)
      numbers.push(number);
    const blocks = await mapConcurrent(numbers, 4, (blockNumber) =>
      this.client.getBlock({ blockNumber }),
    );
    return blocks.map((block, index) => {
      const blockNumber = numbers[index];
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
}

async function mapConcurrent<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  action: (input: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const outputs = new Array<Output>(inputs.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      while (cursor < inputs.length) {
        const index = cursor++;
        const input = inputs[index];
        if (input !== undefined) outputs[index] = await action(input);
      }
    }),
  );
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
