import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerRpcCompatibility } from "../src/rpc-compatibility.js";
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
});
