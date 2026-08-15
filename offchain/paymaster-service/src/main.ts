import { pathToFileURL } from "node:url";
import { parseSponsorServiceConfig } from "./config.js";
import { createSponsorRuntime, loadSponsorRuntimeAdapters } from "./runtime.js";

export async function startSponsorService(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<() => Promise<void>> {
  const config = parseSponsorServiceConfig(environment);
  const adapters = await loadSponsorRuntimeAdapters(
    config.adapterModule,
    config,
  );
  const app = await createSponsorRuntime(config, adapters);
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
    stop = await startSponsorService();
  } catch {
    // Adapter/provider errors can contain request material or KMS metadata. Keep startup output
    // generic; deployment health checks and provider-side audit logs carry the detailed diagnosis.
    process.stderr.write("paymaster service failed to start\n");
    process.exitCode = 1;
  }
}
