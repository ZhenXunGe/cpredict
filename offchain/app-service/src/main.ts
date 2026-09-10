import { pathToFileURL } from "node:url";
import { createPublicClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { environmentKey } from "../../app-core/src/contracts.js";
import { PrivyIdentityVerifier } from "./auth.js";
import { ProtocolAdmissionReader, verifyDeployment } from "./chain.js";
import { loadServiceConfig } from "./config.js";
import { AuthenticatedAAGateway } from "./gateway.js";
import { ProviderRpc, type RpcTransport } from "./http.js";
import { OperationService } from "./operations.js";
import { PostgresApplicationStore } from "./postgres-store.js";
import { OperationRecovery } from "./recovery.js";
import { createApplicationServer } from "./server.js";
import { PostgresReports } from "./reports.js";

export async function startApplicationService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<() => Promise<void>> {
  const config = await loadServiceConfig(env),
    runtime = config.runtime;
  const client = createPublicClient({
    chain: arbitrumSepolia,
    transport: http(config.rpcUrl, { timeout: 8_000, retryCount: 0 }),
  });
  const store = new PostgresApplicationStore(
    config.databaseUrl,
    environmentKey(runtime.environment),
    runtime.environment.deployment.deploymentBlock,
  );
  const reports = new PostgresReports(
    config.databaseUrl,
    runtime.environment,
    runtime.sponsor,
  );
  const unavailable: RpcTransport = {
    async request() {
      throw new Error("provider not configured");
    },
  };
  const bundler = config.bundlerUrl
    ? new ProviderRpc(config.bundlerUrl)
    : unavailable;
  const paymaster = config.paymasterUrl
    ? new ProviderRpc(config.paymasterUrl)
    : unavailable;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let activeTick: Promise<void> | undefined;
  try {
    await store.ready();
    await verifyDeployment(client, runtime.environment);
    const operations = new OperationService(
      runtime,
      store,
      client,
      new ProtocolAdmissionReader(
        client,
        runtime.environment,
        config.metadataUrl,
      ),
    );
    const recovery = new OperationRecovery(
      store,
      client,
      bundler,
      runtime.confirmations,
    );
    const app = await createApplicationServer({
      operations,
      recovery,
      auth: new PrivyIdentityVerifier(
        runtime.environment.privyAppId,
        config.privySecret,
      ),
      gateway: new AuthenticatedAAGateway(operations, bundler, paymaster),
      chainRpc: new ProviderRpc(config.rpcUrl),
      reports,
    });
    await app.listen({ host: config.host, port: config.port });
    const tick = async () => {
      try {
        await recovery.tick();
      } catch {
        app.log.warn("operation reconciliation unavailable");
      }
      if (!stopped) {
        timer = setTimeout(() => {
          activeTick = tick();
        }, 10_000);
        timer.unref();
      }
    };
    activeTick = tick();
    return async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await app.close();
      await activeTick;
      await reports.close();
      await store.close();
    };
  } catch (error) {
    await reports.close();
    await store.close();
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let stop: (() => Promise<void>) | undefined;
  process.once("SIGINT", () => {
    void stop?.();
  });
  process.once("SIGTERM", () => {
    void stop?.();
  });
  startApplicationService()
    .then((value) => {
      stop = value;
    })
    .catch(() => {
      process.stderr.write(
        "application service configuration or startup verification failed\n",
      );
      process.exitCode = 1;
    });
}
