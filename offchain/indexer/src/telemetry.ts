import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import type {
  BatchResult,
  BlockHeaderReadPurpose,
  IndexerIngestionTelemetry,
} from "./indexer.js";

export interface IndexerSchedulerTelemetry {
  batch(result: BatchResult): void;
  idle(): void;
  failure(error: unknown): void;
  tickDuration(seconds: number): void;
}

export interface IndexerDatabaseTelemetry {
  admissionWait(seconds: number): void;
  operationDuration(operation: string, seconds: number): void;
  queued(value: number): void;
  inFlight(value: number): void;
  configuredConnections(value: number): void;
}

export class PrometheusIndexerTelemetry implements IndexerSchedulerTelemetry {
  readonly registry: Registry;
  private readonly batches: Counter<"status">;
  private readonly events: Counter;
  private readonly lastIndexedBlock: Gauge;
  private readonly blockHeaders: Counter<"purpose">;
  private readonly canonicalMode: Gauge<"mode">;
  private readonly scannedBlocks: Counter;
  private readonly savedAnchors: Counter;
  private readonly fenceFailures: Counter;
  private readonly rollbackBatches: Counter;
  private readonly rollbackBlocks: Counter;
  private readonly duration: Histogram;
  private readonly databaseAdmissionWait: Histogram;
  private readonly databaseOperationDuration: Histogram<"operation">;
  private readonly databaseQueued: Gauge;
  private readonly databaseInFlight: Gauge;
  private readonly databaseConfiguredConnections: Gauge;
  private readonly batchListeners = new Set<(result: BatchResult) => void>();

  constructor(registry = new Registry()) {
    this.registry = registry;
    collectDefaultMetrics({
      register: registry,
      prefix: "cpredict_indexer_",
      eventLoopMonitoringPrecision: 10,
    });
    this.batches = new Counter({
      name: "cpredict_indexer_batches_total",
      help: "Indexer scheduler outcomes",
      labelNames: ["status"],
      registers: [registry],
    });
    this.events = new Counter({
      name: "cpredict_indexer_events_total",
      help: "Canonical events committed by the indexer",
      registers: [registry],
    });
    this.lastIndexedBlock = new Gauge({
      name: "cpredict_indexer_last_indexed_block",
      help: "Last block committed by the indexer",
      registers: [registry],
    });
    this.blockHeaders = new Counter({
      name: "cpredict_indexer_block_headers_total",
      help: "Canonical block header reads by bounded purpose",
      labelNames: ["purpose"],
      registers: [registry],
    });
    this.canonicalMode = new Gauge({
      name: "cpredict_indexer_canonical_mode",
      help: "Effective canonical scan mode (one active mode per indexer process)",
      labelNames: ["mode"],
      registers: [registry],
    });
    this.scannedBlocks = new Counter({
      name: "cpredict_indexer_scanned_blocks_total",
      help: "Block numbers covered by committed scan ranges",
      registers: [registry],
    });
    this.savedAnchors = new Counter({
      name: "cpredict_indexer_saved_anchors_total",
      help: "Canonical anchors persisted by committed scan ranges",
      registers: [registry],
    });
    this.fenceFailures = new Counter({
      name: "cpredict_indexer_fence_failures_total",
      help: "Batches rejected because a canonical stability fence changed",
      registers: [registry],
    });
    this.rollbackBatches = new Counter({
      name: "cpredict_indexer_rollback_batches_total",
      help: "Committed scan ranges removed during reorganization recovery",
      registers: [registry],
    });
    this.rollbackBlocks = new Counter({
      name: "cpredict_indexer_rollback_blocks_total",
      help: "Indexed block numbers removed during reorganization recovery",
      registers: [registry],
    });
    this.duration = new Histogram({
      name: "cpredict_indexer_tick_seconds",
      help: "Bounded ingestion tick duration",
      registers: [registry],
    });
    this.databaseAdmissionWait = new Histogram({
      name: "cpredict_indexer_db_admission_wait_seconds",
      help: "Wait before a top-level indexer database operation enters the application pool admission gate",
      buckets: [
        0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.3, 0.75, 1, 2,
        5,
      ],
      registers: [registry],
    });
    this.databaseOperationDuration = new Histogram({
      name: "cpredict_indexer_db_operation_duration_seconds",
      help: "End-to-end duration of a bounded top-level indexer database operation after admission",
      labelNames: ["operation"],
      buckets: [
        0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.3, 0.75, 1, 2,
        5,
      ],
      registers: [registry],
    });
    this.databaseQueued = new Gauge({
      name: "cpredict_indexer_db_operations_queued",
      help: "Top-level database operations waiting at the application pool admission gate",
      registers: [registry],
    });
    this.databaseInFlight = new Gauge({
      name: "cpredict_indexer_db_operations_in_flight",
      help: "Top-level database operations admitted against the configured PostgreSQL connection budget",
      registers: [registry],
    });
    this.databaseConfiguredConnections = new Gauge({
      name: "cpredict_indexer_db_configured_connections",
      help: "Configured PostgreSQL connection and application admission limit",
      registers: [registry],
    });
  }

  batch(result: BatchResult): void {
    this.batches.inc({ status: "committed" });
    this.events.inc(result.eventCount);
    this.scannedBlocks.inc(result.blockCount);
    this.savedAnchors.inc(result.anchorCount);
    this.lastIndexedBlock.set(Number(result.toBlock));
    for (const listener of this.batchListeners) {
      try {
        listener(result);
      } catch {
        // Notification fan-out is a read-model hint and must never roll back canonical ingestion.
      }
    }
  }

  setCanonicalMode(mode: "dense" | "sparse"): void {
    this.canonicalMode.set({ mode: "dense" }, mode === "dense" ? 1 : 0);
    this.canonicalMode.set({ mode: "sparse" }, mode === "sparse" ? 1 : 0);
  }

  idle(): void {
    this.batches.inc({ status: "idle" });
  }

  failure(_error: unknown): void {
    this.batches.inc({ status: "failed" });
  }

  tickDuration(seconds: number): void {
    this.duration.observe(seconds);
  }

  readonly database: IndexerDatabaseTelemetry = {
    admissionWait: (seconds) => this.databaseAdmissionWait.observe(seconds),
    operationDuration: (operation, seconds) =>
      this.databaseOperationDuration.observe({ operation }, seconds),
    queued: (value) => this.databaseQueued.set(value),
    inFlight: (value) => this.databaseInFlight.set(value),
    configuredConnections: (value) =>
      this.databaseConfiguredConnections.set(value),
  };

  readonly ingestion: IndexerIngestionTelemetry = {
    blockHeaderRead: (purpose: BlockHeaderReadPurpose) =>
      this.blockHeaders.inc({ purpose }),
    fenceFailure: () => this.fenceFailures.inc(),
    rollback: (batchCount, blockCount) => {
      this.rollbackBatches.inc(batchCount);
      this.rollbackBlocks.inc(Number(blockCount));
    },
  };

  subscribeToBatches(listener: (result: BatchResult) => void): () => void {
    this.batchListeners.add(listener);
    return () => this.batchListeners.delete(listener);
  }
}
