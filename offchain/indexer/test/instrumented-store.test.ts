import { describe, expect, it, vi } from "vitest";
import {
  InstrumentedEventQueryStore,
  type CloseableEventQueryStore,
} from "../src/instrumented-store.js";
import type { IndexerDatabaseTelemetry } from "../src/telemetry.js";

describe("InstrumentedEventQueryStore", () => {
  it("measures real store operations and queues above the configured driver limit", async () => {
    const releases: Array<() => void> = [];
    const delegate = emptyStore({
      ready: vi.fn(
        () => new Promise<void>((resolve) => releases.push(resolve)),
      ),
    });
    const samples = {
      waits: [] as number[],
      durations: [] as Array<{ operation: string; seconds: number }>,
      queued: [] as number[],
      inFlight: [] as number[],
      configured: [] as number[],
    };
    const telemetry: IndexerDatabaseTelemetry = {
      admissionWait: (seconds) => samples.waits.push(seconds),
      operationDuration: (operation, seconds) =>
        samples.durations.push({ operation, seconds }),
      queued: (value) => samples.queued.push(value),
      inFlight: (value) => samples.inFlight.push(value),
      configuredConnections: (value) => samples.configured.push(value),
    };
    const store = new InstrumentedEventQueryStore(delegate, 1, telemetry);

    const first = store.ready();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    const second = store.ready();
    await vi.waitFor(() => expect(samples.queued).toContain(1));
    expect(releases).toHaveLength(1);

    releases.shift()?.();
    await first;
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()?.();
    await second;

    expect(samples.configured).toEqual([1]);
    expect(samples.inFlight).toContain(1);
    expect(samples.inFlight.at(-1)).toBe(0);
    expect(samples.queued.at(-1)).toBe(0);
    expect(samples.waits).toHaveLength(2);
    expect(samples.durations.map((value) => value.operation)).toEqual([
      "ready",
      "ready",
    ]);
  });

  it("releases admission after a rejected database operation", async () => {
    const delegate = emptyStore({
      ready: vi
        .fn()
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValue(undefined),
    });
    const inFlight: number[] = [];
    const telemetry: IndexerDatabaseTelemetry = {
      admissionWait: () => undefined,
      operationDuration: () => undefined,
      queued: () => undefined,
      inFlight: (value) => inFlight.push(value),
      configuredConnections: () => undefined,
    };
    const store = new InstrumentedEventQueryStore(delegate, 1, telemetry);
    await expect(store.ready()).rejects.toThrow("db down");
    await expect(store.ready()).resolves.toBeUndefined();
    expect(inFlight.at(-1)).toBe(0);
  });
});

function emptyStore(
  overrides: Partial<CloseableEventQueryStore>,
): CloseableEventQueryStore {
  return {
    checkpoint: async () => undefined,
    canonicalBlock: async () => undefined,
    registeredMarkets: async () => [],
    applyBatch: async () => undefined,
    rollbackAfter: async () => undefined,
    listMarkets: async () => ({ items: [] }),
    market: async () => undefined,
    listMarketCatalog: async () => ({ items: [] }),
    listListings: async () => ({ items: [] }),
    listFills: async () => ({ items: [] }),
    listPositions: async () => ({ items: [] }),
    listClaims: async () => ({ items: [] }),
    listActivity: async () => ({ items: [] }),
    ready: async () => undefined,
    close: async () => undefined,
    ...overrides,
  };
}
