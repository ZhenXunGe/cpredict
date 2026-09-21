import { automaticClaimsSettings } from "./automatic-claims.js";
import {
  RpcReadPool,
  RpcResponseError,
  parseRpcFallbackConfig,
} from "../../app-core/src/rpc-pool.js";
import { AppError } from "../../app-core/src/contracts.js";
import type { Hex } from "viem";
import { pathToFileURL } from "node:url";
import { createPublicClient } from "viem";
import { arbitrumSepolia } from "viem/chains";
import { environmentKey } from "../../app-core/src/contracts.js";
import { PrivyIdentityVerifier } from "./auth.js";
import { ProtocolAdmissionReader, verifyDeployment } from "./chain.js";
import { loadServiceConfig } from "./config.js";
import { AuthenticatedAAGateway } from "./gateway.js";
import { ProviderRpc, ProviderCallError, type RpcTransport } from "./http.js";
import { OperationService } from "./operations.js";
import { PostgresApplicationStore } from "./postgres-store.js";
import { OperationRecovery } from "./recovery.js";
import { createApplicationServer } from "./server.js";
import { PostgresReports } from "./reports.js";
import { ApplicationMetrics } from "./metrics.js";
import { ZeroDevManagementReader } from "./provider-management.js";

export async function startApplicationService(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<() => Promise<void>> {
  const config = await loadServiceConfig(env),
    runtime = config.runtime;
  const claims=runtime.environment.features.automaticClaims
    ? automaticClaimsSettings(config.automationDatabaseUrl!,runtime.environment.deployment.chainId,runtime.environment.deployment.id):undefined;
  const metrics = new ApplicationMetrics();
  const management = config.management
    ? new ZeroDevManagementReader(config.management, (ok) =>
        metrics.observeDependency("management", ok),
      )
    : undefined;
  const rpcPool = new RpcReadPool({
    url: config.rpcUrl,
    chainId: runtime.environment.deployment.chainId,
    timeoutMs: 8_000,
    service: "app",
    fallback: parseRpcFallbackConfig(env),
    registry: metrics.registry,
    observe: (ok) => metrics.observeDependency("chain", ok),
  });
  const client = createPublicClient({
    chain: arbitrumSepolia,
    transport: rpcPool.transport,
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
    ? new ProviderRpc(config.bundlerUrl, (ok) =>
        metrics.observeDependency("bundler", ok),
      )
    : unavailable;
  const paymaster = config.paymasterUrl
    ? new ProviderRpc(config.paymasterUrl, (ok) =>
        metrics.observeDependency("paymaster", ok),
      )
    : unavailable;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let activeTick: Promise<void> | undefined;
  try {
    await rpcPool.start();
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
      ...(claims ? {automaticClaims:claims.store}:{}),
      operations,
      recovery,
      auth: new PrivyIdentityVerifier(
        runtime.environment.privyAppId,
        config.privySecret,
      ),
      gateway: new AuthenticatedAAGateway(operations, bundler, paymaster),
      rpcPool,
      chainRpc: {
        async request(method, params, signal) {
          try {
            return await rpcPool.request(method, params, signal ? { signal } : {});
          } catch (e) {
            if (
              e instanceof RpcResponseError &&
              method === "eth_call" &&
              typeof e.data === "string"
            )
              throw new ProviderCallError(e.code, e.data as Hex);
            throw new AppError("provider_rejected", 503);
          }
        },
      },
      reports,
      metrics,
      ...(management ? { management } : {}),
    });
    await app.listen({ host: config.host, port: config.port });
    management?.start();
    const observe = async () => {
      const [sample, head] = await Promise.allSettled([
        reports.monitor(),
        client.getBlockNumber(),
      ]);
      metrics.observeDependency("database", sample.status === "fulfilled");
      metrics.observeDependency("chain", head.status === "fulfilled");
      if (sample.status === "fulfilled")
        metrics.observeState(
          sample.value,
          head.status === "fulfilled" ? head.value : null,
        );
    };
    const tick = async () => {
      await Promise.all([
        recovery
          .tick(() => stopped)
          .then((result) => metrics.recoveryResults(result))
          .catch(() => {
            metrics.failure("recovery_query_unavailable");
            app.log.warn("operation reconciliation unavailable");
          }),
        observe(),
      ]);
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
      rpcPool.close();
      if (timer) clearTimeout(timer);
      await management?.stop();
      await app.close();
      await activeTick;
      await claims?.close();
      await reports.close();
      await store.close();
    };
  } catch (error) {
    await claims?.close();
    rpcPool.close();
    await management?.stop();
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
