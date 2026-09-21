import { describe, expect, it, vi } from "vitest";
import type { Hex, PublicClient } from "viem";
import { findBlockBeforeTimestamp } from "../src/leaderboards.js";

describe("leaderboard time lookup", () => {
  it("finds the exact last block before the exclusive boundary", async () => {
    const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({
      number: blockNumber,
      hash: hash(blockNumber),
      parentHash: hash(blockNumber - 1n),
      timestamp: blockNumber * 10n,
      transactions: [],
    }));
    let reads = 0;
    const block = await findBlockBeforeTimestamp(
      { getBlock } as unknown as PublicClient,
      1n,
      100n,
      555n,
      () => reads++,
    );

    expect(block).toMatchObject({ number: 55n, timestamp: 550n });
    expect(reads).toBe(getBlock.mock.calls.length);
    expect(reads).toBeLessThanOrEqual(7);
  });

  it("returns no boundary block when the period predates indexed history", async () => {
    const client = {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        number: blockNumber,
        hash: hash(blockNumber),
        parentHash: hash(blockNumber - 1n),
        timestamp: blockNumber * 10n,
        transactions: [],
      }),
    } as unknown as PublicClient;
    await expect(findBlockBeforeTimestamp(client, 10n, 20n, 100n)).resolves.toBeUndefined();
  });
});

function hash(value: bigint): Hex {
  const normalized = value < 0n ? 0n : value;
  return `0x${normalized.toString(16).padStart(64, "0")}`;
}
