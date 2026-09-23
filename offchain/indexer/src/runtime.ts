import { reconcileConfirmedOperations } from "./operation-reconciliation.js";
import { Counter, Gauge } from "prom-client";
import { type PublicClient } from "viem";
import { createIndexerClient, closeIndexerClient } from "./rpc-client.js";
import { createIndexerApi } from "./api.js";
import type { IndexerServiceConfig } from "./config.js";
import { ChainIndexer } from "./indexer.js";
import { InstrumentedEventQueryStore } from "./instrumented-store.js";
import { PostgresEventStore } from "./postgres-store.js";
import { BoundedIndexerScheduler } from "./scheduler.js";
import { PrometheusIndexerTelemetry } from "./telemetry.js";
import { IndexerWebSocketHub } from "./websocket.js";
import { readFile } from "node:fs/promises";
import { environmentSchema, sameAddress } from "../../app-core/src/contracts.js";
import { verifyDeployment } from "../../app-service/src/chain.js";
import { refreshPublicMetadata } from "./public-catalog.js";
import { Leaderboards } from "./leaderboards.js";
import { appRuntimeSchema } from "../../app-service/src/config.js";

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
  const publicRuntime=config.publicConfigFile?appRuntimeSchema.parse(JSON.parse(await readFile(config.publicConfigFile,"utf8"))):undefined;
  const environment=publicRuntime?.environment;
  if(environment) {
    if(!config.metadataUrl)throw new Error("public indexer requires CPREDICT_INDEXER_METADATA_URL");
    const d=environment.deployment,expected=[d.factory,d.marketplace,d.feeVault,d.bondEscrow].map(a=>a.toLowerCase()).sort(),actual=config.coreAddresses.map(a=>a.toLowerCase()).sort();
    if(d.chainId!==config.chainId || !sameAddress(d.factory,config.factoryAddress) || BigInt(d.deploymentBlock)!==config.deploymentBlock || JSON.stringify(expected)!==JSON.stringify(actual)) throw new Error("public indexer configuration does not match deployment manifest");
  }
  const telemetry = dependencies.telemetry ?? new PrometheusIndexerTelemetry();
  telemetry.setCanonicalMode(config.canonicalMode);
  const client = dependencies.client ?? await createIndexerClient(config, telemetry.registry);
  const rawStore =
    dependencies.store ??
    new PostgresEventStore(config.databaseUrl, config.databasePoolSize,environment);
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
  const backfill = async () => {
    await rawStore.backfillFinancialAccounts(
      client,
      () => telemetry.ingestion.blockHeaderRead("backfill"),
    );
  };
  const indexer = new ChainIndexer(client, store, {
    chainId: config.chainId,
    deploymentBlock: config.deploymentBlock,
    confirmations: config.confirmations,
    batchSize: config.batchSize,
    blockConcurrency: config.blockConcurrency,
    canonicalMode: config.canonicalMode,
    telemetry: telemetry.ingestion,
    addresses: config.coreAddresses,
    factoryAddress: config.factoryAddress,
    protocol: environment?.deployment.protocolVersion ?? "time-v2",
    ...(rawStore.financial?{financial:{paymentToken:rawStore.financial.environment.deployment.paymentToken,accounts:()=>rawStore.financial!.trackedAccounts(),scanned:(accounts:readonly import("viem").Address[],from:bigint,to:bigint,hash:import("viem").Hex)=>rawStore.financial!.accountScanned(accounts,from,to,hash),backfill}}:{}),
  });
  const scheduler = new BoundedIndexerScheduler(indexer, telemetry, {
    intervalMs: config.pollIntervalMs,
    caughtUpIntervalMs: config.caughtUpPollMs,
    jitterRatio: 0.1,
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
    trustedProxies: publicRuntime?.trustedProxies ?? [],
    readiness,
    syncStatus,
    registry: telemetry.registry,
    logLevel: config.logLevel,
    maxConnections: config.httpMaxConnections,
    websocket,
    ...(rawStore.financial?{financial:{ledger:rawStore.financial,client,confirmations:config.confirmations}}:{}),
  });

  try {
    const rpcChainId = await startupStage("rpc-chain", () => client.getChainId());
    if (rpcChainId !== config.chainId)
      throw new Error("RPC chainId does not match indexer config");
    await startupStage("database", () => store.ready());
    if(rawStore.financial)await startupStage("database",async()=>{
      const sql=rawStore.financial!.sql;
      if(!(await sql`SELECT to_regclass('ledger_operation_receipts') AS name`)[0]?.name)
        throw new Error("operation receipt migration required");
    });
    if(environment) await verifyDeployment(client,environment);
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
    closeIndexerClient(client);
    unsubscribeFromBatches();
    await scheduler.stop();
    await app.close();
    await store.close();
    throw error;
  }

  let stopped = false;
  let receiptTimer: ReturnType<typeof setTimeout> | undefined;
  let receiptTick: Promise<void> | undefined;
  if(rawStore.financial){
    const outcomes=new Counter({name:"cpredict_indexer_receipt_checks_total",help:"Confirmed operation receipt reconciliation outcomes",labelNames:["status"],registers:[telemetry.registry]});
    const pending=new Gauge({name:"cpredict_indexer_receipt_pending",help:"Confirmed operations awaiting initial receipt verification",registers:[telemetry.registry]});
    const unresolved=new Gauge({name:"cpredict_indexer_receipt_unresolved",help:"Operations whose latest receipt verification failed",registers:[telemetry.registry]});
    const lastSuccess=new Gauge({name:"cpredict_indexer_receipt_last_run_timestamp_seconds",help:"Last completed receipt reconciliation round",registers:[telemetry.registry]});
    const run=async()=>{
      let delay=15000;
      try{
        const r=await reconcileConfirmedOperations(rawStore,client);
        outcomes.inc({status:"verified"},r.checked-r.repaired-r.errors);
        outcomes.inc({status:"repaired"},r.repaired);outcomes.inc({status:"error"},r.errors);
        pending.set(r.pending);unresolved.set(r.unresolved);lastSuccess.set(Date.now()/1000);
        if(r.pending>0)delay=1000;
        if(r.errors || r.repaired)app.log.warn(r,"confirmed operation receipt reconciliation");
      }catch{outcomes.inc({status:"error"});app.log.warn("confirmed operation receipt reconciliation unavailable");}
      if(!stopped){receiptTimer=setTimeout(()=>{receiptTick=run();},delay);receiptTimer.unref();}
    };
    receiptTick=run();
  }
  let publicTimer: ReturnType<typeof setTimeout> | undefined;
  let publicTick: Promise<void> | undefined;
  if(rawStore.financial && config.metadataUrl){
    const ledger=rawStore.financial,metadataUrl=config.metadataUrl,leaderboards=new Leaderboards(
      ledger,
      client,
      () => telemetry.ingestion.blockHeaderRead("time_lookup"),
    );
    let refreshLeaderboards=true;
    const run=async()=>{
      try{await refreshPublicMetadata(ledger,metadataUrl);}catch{app.log.warn("public metadata catalog refresh unavailable");}
      if(refreshLeaderboards && ledger.environment.features.leaderboard){
        try{const periods=await leaderboards.periods();for(const period of periods.slice(0,5)){try{await leaderboards.publish(period.id);}catch{/* Unreconciled, incomplete or not-yet-started periods stay unpublished. */}}}catch{app.log.warn("leaderboard refresh unavailable");}
      }
      refreshLeaderboards=!refreshLeaderboards;
      if(!stopped){publicTimer=setTimeout(()=>{publicTick=run();},30000);publicTimer.unref();}
    };
    publicTick=run();
  }
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      closeIndexerClient(client);
      if(publicTimer)clearTimeout(publicTimer);
      if(receiptTimer)clearTimeout(receiptTimer);
      unsubscribeFromBatches();
      await scheduler.stop();
      await app.close();
      await publicTick;
      await receiptTick;
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
