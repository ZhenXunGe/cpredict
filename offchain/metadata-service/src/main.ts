import { pathToFileURL } from "node:url";
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
  const app = await createMetadataServer({ config, store });
  try {
    await store.ready();
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await store.close();
    throw error;
  }
  return async () => {
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
