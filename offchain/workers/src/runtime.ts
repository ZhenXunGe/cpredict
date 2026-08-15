import type { Sql } from "postgres";
import type { Registry } from "prom-client";
import type { Address, PublicClient, WalletClient } from "viem";
import type { TerminalWorkerServiceConfig } from "./config.js";
import { IndexerTerminalMarketSource } from "./indexer-source.js";
import { PostgresTerminalWorkerState } from "./postgres-state.js";
import { createTerminalWorkerServer } from "./server.js";
import {
  TerminalWorker,
  TerminalWorkerScheduler,
  type TerminalWorkerTelemetry,
} from "./terminal-workers.js";

export interface TerminalWorkerRuntimeAdapters {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  sql: Sql;
  telemetry: TerminalWorkerTelemetry;
  registry: Registry;
  /** Checks provider, database, remote signer and telemetry exporter dependencies. */
  ready(): Promise<void>;
  /** Closes signer/provider/database resources owned by the deployment adapter. */
  close(): Promise<void>;
}

export interface TerminalWorkerAdapterModule {
  createTerminalWorkerRuntimeAdapters(
    config: TerminalWorkerServiceConfig,
  ): Promise<TerminalWorkerRuntimeAdapters>;
}

export interface TerminalWorkerRuntime {
  stop(): Promise<void>;
}

export async function loadTerminalWorkerRuntimeAdapters(
  moduleUrl: string,
  config: TerminalWorkerServiceConfig,
): Promise<TerminalWorkerRuntimeAdapters> {
  const loaded: unknown = await import(moduleUrl);
  if (!isAdapterModule(loaded))
    throw new TypeError("worker adapter module has no supported factory");
  const adapters = await loaded.createTerminalWorkerRuntimeAdapters(config);
  assertRuntimeAdapters(adapters);
  return adapters;
}

export async function preflightTerminalWorker(
  config: TerminalWorkerServiceConfig,
  adapters: TerminalWorkerRuntimeAdapters,
): Promise<void> {
  if (adapters.account.toLowerCase() !== config.expectedAccount.toLowerCase()) {
    throw new Error("worker signer does not match expected account");
  }
  const [chainId, tables] = await Promise.all([
    adapters.publicClient.getChainId(),
    adapters.sql<Array<{ terminal_worker_attempts: string | null }>>`
      SELECT to_regclass('terminal_worker_attempts')::text AS terminal_worker_attempts
    `,
    adapters.ready(),
  ]);
  if (chainId !== config.chainId)
    throw new Error("worker RPC chainId does not match config");
  if (tables[0]?.terminal_worker_attempts === null || tables[0] === undefined) {
    throw new Error("terminal worker database migration is not applied");
  }
}

export async function startTerminalWorkerRuntime(
  config: TerminalWorkerServiceConfig,
  adapters: TerminalWorkerRuntimeAdapters,
): Promise<TerminalWorkerRuntime> {
  const source = new IndexerTerminalMarketSource(
    config.indexerUrl,
    config.chainId,
    fetch,
    config.indexerMaxPages,
    config.indexerTimeoutMs,
  );
  const state = new PostgresTerminalWorkerState(adapters.sql, config.chainId);
  const worker = new TerminalWorker(
    adapters.publicClient,
    adapters.walletClient,
    adapters.account,
    config.bondEscrow,
    config.exposureGuard,
    source,
    state,
    adapters.telemetry,
  );
  const scheduler = new TerminalWorkerScheduler(
    adapters.publicClient,
    worker,
    adapters.telemetry,
  );
  const readiness = async (): Promise<void> => {
    if (!scheduler.isRunning())
      throw new Error("terminal worker scheduler is not running");
    await preflightTerminalWorker(config, adapters);
  };
  const app = createTerminalWorkerServer({
    readiness,
    registry: adapters.registry,
    logLevel: config.logLevel,
  });
  try {
    await preflightTerminalWorker(config, adapters);
    await app.listen({ host: config.host, port: config.port });
    scheduler.start();
  } catch (error: unknown) {
    await scheduler.stop();
    await app.close();
    await adapters.close();
    throw error;
  }

  let stopped = false;
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await scheduler.stop();
      await app.close();
      await adapters.close();
    },
  };
}

function isAdapterModule(value: unknown): value is TerminalWorkerAdapterModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "createTerminalWorkerRuntimeAdapters" in value &&
    typeof value.createTerminalWorkerRuntimeAdapters === "function"
  );
}

function assertRuntimeAdapters(
  value: unknown,
): asserts value is TerminalWorkerRuntimeAdapters {
  if (typeof value !== "object" || value === null)
    throw new TypeError("worker adapters are invalid");
  const candidate = value as Partial<TerminalWorkerRuntimeAdapters>;
  if (
    typeof candidate.account !== "string" ||
    typeof candidate.sql !== "function" ||
    typeof candidate.ready !== "function" ||
    typeof candidate.close !== "function" ||
    typeof candidate.publicClient?.getChainId !== "function" ||
    typeof candidate.publicClient?.watchBlockNumber !== "function" ||
    typeof candidate.walletClient?.writeContract !== "function" ||
    typeof candidate.telemetry?.record !== "function" ||
    typeof candidate.telemetry?.unexpected !== "function" ||
    typeof candidate.registry?.metrics !== "function"
  ) {
    throw new TypeError("worker adapters are invalid");
  }
}
