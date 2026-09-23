import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerRpcCompatibility } from "../src/rpc-compatibility.js";
import {
  RpcAdmission,
  rpcAdmissionConfigSchema,
} from "../src/rpc-admission.js";
import {
  RpcResponseError,
  type RpcReadPool,
} from "../../app-core/src/rpc-pool.js";
describe("legacy RPC envelope compatibility", () => {
  it("preserves batch order/ids and sends writes only once through the primary lane", async () => {
    const request = vi.fn(async () => "0x66eee"),
      requestOnce = vi.fn(async () => {
        throw new Error("unknown outcome private URL");
      });
    const app = Fastify();
    registerRpcCompatibility(app, {
      request,
      requestOnce,
    } as unknown as RpcReadPool);
    const reply = await app.inject({
      method: "POST",
      url: "/v1/rpc-compat",
      payload: [
        { jsonrpc: "2.0", id: "chain", method: "eth_chainId", params: [] },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "eth_sendRawTransaction",
          params: ["0x1234"],
        },
        {
          jsonrpc: "2.0",
          id: null,
          method: "eth_call",
          params: [{}, "latest"],
        },
      ],
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().map((r: { id: unknown }) => r.id)).toEqual([
      "chain",
      2,
      null,
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(requestOnce).toHaveBeenCalledTimes(1);
    expect(reply.body).not.toContain("private");
    await app.close();
  });
  it("preserves revert bytes and suppresses provider messages", async () => {
    const app = Fastify();
    registerRpcCompatibility(app, {
      request: async () => {
        throw new RpcResponseError(3, "0x1234");
      },
    } as unknown as RpcReadPool);
    const reply = await app.inject({
      method: "POST",
      url: "/v1/rpc-compat",
      payload: { jsonrpc: "2.0", id: "sdk", method: "eth_call" },
    });
    expect(reply.json()).toEqual({
      jsonrpc: "2.0",
      id: "sdk",
      error: { code: 3, message: "execution reverted", data: "0x1234" },
    });
    await app.close();
  });
  it("supports notifications and rejects malformed envelopes without forwarding them", async () => {
    const request = vi.fn(async () => "0x1"),
      app = Fastify();
    registerRpcCompatibility(app, { request } as unknown as RpcReadPool);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/rpc-compat",
          payload: { jsonrpc: "2.0", method: "eth_blockNumber" },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({ method: "POST", url: "/v1/rpc-compat", payload: [] })
      ).json().error.code,
    ).toBe(-32600);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/rpc-compat",
          payload: [
            { invalid: true },
            { jsonrpc: "2.0", id: 9, method: "eth_blockNumber" },
          ],
        })
      ).json()[1].id,
    ).toBe(9);
    expect(request).toHaveBeenCalledTimes(2);
    await app.close();
  });
  it("rejects an oversized batch before forwarding any read or write", async () => {
    const request = vi.fn(async () => "0x1");
    const requestOnce = vi.fn(async () => "0x2");
    const app = Fastify();
    registerRpcCompatibility(app, {
      request,
      requestOnce,
    } as unknown as RpcReadPool);
    try {
      const reply = await app.inject({
        method: "POST",
        url: "/v1/rpc-compat",
        payload: Array.from({ length: 65 }, (_, id) => ({
          jsonrpc: "2.0",
          id,
          method: id === 64 ? "eth_sendRawTransaction" : "eth_chainId",
          params: [],
        })),
      });
      expect(reply.json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
      expect(request).not.toHaveBeenCalled();
      expect(requestOnce).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("caps concurrent batch reads at four and preserves response order", async () => {
    let active = 0;
    let maximumActive = 0;
    const request = vi.fn(async (_method: string, params: unknown[]) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return params[0];
    });
    const app = Fastify();
    registerRpcCompatibility(app, { request } as unknown as RpcReadPool);
    try {
      const reply = await app.inject({
        method: "POST",
        url: "/v1/rpc-compat",
        payload: Array.from({ length: 16 }, (_, id) => ({
          jsonrpc: "2.0",
          id,
          method: "eth_blockNumber",
          params: [id],
        })),
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toEqual(
        Array.from({ length: 16 }, (_, id) => ({
          jsonrpc: "2.0",
          id,
          result: id,
        })),
      );
      expect(request).toHaveBeenCalledTimes(16);
      expect(maximumActive).toBe(4);
    } finally {
      await app.close();
    }
  });
  it("rejects a whole over-budget batch before any write is forwarded", async () => {
    const request = vi.fn(async () => "0x1");
    const requestOnce = vi.fn(async () => "0x2");
    const app = Fastify();
    const admission = new RpcAdmission(
      rpcAdmissionConfigSchema.parse({
        mode: "enforce",
        perClientUnitsPerMinute: 64,
        globalUnitsPerMinute: 64,
      }),
    );
    registerRpcCompatibility(
      app,
      { request, requestOnce } as unknown as RpcReadPool,
      admission,
    );
    try {
      const reply = await app.inject({
        method: "POST",
        url: "/v1/rpc-compat",
        payload: [
          ...Array.from({ length: 16 }, (_, id) => ({
            jsonrpc: "2.0",
            id,
            method: "eth_call",
            params: [],
          })),
          {
            jsonrpc: "2.0",
            id: "write",
            method: "eth_sendRawTransaction",
            params: ["0x1234"],
          },
        ],
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.json()).toHaveLength(17);
      expect(
        reply
          .json()
          .every(
            (item: { error?: { code: number } }) => item.error?.code === -32005,
          ),
      ).toBe(true);
      expect(request).not.toHaveBeenCalled();
      expect(requestOnce).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("uses only the trusted proxy client address for per-client budgets", async () => {
    const request = vi.fn(async () => "0x1");
    const app = Fastify({ trustProxy: ["127.0.0.1"] });
    registerRpcCompatibility(
      app,
      { request } as unknown as RpcReadPool,
      new RpcAdmission(
        rpcAdmissionConfigSchema.parse({
          mode: "enforce",
          perClientUnitsPerMinute: 64,
          globalUnitsPerMinute: 128,
        }),
      ),
    );
    const payload = Array.from({ length: 64 }, (_, id) => ({
      jsonrpc: "2.0",
      id,
      method: "eth_chainId",
      params: [],
    }));
    const send = (remoteAddress: string, forwarded: string) =>
      app.inject({
        method: "POST",
        url: "/v1/rpc-compat",
        remoteAddress,
        headers: { "x-forwarded-for": forwarded },
        payload,
      });
    try {
      expect((await send("127.0.0.1", "198.51.100.8")).json()[0].result).toBe(
        "0x1",
      );
      expect(
        (await send("127.0.0.1", "198.51.100.8")).json()[0].error.code,
      ).toBe(-32005);
      expect((await send("127.0.0.1", "198.51.100.9")).json()[0].result).toBe(
        "0x1",
      );
      expect(request).toHaveBeenCalledTimes(128);
    } finally {
      await app.close();
    }
  });
});
