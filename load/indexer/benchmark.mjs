import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const markets = integer("INDEXER_MARKETS", 100, 1, 10_000);
const listings = integer("INDEXER_LISTINGS", 5_000, 1, 100_000);
const profile = process.env.LOAD_PROFILE ?? "smoke";
if (
  listings > 10_000 &&
  process.env.CPREDICT_LOAD_CONFIRM !== "I_UNDERSTAND_RESOURCE_USAGE"
) {
  throw new Error(
    "large indexer benchmark requires explicit resource acknowledgement",
  );
}
const modulePath = process.env.CPREDICT_INDEXER_MODULE;
if (modulePath === undefined) {
  throw new Error(
    "CPREDICT_INDEXER_MODULE must point to compiled offchain/indexer/src/indexer.js",
  );
}
async function run() {
  const { ChainIndexer } = await import(pathToFileURL(modulePath).href);

  const eventsPerBlock = 100;
  const totalEvents = markets + listings;
  const finalBlock = BigInt(Math.ceil(totalEvents / eventsPerBlock) - 1);
  const client = new DeterministicClient(
    totalEvents,
    eventsPerBlock,
    finalBlock,
  );
  const store = new CountingStore();
  const addresses = Array.from({ length: markets }, (_, index) =>
    address(index + 1),
  );
  const indexer = new ChainIndexer(client, store, {
    chainId: 31_337,
    deploymentBlock: 0n,
    confirmations: 0n,
    batchSize: 100n,
    addresses,
  });

  const batchLatencies = [];
  let batches = 0;
  const startedAt = performance.now();
  while (true) {
    const batchStarted = performance.now();
    const batch = await indexer.runBatch();
    if (batch === undefined) break;
    batchLatencies.push(performance.now() - batchStarted);
    batches += 1;
  }
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  batchLatencies.sort((a, b) => a - b);
  const checkpoint = await store.checkpoint(31_337);
  const syntheticLag =
    checkpoint === undefined
      ? Number(finalBlock + 1n)
      : Number(finalBlock - checkpoint.blockNumber);
  const result = {
    lane: "real-ChainIndexer-synthetic-client-counting-store",
    profile,
    markets,
    listings,
    totalEvents,
    eventsPerBlock,
    batches,
    ingestedEvents: store.eventCount,
    elapsedSeconds: round(elapsedSeconds),
    eventsPerSecond: round(store.eventCount / elapsedSeconds),
    batchLatencyMs: {
      p50: percentile(batchLatencies, 0.5),
      p95: percentile(batchLatencies, 0.95),
      p99: percentile(batchLatencies, 0.99),
      max: round(batchLatencies.at(-1) ?? 0),
    },
    syntheticProvisionalLagBlocks: syntheticLag,
    integrity: {
      exactEventCount: store.eventCount === totalEvents,
      lagAtMostTwoBlocks: syntheticLag <= 2,
    },
    proofBoundary:
      "Executes the repository ChainIndexer logic, but the deterministic client and counting store do not validate PostgreSQL throughput, RPC limits, Arbitrum reorgs, or production lag.",
  };
  const encoded = `${JSON.stringify(result, null, 2)}\n`;
  process.stdout.write(encoded);
  if (process.env.REPORT_PATH !== undefined)
    fs.writeFileSync(process.env.REPORT_PATH, encoded);
  if (
    !result.integrity.exactEventCount ||
    !result.integrity.lagAtMostTwoBlocks
  ) {
    process.exitCode = 2;
  }
}

class DeterministicClient {
  constructor(eventCount, perBlock, chainHead) {
    this.eventCount = eventCount;
    this.perBlock = perBlock;
    this.chainHead = chainHead;
  }

  async getBlockNumber() {
    return this.chainHead;
  }

  async getBlock({ blockNumber }) {
    return {
      hash: hash(Number(blockNumber) + 1),
      parentHash: hash(Number(blockNumber)),
      timestamp: blockNumber,
    };
  }

  async getLogs({ fromBlock, toBlock }) {
    const first = Number(fromBlock) * this.perBlock;
    const lastExclusive = Math.min(
      this.eventCount,
      (Number(toBlock) + 1) * this.perBlock,
    );
    const logs = [];
    for (let index = first; index < lastExclusive; index += 1) {
      const blockNumber = BigInt(Math.floor(index / this.perBlock));
      logs.push({
        address: address((index % markets) + 1),
        blockHash: hash(Number(blockNumber) + 1),
        blockNumber,
        data: `0x${BigInt(index).toString(16).padStart(64, "0")}`,
        logIndex: index % this.perBlock,
        removed: false,
        topics: [hash(index + 1)],
        transactionHash: hash(index + 1_000_000),
        transactionIndex: index % this.perBlock,
      });
    }
    return logs;
  }
}

class CountingStore {
  checkpoints = new Map();
  blocks = new Map();
  events = new Map();

  get eventCount() {
    return this.events.size;
  }

  async checkpoint(chainId) {
    return this.checkpoints.get(chainId);
  }

  async canonicalBlock(chainId, blockNumber) {
    return this.blocks.get(`${chainId}:${blockNumber}`);
  }

  async registeredMarkets() {
    return [];
  }

  async applyBatch(events, blocks, checkpoint) {
    for (const event of events) {
      this.events.set(
        `${event.chainId}:${event.transactionHash}:${event.logIndex}`,
        event,
      );
    }
    for (const block of blocks) {
      this.blocks.set(`${block.chainId}:${block.blockNumber}`, block);
    }
    this.checkpoints.set(checkpoint.chainId, checkpoint);
  }

  async rollbackAfter(chainId, blockNumber) {
    for (const [key, event] of this.events) {
      if (
        event.chainId === chainId &&
        (blockNumber === undefined || event.blockNumber > blockNumber)
      ) {
        this.events.delete(key);
      }
    }
    for (const [key, block] of this.blocks) {
      if (
        block.chainId === chainId &&
        (blockNumber === undefined || block.blockNumber > blockNumber)
      ) {
        this.blocks.delete(key);
      }
    }
    if (blockNumber === undefined) {
      this.checkpoints.delete(chainId);
      return;
    }
    const block = await this.canonicalBlock(chainId, blockNumber);
    if (block === undefined) {
      this.checkpoints.delete(chainId);
    } else {
      this.checkpoints.set(chainId, {
        chainId,
        blockNumber,
        blockHash: block.blockHash,
      });
    }
  }
}

function address(value) {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function hash(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function integer(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer within [${minimum}, ${maximum}]`,
    );
  }
  return value;
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  return round(
    values[
      Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)
    ],
  );
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

await run();
