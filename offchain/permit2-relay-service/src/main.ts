import { pathToFileURL } from "node:url";
import { parsePermit2RelayServiceConfig } from "./config.js";
import {
  createPermit2RelayRuntime,
  loadPermit2RelaySender,
} from "./runtime.js";

export async function startPermit2RelayService(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<() => Promise<void>> {
  const config = parsePermit2RelayServiceConfig(environment);
  const sender = await loadPermit2RelaySender(config.adapterModule, config);
  const app = await createPermit2RelayRuntime(config, sender);
  await app.listen({ host: config.host, port: config.port });
  return async () => app.close();
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  let stop: (() => Promise<void>) | undefined;
  const shutdown = async (): Promise<void> => {
    if (stop !== undefined) await stop();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  try {
    stop = await startPermit2RelayService();
  } catch {
    process.stderr.write("Permit2 relay service failed to start\n");
    process.exitCode = 1;
  }
}
