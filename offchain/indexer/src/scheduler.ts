import type { ChainIndexer } from "./indexer.js";
import type { IndexerSchedulerTelemetry } from "./telemetry.js";

export interface IndexerSchedulerOptions {
  intervalMs: number;
  maxBatchesPerTick: number;
}

/** Non-overlapping polling with a hard per-tick work bound and drainable shutdown. */
export class BoundedIndexerScheduler {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private lastFailure: unknown;

  constructor(
    private readonly indexer: ChainIndexer,
    private readonly telemetry: IndexerSchedulerTelemetry,
    private readonly options: IndexerSchedulerOptions,
  ) {
    if (
      !Number.isInteger(options.maxBatchesPerTick) ||
      options.maxBatchesPerTick < 1 ||
      options.maxBatchesPerTick > 100
    ) {
      throw new RangeError("maxBatchesPerTick must be within [1, 100]");
    }
    if (
      !Number.isInteger(options.intervalMs) ||
      options.intervalMs < 250 ||
      options.intervalMs > 60_000
    ) {
      throw new RangeError("intervalMs must be within [250, 60000]");
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  assertHealthy(): void {
    if (this.lastFailure !== undefined)
      throw new Error("indexer scheduler last tick failed");
  }

  start(): void {
    if (this.running) throw new Error("indexer scheduler already started");
    this.running = true;
    this.enqueue();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.inFlight;
  }

  async runTick(): Promise<number> {
    const started = performance.now();
    let committed = 0;
    try {
      for (let index = 0; index < this.options.maxBatchesPerTick; index += 1) {
        const result = await this.indexer.runBatch();
        if (result === undefined) {
          if (committed === 0) this.telemetry.idle();
          break;
        }
        committed += 1;
        this.telemetry.batch(result);
      }
      this.lastFailure = undefined;
      return committed;
    } catch (error: unknown) {
      this.lastFailure = error;
      this.telemetry.failure(error);
      throw error;
    } finally {
      this.telemetry.tickDuration((performance.now() - started) / 1_000);
    }
  }

  private enqueue(): void {
    this.inFlight = this.inFlight.then(async () => {
      try {
        await this.runTick();
      } catch {
        // Metrics and readiness expose the failure. The scheduler remains bounded and retries only
        // on the next polling tick; it never launches overlapping recovery loops.
      }
      if (this.running) {
        this.timer = setTimeout(() => this.enqueue(), this.options.intervalMs);
      }
    });
  }
}
