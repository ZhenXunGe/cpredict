import {
  RpcReadPool,
  parseRpcFallbackConfig,
} from "../../app-core/src/rpc-pool.js";
import { Registry } from "prom-client";
import { pathToFileURL } from "node:url";
import { createPublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { parseMetadataServiceConfig } from "./config.js";
import { PostgresMetadataStore } from "./postgres-store.js";
import { createMetadataServer } from "./server.js";

export async function startMetadataService(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<() => Promise<void>> {
  const config = parseMetadataServiceConfig(environment);
  const store = new PostgresMetadataStore(
    config.databaseUrl,
    config.databasePoolSize,
  );
  const registry = new Registry();
  const rpcPool = config.rpcUrl
    ? new RpcReadPool({
        url: config.rpcUrl,
        chainId: config.chainId,
        timeoutMs: 4_000,
        service: "metadata",
        capabilities: ["read", "history"],
        fallback: parseRpcFallbackConfig(environment),
        registry,
      })
    : undefined;
  const signatureClient =
    config.rpcUrl === undefined
      ? undefined
      : createPublicClient({
          chain: arbitrumSepolia,
          transport: rpcPool!.transport,
        });
  const app = await createMetadataServer({
    config,
    store,
    signatureClient,
    registry,
  });
  try {
    await rpcPool?.start();
    await store.ready();
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    rpcPool?.close();
    await store.close();
    throw error;
  }
  return async () => {
    rpcPool?.close();
    await app.close();
    await store.close();
  };
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  let stop: (() => Promise<void>) | undefined;
  const shutdown = async () => stop?.();
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  try {
    stop = await startMetadataService();
  } catch {
    process.stderr.write("metadata service failed to start\n");
    process.exitCode = 1;
  }
}
