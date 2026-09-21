import type { Hex } from "viem";
import type {
  CanonicalBatch,
  CanonicalBlock,
  ChainCheckpoint,
} from "./store.js";

export function validateCanonicalBatch(batch: CanonicalBatch): void {
  const { range, checkpoint } = batch;
  if (range.fromBlock > range.toBlock)
    throw new Error("canonical batch range is empty");
  if (
    checkpoint.chainId !== range.chainId ||
    checkpoint.blockNumber !== range.toBlock ||
    checkpoint.blockHash !== range.endBlockHash
  )
    throw new Error("canonical batch checkpoint does not match its range");
  if (
    range.predecessor !== undefined &&
    (range.predecessor.chainId !== range.chainId ||
      range.predecessor.blockNumber + 1n !== range.fromBlock)
  )
    throw new Error("canonical batch predecessor is not contiguous");

  const anchors = new Map<bigint, Hex>();
  for (const anchor of batch.anchors) {
    if (
      anchor.chainId !== range.chainId ||
      anchor.blockNumber < range.fromBlock ||
      anchor.blockNumber > range.toBlock ||
      anchor.confirmationStatus !== range.confirmationStatus
    )
      throw new Error("canonical anchor is outside its scan range");
    const previous = anchors.get(anchor.blockNumber);
    if (previous !== undefined && previous !== anchor.blockHash)
      throw new Error("canonical batch contains conflicting anchors");
    anchors.set(anchor.blockNumber, anchor.blockHash);
  }
  if (anchors.get(range.toBlock) !== range.endBlockHash)
    throw new Error("canonical batch is missing its endpoint anchor");
  for (const event of batch.events) {
    if (
      event.chainId !== range.chainId ||
      event.blockNumber < range.fromBlock ||
      event.blockNumber > range.toBlock ||
      event.confirmationStatus !== range.confirmationStatus ||
      anchors.get(event.blockNumber) !== event.blockHash
    )
      throw new Error("event hash does not match a canonical batch anchor");
  }
}

export function legacyDenseBatch(
  events: CanonicalBatch["events"],
  blocks: readonly CanonicalBlock[],
  checkpoint: ChainCheckpoint,
  predecessor: ChainCheckpoint | undefined,
): CanonicalBatch {
  const first = blocks[0];
  if (first === undefined) throw new Error("canonical block batch is empty");
  return {
    range: {
      chainId: checkpoint.chainId,
      fromBlock: first.blockNumber,
      toBlock: checkpoint.blockNumber,
      predecessor,
      endBlockHash: checkpoint.blockHash,
      confirmationStatus: first.confirmationStatus,
      mode: "dense",
    },
    anchors: blocks,
    events,
    checkpoint,
  };
}
