import { createPublicClient, http, type PublicClient } from "viem";
import { createIndexerApi } from "./api.js";
import type { IndexerServiceConfig } from "./config.js";
import { ChainIndexer } from "./indexer.js";
import { InstrumentedEventQueryStore } from "./instrumented-store.js";
import { PostgresEventStore } from "./postgres-store.js";
import { BoundedIndexerScheduler } from "./scheduler.js";
import { PrometheusIndexerTelemetry } from "./telemetry.js";
import { IndexerWebSocketHub } from "./websocket.js";

export interface IndexerRuntime {
  stop(): Promise<void>;
}

export interface IndexerRuntimeDependencies {
  client?: PublicClient | undefined;
  store?: PostgresEventStore | undefined;
  telemetry?: PrometheusIndexerTelemetry | undefined;
}

export async function startIndexerRuntime(
  config: IndexerServiceConfig,
  dependencies: IndexerRuntimeDependencies = {},
): Promise<IndexerRuntime> {
  const client =
    dependencies.client ??
    createPublicClient({
      transport: http(config.rpcUrl, {
        retryCount: 0,
        timeout: config.rpcTimeoutMs,
      }),
    });
  const telemetry = dependencies.telemetry ?? new PrometheusIndexerTelemetry();
  const rawStore =
    dependencies.store ??
    new PostgresEventStore(config.databaseUrl, config.databasePoolSize);
  const store = new InstrumentedEventQueryStore(
    rawStore,
    config.databasePoolSize,
    telemetry.database,
  );
  const websocket = new IndexerWebSocketHub(
    {
      chainId: config.chainId,
      maxConnections: config.wsMaxConnections,
      heartbeatIntervalMs: config.wsHeartbeatIntervalMs,
      maxBufferedAmountBytes: config.wsMaxBufferedAmountBytes,
      shutdownGraceMs: config.wsShutdownGraceMs,
    },
    telemetry.registry,
  );
  const unsubscribeFromBatches = telemetry.subscribeToBatches((result) => {
    websocket.publishCheckpoint({
      blockNumber: result.toBlock,
      eventCount: result.eventCount,
    });
  });
  const indexer = new ChainIndexer(client, store, {
    chainId: config.chainId,
    deploymentBlock: config.deploymentBlock,
    confirmations: config.confirmations,
    batchSize: config.batchSize,
    addresses: config.coreAddresses,
    factoryAddress: config.factoryAddress,
  });
  const scheduler = new BoundedIndexerScheduler(indexer, telemetry, {
    intervalMs: config.pollIntervalMs,
    maxBatchesPerTick: config.maxBatchesPerTick,
  });
  const readiness = async (): Promise<void> => {
    const [rpcChainId] = await Promise.all([
      client.getChainId(),
      store.ready(),
    ]);
    if (rpcChainId !== config.chainId)
      throw new Error("RPC chainId does not match indexer config");
    if (!scheduler.isRunning())
      throw new Error("indexer scheduler is not running");
    scheduler.assertHealthy();
  };
  const syncStatus = async (chainId: number) => {
    if (chainId !== config.chainId)
      throw new RangeError("requested chainId does not match indexer config");
    await readiness();
    const [checkpoint, chainHead] = await Promise.all([
      store.checkpoint(chainId),
      client.getBlockNumber(),
    ]);
    return {
      chainId,
      indexedBlock: checkpoint?.blockNumber ?? null,
      safeBlock:
        chainHead < config.confirmations
          ? 0n
          : chainHead - config.confirmations,
    };
  };
  const app = createIndexerApi(store, {
    readiness,
    syncStatus,
    registry: telemetry.registry,
    logLevel: config.logLevel,
    maxConnections: config.httpMaxConnections,
    websocket,
  });

  try {
    const rpcChainId = await startupStage("rpc-chain", () => client.getChainId());
    if (rpcChainId !== config.chainId)
      throw new Error("RPC chainId does not match indexer config");
    await startupStage("database", () => store.ready());
    await startupStage("initial-sync", () => scheduler.runTick());
    scheduler.start();
    await startupStage("http-listen", () =>
      app.listen({
        host: config.host,
        port: config.port,
        backlog: config.listenBacklog,
      }),
    );
  } catch (error: unknown) {
    unsubscribeFromBatches();
    await scheduler.stop();
    await app.close();
    await store.close();
    throw error;
  }

  let stopped = false;
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      unsubscribeFromBatches();
      await scheduler.stop();
      await app.close();
      await store.close();
    },
  };
}

async function startupStage<T>(
  stage: "rpc-chain" | "database" | "initial-sync" | "http-listen",
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      /^indexer sync stage failed: (reconcile|checkpoint-read|chain-head|discovery-logs|registered-markets|event-logs|canonical-blocks|batch-write)$/.test(
        error.message,
      )
    ) {
      throw error;
    }
    // Do not retain the provider error as a cause: RPC and PostgreSQL errors may embed secrets.
    throw new Error(`indexer startup stage failed: ${stage}`);
  }
}
