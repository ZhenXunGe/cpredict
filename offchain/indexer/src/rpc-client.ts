import { createPublicClient, custom, http, type PublicClient } from "viem";
import type { IndexerServiceConfig } from "./config.js";

/** Separate range-log capacity from historical state/header reads when configured. */
export async function createIndexerClient(
  config: Pick<
    IndexerServiceConfig,
    "rpcUrl" | "logRpcUrl" | "rpcTimeoutMs" | "chainId"
  >,
): Promise<PublicClient> {
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
