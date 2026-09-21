import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { validateCanonicalBatch } from "../src/canonical-batch.js";
import { MemoryEventStore } from "../src/memory-store.js";
import type { CanonicalBatch, CanonicalBlock, ChainCheckpoint } from "../src/store.js";

const chainId = 42_1614;

describe("CanonicalBatch", () => {
  it("requires a matching endpoint anchor and event anchor", () => {
    const batch = canonicalBatch(1n, 100n);
    expect(() => validateCanonicalBatch(batch)).not.toThrow();
    expect(() =>
      validateCanonicalBatch({ ...batch, anchors: [] }),
    ).toThrow("endpoint anchor");
    expect(() =>
      validateCanonicalBatch({
        ...batch,
        events: [
          {
            chainId,
            blockNumber: 50n,
            blockHash: hash(50n),
            transactionHash: hash(500n),
            transactionIndex: 0,
            logIndex: 0,
            address: "0x0000000000000000000000000000000000000001",
            topics: [],
            data: "0x",
            confirmationStatus: "confirmed",
          },
        ],
      }),
    ).toThrow("event hash");
  });

  it("rejects gaps, overlaps and conflicting retries without partial writes", async () => {
    const store = new MemoryEventStore();
    const first = canonicalBatch(1n, 100n);
    await store.applyBatch(first);
    const checkpoint = first.checkpoint;

    await expect(
      store.applyBatch(canonicalBatch(102n, 200n, checkpoint)),
    ).rejects.toThrow("contiguous");
    await expect(
      store.applyBatch(canonicalBatch(50n, 150n, checkpoint)),
    ).rejects.toThrow();
    await expect(
      store.applyBatch({
        ...first,
        range: { ...first.range, endBlockHash: hash(9_999n) },
        checkpoint: { ...first.checkpoint, blockHash: hash(9_999n) },
        anchors: [{ ...first.anchors[0]!, blockHash: hash(9_999n) }],
      }),
    ).rejects.toThrow();

    expect(await store.checkpoint(chainId)).toEqual(checkpoint);
    expect((await store.scanRanges(chainId))).toHaveLength(1);
    expect(store.blockCount(chainId)).toBe(1);
  });
});

function canonicalBatch(
  fromBlock: bigint,
  toBlock: bigint,
  predecessor?: ChainCheckpoint,
): CanonicalBatch {
  const endpoint = block(toBlock);
  return {
    range: {
      chainId,
      fromBlock,
      toBlock,
      predecessor,
      endBlockHash: endpoint.blockHash,
      confirmationStatus: "confirmed",
      mode: "sparse",
    },
    anchors: [endpoint],
    events: [],
    checkpoint: {
      chainId,
      blockNumber: toBlock,
      blockHash: endpoint.blockHash,
    },
  };
}

function block(blockNumber: bigint): CanonicalBlock {
  return {
    chainId,
    blockNumber,
    blockHash: hash(blockNumber),
    parentHash: hash(blockNumber - 1n),
    timestamp: blockNumber * 10n,
    confirmationStatus: "confirmed",
  };
}

function hash(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
