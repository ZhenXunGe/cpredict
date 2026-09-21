import { RpcReadPool } from "../../app-core/src/rpc-pool.js";
import type { Registry } from "prom-client";
import { createPublicClient, custom, http, type PublicClient } from "viem";
import type { IndexerServiceConfig } from "./config.js";

const pools = new WeakMap<PublicClient, RpcReadPool>();
export function closeIndexerClient(client: PublicClient) {
  pools.get(client)?.close();
}

/** Separate range-log capacity from historical state/header reads when configured. */
export async function createIndexerClient(
  config: Pick<
    IndexerServiceConfig,
    "rpcUrl" | "logRpcUrl" | "rpcTimeoutMs" | "chainId" | "rpcFallback"
  >,
  registry?: Registry,
): Promise<PublicClient> {
  if (config.rpcFallback) {
    const pool = new RpcReadPool({
      url: config.rpcUrl,
      logUrl: config.logRpcUrl,
      chainId: config.chainId,
      timeoutMs: config.rpcTimeoutMs,
      fallback: config.rpcFallback,
      registry,
      service: "indexer",
    });
    try {
      await pool.start();
    } catch (e) {
      pool.close();
      throw e;
    }
    const client = createPublicClient({ transport: pool.transport });
    pools.set(client, pool);
    return client;
  }
  const options = {
    retryCount: 2,
    retryDelay: 750,
    timeout: config.rpcTimeoutMs,
  };
  const reads = createPublicClient({ transport: http(config.rpcUrl, options) });
  if (!config.logRpcUrl || config.logRpcUrl === config.rpcUrl) return reads;
  const logs = createPublicClient({
    transport: http(config.logRpcUrl, options),
  });
  if ((await logs.getChainId()) !== config.chainId)
    throw new Error("log RPC chainId does not match indexer config");
  return createPublicClient({
    transport: custom(
      {
        request: (args) =>
          (args.method === "eth_getLogs" ? logs : reads).request(args),
      },
      { retryCount: 0 },
    ),
  });
}
