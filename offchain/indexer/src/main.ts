import { pathToFileURL } from "node:url";
import { parseIndexerServiceConfig } from "./config.js";
import { startIndexerRuntime, type IndexerRuntime } from "./runtime.js";

export async function startIndexerService(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<IndexerRuntime> {
  return startIndexerRuntime(parseIndexerServiceConfig(environment));
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  await runIndexerServiceProcess();
}

/** Process lifecycle shared by the production entry and the legacy api-main alias. */
export async function runIndexerServiceProcess(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  let runtime: IndexerRuntime | undefined;
  let shutdownRequested = false;
  const shutdown = async (): Promise<void> => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    try {
      await runtime?.stop();
    } finally {
      process.exitCode = 0;
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  try {
    runtime = await startIndexerService(environment);
    if (shutdownRequested) await runtime.stop();
  } catch (error: unknown) {
    // RPC and PostgreSQL errors can contain credentials. Detailed diagnostics belong in provider
    // logs; startup output is deliberately generic and fail-closed.
    const detail =
      error instanceof Error &&
      /^(?:indexer startup stage failed: (rpc-chain|database|initial-sync|http-listen)|indexer sync stage failed: (reconcile|checkpoint-read|chain-head|discovery-logs|registered-markets|event-logs|canonical-blocks|batch-write))$/.test(
        error.message,
      )
        ? ` (${error.message})`
        : "";
    process.stderr.write(`indexer service failed to start${detail}\n`);
    process.exitCode = 1;
  }
}
