import { pathToFileURL } from "node:url";
import { parseTerminalWorkerConfig } from "./config.js";
import {
  loadTerminalWorkerRuntimeAdapters,
  startTerminalWorkerRuntime,
  type TerminalWorkerRuntime,
} from "./runtime.js";

export async function startTerminalWorkerService(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<TerminalWorkerRuntime> {
  const config = parseTerminalWorkerConfig(environment);
  const adapters = await loadTerminalWorkerRuntimeAdapters(
    config.adapterModule,
    config,
  );
  return startTerminalWorkerRuntime(config, adapters);
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  let runtime: TerminalWorkerRuntime | undefined;
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
    runtime = await startTerminalWorkerService();
    if (shutdownRequested) await runtime.stop();
  } catch {
    // Provider and remote-signer errors may contain credentials or transaction data.
    process.stderr.write("terminal worker failed to start\n");
    process.exitCode = 1;
  }
}
