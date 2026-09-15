import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createIndexerClient } from "../src/rpc-client.js";
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function endpoint(
  handler: (method: string) => { result?: unknown; status?: number },
) {
  const methods: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    methods.push(input.method);
    const response = handler(input.method);
    res.writeHead(response.status ?? 200, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify({ jsonrpc: "2.0", id: input.id, result: response.result }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("test listen failed");
  return { url: `http://127.0.0.1:${address.port}`, methods };
}
describe("indexer RPC routing", () => {
  it("routes only logs to the range provider and keeps state/header reads on the primary", async () => {
    const read = await endpoint((method) => ({
      result: method === "eth_blockNumber" ? "0x10" : "0x",
    }));
    const logs = await endpoint((method) => ({
      result: method === "eth_chainId" ? "0x66eee" : [],
    }));
    const client = await createIndexerClient({
      rpcUrl: read.url,
      logRpcUrl: logs.url,
      rpcTimeoutMs: 1000,
      chainId: 421614,
    });
    expect(await client.getBlockNumber()).toBe(16n);
    expect(await client.getLogs({ fromBlock: 1n, toBlock: 100n })).toEqual([]);
    await client.call({
      to: "0x0000000000000000000000000000000000000001",
      data: "0x",
    });
    expect(read.methods).toEqual(["eth_blockNumber", "eth_call"]);
    expect(logs.methods).toEqual(["eth_chainId", "eth_getLogs"]);
  });
  it("rejects a log endpoint on another chain before ingesting its logs", async () => {
    const logs = await endpoint(() => ({ result: "0x1" }));
    await expect(
      createIndexerClient({
        rpcUrl: logs.url + "/read",
        logRpcUrl: logs.url,
        rpcTimeoutMs: 1000,
        chainId: 421614,
      }),
    ).rejects.toThrow("chainId");
    expect(logs.methods).toEqual(["eth_chainId"]);
  });
  it("retries transient throttling and bounds persistent failures", async () => {
    let attempts = 0;
    const read = await endpoint(() =>
      ++attempts === 1 ? { status: 429 } : { result: "0x10" },
    );
    const client = await createIndexerClient({
      rpcUrl: read.url,
      rpcTimeoutMs: 1000,
      chainId: 421614,
    });
    expect(await client.getBlockNumber()).toBe(16n);
    expect(attempts).toBe(2);
    const failed = await endpoint(() => ({ status: 429 }));
    const unavailable = await createIndexerClient({
      rpcUrl: failed.url,
      rpcTimeoutMs: 1000,
      chainId: 421614,
    });
    await expect(unavailable.getBlockNumber()).rejects.toThrow();
    expect(failed.methods).toHaveLength(3);
  });
});
