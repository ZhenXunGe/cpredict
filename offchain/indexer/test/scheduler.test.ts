import { describe, expect, it, vi } from "vitest";
import type { BatchResult, ChainIndexer } from "../src/indexer.js";
import { BoundedIndexerScheduler } from "../src/scheduler.js";

const batch: BatchResult = {
  fromBlock: 1n,
  toBlock: 1n,
  blockCount: 1,
  eventCount: 2,
  discoveredMarkets: 1,
  confirmationStatus: "confirmed",
};

describe("BoundedIndexerScheduler", () => {
  it("caps catch-up work per tick and records every committed batch", async () => {
    const indexer = {
      runBatch: vi.fn(async () => batch),
    } as unknown as ChainIndexer;
    const telemetry = {
      batch: vi.fn(),
      idle: vi.fn(),
      failure: vi.fn(),
      tickDuration: vi.fn(),
    };
    const scheduler = new BoundedIndexerScheduler(indexer, telemetry, {
      intervalMs: 1_000,
      maxBatchesPerTick: 3,
    });
    await expect(scheduler.runTick()).resolves.toBe(3);
    expect(indexer.runBatch).toHaveBeenCalledTimes(3);
    expect(telemetry.batch).toHaveBeenCalledTimes(3);
  });

  it("does not overlap ticks and drains the active tick during shutdown", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const indexer = {
      runBatch: vi.fn(async () => {
        await blocked;
        return undefined;
      }),
    } as unknown as ChainIndexer;
    const scheduler = new BoundedIndexerScheduler(
      indexer,
      {
        batch: vi.fn(),
        idle: vi.fn(),
        failure: vi.fn(),
        tickDuration: vi.fn(),
      },
      { intervalMs: 1_000, maxBatchesPerTick: 1 },
    );
    scheduler.start();
    await vi.waitFor(() => expect(indexer.runBatch).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    expect(scheduler.isRunning()).toBe(false);
  });

  it("fails readiness after an ingestion error and recovers after a successful tick", async () => {
    const indexer = {
      runBatch: vi
        .fn()
        .mockRejectedValueOnce(new Error("RPC unavailable"))
        .mockResolvedValueOnce(undefined),
    } as unknown as ChainIndexer;
    const scheduler = new BoundedIndexerScheduler(
      indexer,
      {
        batch: vi.fn(),
        idle: vi.fn(),
        failure: vi.fn(),
        tickDuration: vi.fn(),
      },
      { intervalMs: 1_000, maxBatchesPerTick: 1 },
    );

    await expect(scheduler.runTick()).rejects.toThrow("RPC unavailable");
    expect(() => scheduler.assertHealthy()).toThrow("last tick failed");
    await expect(scheduler.runTick()).resolves.toBe(0);
    expect(() => scheduler.assertHealthy()).not.toThrow();
  });
});
