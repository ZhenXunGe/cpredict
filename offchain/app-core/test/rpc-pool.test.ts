import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { Registry } from "prom-client";
import {
  RpcReadPool,
  RpcResponseError,
  parseRpcFallbackConfig,
  type RpcProbe,
} from "../src/rpc-pool.js";
const probe: RpcProbe = {
  logBlockSpan: 100,
  blockNumber: "0x10",
  blockHash: `0x${"1".repeat(64)}`,
  transactionHash: `0x${"2".repeat(64)}`,
  receiptBlockNumber: "0x110",
  receiptBlockHash: `0x${"3".repeat(64)}`,
  logAddress: `0x${"4".repeat(40)}`,
  logIndex: "0x0",
};
const pools: RpcReadPool[] = [],
  servers: Server[] = [];
afterEach(async () => {
  pools.splice(0).forEach((p) => p.close());
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});
type Mode =
  | "ok"
  | "429"
  | "quota"
  | "500"
  | "disconnect"
  | "hang"
  | "revert"
  | "bad"
  | "chain"
  | "stale"
  | "archive"
  | "null"
  | "fork"
  | "log_limit"
  | "invalid_params";
async function fixture() {
  let clock = 1_000_000;
  const modes: Record<string, Mode> = {
    alchemy: "ok",
    ankr: "ok",
    drpc: "ok",
    official: "ok",
  };
  const calls: { name: string; method: string }[] = [];
  const logWidths: number[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    const input = JSON.parse(text),
      name = req.url!.slice(1),
      mode = modes[name];
    calls.push({ name, method: input.method });
    if (
      input.method === "eth_getLogs" &&
      /^0x[0-9a-f]+$/i.test(input.params[0]?.fromBlock) &&
      /^0x[0-9a-f]+$/i.test(input.params[0]?.toBlock)
    )
      logWidths.push(
        Number(
          BigInt(input.params[0].toBlock) -
            BigInt(input.params[0].fromBlock) +
            1n,
        ),
      );
    if (mode === "hang") return;
    if (mode === "disconnect") return req.socket.destroy();
    if (mode === "bad") {
      res.end("not json with private secret");
      return;
    }
    if (mode === "500") {
      res.writeHead(503);
      res.end("unavailable");
      return;
    }
    if (mode === "429") {
      res.writeHead(429, { "retry-after": "120" });
      res.end(
        JSON.stringify({
          error: { code: 429, message: "too many requests private-url" },
        }),
      );
      return;
    }
    if (mode === "quota") {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: input.id,
          error: {
            code: -32000,
            message: "Monthly capacity limit exceeded private-secret",
          },
        }),
      );
      return;
    }
    if (mode === "revert" && input.method === "eth_call") {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: input.id,
          error: {
            code: 3,
            message: "revert https://private-key",
            data: "0x1234",
          },
        }),
      );
      return;
    }
    if (mode === "archive" && input.method === "eth_getBlockByNumber") {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: input.id,
          error: { code: -32000, message: "missing trie node" },
        }),
      );
      return;
    }
    if (
      input.method === "eth_getLogs" &&
      (mode === "log_limit" || mode === "invalid_params")
    ) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: input.id,
          error: {
            code: mode === "log_limit" ? -32600 : -32602,
            message:
              mode === "log_limit"
                ? "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range"
                : "invalid argument: fromBlock",
          },
        }),
      );
      return;
    }
    const result =
      input.method === "eth_chainId"
        ? mode === "chain"
          ? "0x1"
          : "0x66eee"
        : input.method === "eth_blockNumber"
          ? mode === "stale"
            ? "0x18"
            : "0x100"
          : input.method === "eth_getBlockByNumber"
            ? {
                number: probe.blockNumber,
                hash: mode === "fork" ? `0x${"5".repeat(64)}` : probe.blockHash,
              }
            : input.method === "eth_getTransactionReceipt"
              ? mode === "null"
                ? null
                : {
                    transactionHash: probe.transactionHash,
                    blockNumber: probe.receiptBlockNumber,
                    blockHash: probe.receiptBlockHash,
                  }
              : input.method === "eth_getLogs"
                ? [
                    {
                      transactionHash: probe.transactionHash,
                      blockHash: probe.receiptBlockHash,
                      logIndex: probe.logIndex,
                    },
                  ]
                : "0x1234";
    res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const url = (n: string) => `http://127.0.0.1:${port}/${n}`;
  const registry = new Registry();
  const pool = new RpcReadPool({
    url: url("alchemy"),
    logUrl: url("official"),
    chainId: 421614,
    service: "test",
    timeoutMs: 240,
    fallback: {
      endpoints: [
        { name: "ankr", url: url("ankr") },
        { name: "drpc", url: url("drpc") },
      ],
      probe,
    },
    registry,
    now: () => clock,
  });
  pools.push(pool);
  return {
    pool,
    url,
    registry,
    calls,
    logWidths,
    modes,
    advance: (ms: number) => {
      clock += ms;
    },
    start: async () => {
      await pool.start();
      calls.length = 0;
    },
  };
}
describe("bounded RPC read pool", () => {
  it("healthy request calls one provider; logs prefer official", async () => {
    const f = await fixture();
    await f.start();
    expect(await f.pool.request("eth_call", [{}, "latest"])).toBe("0x1234");
    expect(f.calls).toEqual([{ name: "alchemy", method: "eth_call" }]);
    await f.pool.request("eth_getLogs", [{}]);
    expect(f.calls.at(-1)?.name).toBe("official");
  });
  it.each(["429", "quota", "500", "disconnect", "bad"] as Mode[])(
    "fails over on %s without leaking diagnostics",
    async (mode) => {
      const f = await fixture();
      await f.start();
      f.modes.alchemy = mode;
      expect(await f.pool.request("eth_call", [{}, "latest"])).toBe("0x1234");
      expect(
        f.calls.filter((c) => c.method === "eth_call").map((c) => c.name),
      ).toEqual(["alchemy", "ankr"]);
      expect(await f.registry.metrics()).not.toMatch(
        /private-key|private-secret|127\.0\.0\.1/,
      );
    },
  );
  it("uses dRPC when first two providers fail and skips isolated nodes next time", async () => {
    const f = await fixture();
    await f.start();
    f.modes.alchemy = "quota";
    f.modes.ankr = "429";
    await f.pool.request("eth_call", [{}]);
    f.calls.length = 0;
    await f.pool.request("eth_call", [{}]);
    expect(f.calls).toEqual([{ name: "drpc", method: "eth_call" }]);
  });
  it("rate-limit cooldown respects Retry-After and quota waits 15min", async () => {
    const f = await fixture();
    await f.start();
    f.modes.alchemy = "429";
    await f.pool.request("eth_call", []);
    f.modes.alchemy = "ok";
    f.calls.length = 0;
    f.advance(60_000);
    await f.pool.probe();
    expect(f.calls.filter((c) => c.name === "alchemy")).toHaveLength(0);
    f.advance(60_000);
    await f.pool.probe();
    expect(f.calls.some((c) => c.name === "alchemy")).toBe(true);
    f.modes.ankr = "quota";
    await f.pool.request("eth_call", []);
    f.calls.length = 0;
    f.advance(120_000);
    await f.pool.probe();
    expect(f.calls.filter((c) => c.name === "ankr")).toHaveLength(0);
  });
  it("requires three spaced successes and five minutes on backup before failback", async () => {
    const f = await fixture();
    await f.start();
    f.modes.alchemy = "429";
    await f.pool.request("eth_call", []);
    f.modes.alchemy = "ok";
    f.advance(120_000);
    await f.pool.probe();
    f.advance(30_000);
    await f.pool.probe();
    f.advance(30_000);
    await f.pool.probe();
    f.calls.length = 0;
    await f.pool.request("eth_call", []);
    expect(f.calls.at(-1)?.name).toBe("ankr");
    f.advance(120_000);
    await f.pool.probe();
    f.calls.length = 0;
    await f.pool.request("eth_call", []);
    expect(f.calls.at(-1)?.name).toBe("alchemy");
  });
  it("coalesces concurrent recovery probes", async () => {
    const f = await fixture();
    await f.start();
    f.modes.alchemy = "429";
    await f.pool.request("eth_call", []);
    f.modes.alchemy = "ok";
    f.advance(120_000);
    f.calls.length = 0;
    await Promise.all(Array.from({ length: 20 }, () => f.pool.probe()));
    expect(
      f.calls.filter((c) => c.name === "alchemy" && c.method === "eth_chainId"),
    ).toHaveLength(1);
  });
  it("does not switch for business revert and preserves revert bytes", async () => {
    const f = await fixture();
    await f.start();
    f.modes.alchemy = "revert";
    await expect(f.pool.request("eth_call", [{}])).rejects.toMatchObject({
      code: 3,
      data: "0x1234",
    });
    expect(f.calls).toHaveLength(1);
  });
  it("rejects a wrong chain at qualification and stale backup on switch", async () => {
    const f = await fixture();
    f.modes.alchemy = "chain";
    await f.start();
    await f.pool.request("eth_call", []);
    expect(f.calls.at(-1)?.name).toBe("ankr");
    f.modes.ankr = "429";
    f.modes.drpc = "stale";
    await expect(f.pool.request("eth_call", [])).rejects.toThrow("rpc_");
    expect(
      f.calls.filter((c) => c.name === "drpc" && c.method === "eth_call"),
    ).toHaveLength(0);
  });
  it("excludes missing archive capability while retaining current reads", async () => {
    const f = await fixture();
    f.modes.alchemy = "archive";
    await f.start();
    await f.pool.request("eth_call", []);
    expect(f.calls.at(-1)?.name).toBe("alchemy");
    await f.pool.request("eth_getBlockByNumber", ["0x10", false]);
    expect(f.calls.at(-1)?.name).toBe("ankr");
  });
  it("returns null receipt as unknown without retrying or inventing failure", async () => {
    const f = await fixture();
    await f.start();
    f.modes.alchemy = "null";
    expect(
      await f.pool.request("eth_getTransactionReceipt", [
        probe.transactionHash,
      ]),
    ).toBeNull();
    expect(f.calls).toHaveLength(1);
  });
  it("never sends writes through the read pool and compatibility writes submit once", async () => {
    const f = await fixture();
    await f.start();
    f.modes.alchemy = "500";
    await expect(
      f.pool.request("eth_sendRawTransaction", ["0x1234"]),
    ).rejects.toBeInstanceOf(RpcResponseError);
    expect(f.calls).toHaveLength(0);
    await expect(
      f.pool.requestOnce("eth_sendRawTransaction", ["0x1234"]),
    ).rejects.toThrow();
    expect(f.calls).toEqual([
      { name: "alchemy", method: "eth_sendRawTransaction" },
    ]);
    f.calls.length = 0;
    await expect(
      f.pool.requestOnce("eth_sendUserOperation", [{}]),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });
  it("all unavailable returns an explicit error and subsequent calls avoid quota nodes", async () => {
    const f = await fixture();
    await f.start();
    f.modes.alchemy = f.modes.ankr = f.modes.drpc = "quota";
    await expect(f.pool.request("eth_call", [])).rejects.toThrow("rpc_quota");
    f.calls.length = 0;
    await expect(f.pool.request("eth_call", [])).rejects.toThrow(
      "rpc_unavailable",
    );
    expect(f.calls).toHaveLength(0);
  });
  it("cancels in-flight fetch without touching a backup", async () => {
    const f = await fixture();
    await f.start();
    f.modes.alchemy = "hang";
    const abort = new AbortController();
    const result = f.pool.request("eth_call", [], { signal: abort.signal });
    setTimeout(() => abort.abort(), 10);
    await expect(result).rejects.toThrow("rpc_cancelled");
    expect(f.calls.map((c) => c.name)).toEqual(["alchemy"]);
  });
  it("uses a bounded deadline with no hidden viem retries", async () => {
    const f = await fixture();
    await f.start();
    f.modes.alchemy = "hang";
    const started = performance.now();
    expect(await f.pool.request("eth_call", [])).toBe("0x1234");
    expect(performance.now() - started).toBeLessThan(400);
    expect(f.calls.filter((c) => c.name === "alchemy")).toHaveLength(1);
  });
  it("rejects cross-provider fork disagreement before exposing a canonical block", async () => {
    const f = await fixture();
    await f.start();
    await f.pool.request("eth_getBlockByNumber", ["0x10", false]);
    f.modes.alchemy = "429";
    f.modes.ankr = "fork";
    const result = await f.pool.request("eth_getBlockByNumber", [
      "0x10",
      false,
    ]);
    expect(result).toMatchObject({ hash: probe.blockHash });
    expect(f.calls.at(-1)?.name).toBe("drpc");
  });
  it("bounds all-unresponsive providers by one total deadline", async () => {
    const f = await fixture();
    await f.start();
    f.modes.alchemy = f.modes.ankr = f.modes.drpc = "hang";
    const started = performance.now();
    await expect(f.pool.request("eth_call", [])).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(360);
  });
  it("wires the production indexer client to the same bounded transport", async () => {
    const { createIndexerClient, closeIndexerClient } = await import(
      "../../indexer/src/rpc-client.js"
    );
    const f = await fixture();
    const client = await createIndexerClient(
      {
        rpcUrl: f.url("alchemy"),
        logRpcUrl: f.url("official"),
        chainId: 421614,
        rpcTimeoutMs: 500,
        rpcFallback: {
          endpoints: [
            { name: "ankr", url: f.url("ankr") },
            { name: "drpc", url: f.url("drpc") },
          ],
          probe,
        },
      },
      new Registry(),
    );
    try {
      f.calls.length = 0;
      f.modes.alchemy = "quota";
      expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(256n);
      expect(
        f.calls
          .filter((c) => c.method === "eth_blockNumber")
          .map((c) => c.name),
      ).toEqual(["alchemy", "ankr", "ankr"]);
      expect(
        await client.getLogs({ fromBlock: 17n, toBlock: 17n }),
      ).toHaveLength(1);
      expect(f.calls.at(-1)?.name).toBe("official");
    } finally {
      closeIndexerClient(client);
    }
  });
  it("qualifies full log ranges and bypasses provider plan restrictions without masking invalid parameters", async () => {
    const f = await fixture();
    f.modes.alchemy = "log_limit";
    await f.start();
    f.modes.official = "429";
    await f.pool.request("eth_getLogs", [
      { fromBlock: "0x1", toBlock: "0x64" },
    ]);
    expect(
      f.calls.filter((c) => c.method === "eth_getLogs").map((c) => c.name),
    ).toEqual(["official", "ankr"]);
    f.modes.ankr = "invalid_params";
    f.calls.length = 0;
    await expect(
      f.pool.request("eth_getLogs", [{ fromBlock: "bad" }]),
    ).rejects.toMatchObject({ code: -32602 });
    expect(f.calls).toHaveLength(1);
  });
  it("falls through to the next log provider when a valid runtime filter exceeds its capacity", async () => {
    const f = await fixture();
    await f.start();
    f.modes.official = "429";
    f.modes.alchemy = "log_limit";
    await f.pool.request("eth_getLogs", [
      { fromBlock: "0x1", toBlock: "0x64" },
    ]);
    expect(
      f.calls.filter((c) => c.method === "eth_getLogs").map((c) => c.name),
    ).toEqual(["official", "alchemy", "ankr"]);
  });
  it("validates private config without including values in the error", () => {
    expect(parseRpcFallbackConfig({})).toBeUndefined();
    expect(() =>
      parseRpcFallbackConfig({ CPREDICT_RPC_FALLBACKS_JSON: "secret" }),
    ).toThrow("invalid private RPC fallback configuration");
    expect(() =>
      parseRpcFallbackConfig({
        CPREDICT_RPC_FALLBACKS_JSON: JSON.stringify([
          { name: "ankr", url: "https://user:secret@example.com" },
        ]),
        CPREDICT_RPC_PROBE_JSON: JSON.stringify(probe),
      }),
    ).toThrow();
  });
});
