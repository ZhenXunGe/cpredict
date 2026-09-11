import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPublicClient,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionData,
  http,
  parseAbi,
  toHex,
  type PublicClient,
} from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { arbitrumSepolia } from "viem/chains";
import { AppError } from "../../app-core/src/contracts.js";
import type { AdmissionReader } from "../../app-core/src/calls.js";
import {
  createAppKernel,
  ENTRY_POINT,
  readOnlyController,
} from "../../app-core/src/kernel.js";
import { appAccount, env } from "../../app-core/test/fixtures.js";
import { appRuntimeSchema } from "../src/config.js";
import { AuthenticatedAAGateway } from "../src/gateway.js";
import { ProviderRpc } from "../src/http.js";
import { OperationService } from "../src/operations.js";
import { OperationRecovery } from "../src/recovery.js";
import { createApplicationServer } from "../src/server.js";
import { MemoryApplicationStore } from "./memory-store.js";

const senderResult = encodeErrorResult({
  abi: entryPoint07Abi,
  errorName: "SenderAddressResult",
  args: [appAccount.address],
});
const senderCall = {
  to: ENTRY_POINT.address,
  data: encodeFunctionData({
    abi: entryPoint07Abi,
    functionName: "getSenderAddress",
    args: ["0x1234"],
  }),
};
const callRequest = {
  jsonrpc: "2.0",
  id: "sender-address",
  method: "eth_call",
  params: [senderCall, "latest"],
};
const providerMessage = "upstream https://provider.invalid/private-project-id";

async function setup() {
  const store = new MemoryApplicationStore();
  const client = {} as PublicClient;
  const observed = vi.fn();
  const rpc = new ProviderRpc(
    "https://provider.invalid/private-project-id",
    observed,
  );
  const service = new OperationService(
    appRuntimeSchema.parse({
      environment: env,
      sponsor: null,
      allowedOrigins: ["https://app.invalid"],
      adminSubjects: [],
    }),
    store,
    client,
    {} as AdmissionReader,
  );
  const server = await createApplicationServer({
    operations: service,
    auth: {
      verify: async () => {
        throw new AppError("unauthorized", 401);
      },
    },
    gateway: new AuthenticatedAAGateway(service, rpc, rpc),
    recovery: new OperationRecovery(store, client, rpc, 2),
    chainRpc: rpc,
  });
  return { server, rpc, observed };
}

function upstreamResponse(body: unknown) {
  const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) =>
    Response.json(body),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("public read RPC compatibility", () => {
  it.each([
    "eth_chainId",
    "eth_blockNumber",
    "eth_gasPrice",
    "eth_maxPriorityFeePerGas",
  ])("accepts omitted or empty params for %s", async (method) => {
    const fetch = upstreamResponse({
      jsonrpc: "2.0",
      id: 1,
      result: "0x66eee",
    });
    const { server } = await setup();
    try {
      for (const params of [undefined, []]) {
        const response = await server.inject({
          method: "POST",
          url: "/v1/rpc",
          payload: {
            jsonrpc: "2.0",
            id: 42,
            method,
            ...(params ? { params } : {}),
          },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          jsonrpc: "2.0",
          id: 42,
          result: "0x66eee",
        });
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      for (const call of fetch.mock.calls) {
        expect(JSON.parse(String(call[1]?.body))).toEqual({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: [],
        });
      }
    } finally {
      await server.close();
    }
  });

  it.each([
    {
      name: "missing eth_call arguments",
      payload: { jsonrpc: "2.0", id: 1, method: "eth_call" },
    },
    {
      name: "missing balance arguments",
      payload: { jsonrpc: "2.0", id: 1, method: "eth_getBalance" },
    },
    {
      name: "null params",
      payload: { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: null },
    },
    {
      name: "named params",
      payload: { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: {} },
    },
    {
      name: "extra zero-argument params",
      payload: { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [1] },
    },
    {
      name: "state overrides",
      payload: { ...callRequest, params: [senderCall, "latest", {}] },
    },
    {
      name: "gas above the cap",
      payload: {
        ...callRequest,
        params: [{ ...senderCall, gas: toHex(10_000_001) }, "latest"],
      },
    },
    {
      name: "RPC writes",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: ["0x1234"],
      },
    },
    { name: "RPC batches", payload: [callRequest] },
  ])(
    "still rejects $name before reaching the provider",
    async ({ payload }) => {
      const fetch = upstreamResponse({ jsonrpc: "2.0", id: 1, result: null });
      const { server } = await setup();
      try {
        const response = await server.inject({
          method: "POST",
          url: "/v1/rpc",
          payload,
        });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    },
  );

  it.each([3, -32000, -32603])(
    "preserves bounded revert bytes and RPC code %s with a safe message",
    async (code) => {
      const fetch = upstreamResponse({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code,
          message: providerMessage,
          data: senderResult,
          metadata: { private: providerMessage },
        },
      });
      const { server, observed } = await setup();
      try {
        const response = await server.inject({
          method: "POST",
          url: "/v1/rpc",
          payload: callRequest,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          jsonrpc: "2.0",
          id: callRequest.id,
          error: { code, message: "execution reverted", data: senderResult },
        });
        expect(response.body).not.toContain(providerMessage);
        expect(fetch).toHaveBeenCalledOnce();
        expect(observed).toHaveBeenLastCalledWith(true);
      } finally {
        await server.close();
      }
    },
  );

  it.each([
    {
      name: "arbitrary objects",
      error: {
        code: 3,
        message: providerMessage,
        data: { data: senderResult, private: providerMessage },
      },
    },
    {
      name: "non-hex diagnostics",
      error: { code: 3, message: providerMessage, data: providerMessage },
    },
    {
      name: "odd-length hex",
      error: { code: 3, message: providerMessage, data: "0x123" },
    },
    {
      name: "oversized hex",
      error: {
        code: 3,
        message: providerMessage,
        data: `0x${"ab".repeat(32_769)}`,
      },
    },
    {
      name: "non-numeric code",
      error: { code: "3", message: providerMessage, data: senderResult },
    },
    {
      name: "fractional code",
      error: { code: 3.5, message: providerMessage, data: senderResult },
    },
    { name: "missing error message", error: { code: 3, data: senderResult } },
    {
      name: "missing error data",
      error: { code: 3, message: providerMessage },
    },
  ])("does not expose $name from the provider", async ({ error }) => {
    upstreamResponse({ jsonrpc: "2.0", id: 1, error });
    const { server } = await setup();
    try {
      const response = await server.inject({
        method: "POST",
        url: "/v1/rpc",
        payload: callRequest,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: { code: "provider_rejected", message: "provider_rejected" },
      });
    } finally {
      await server.close();
    }
  });

  it("keeps transport failures generic and never automatically retries", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(providerMessage);
    });
    vi.stubGlobal("fetch", fetch);
    const { server, observed } = await setup();
    try {
      const response = await server.inject({
        method: "POST",
        url: "/v1/rpc",
        payload: callRequest,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: {
          code: "upstream_unavailable",
          message: "upstream_unavailable",
        },
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(observed).toHaveBeenLastCalledWith(false);
    } finally {
      await server.close();
    }
  });

  it("keeps bundler failures on the existing sanitized error path", async () => {
    upstreamResponse({
      jsonrpc: "2.0",
      id: 1,
      error: { code: 3, message: providerMessage, data: senderResult },
    });
    const { server, rpc } = await setup();
    try {
      const error = await rpc
        .request("eth_sendUserOperation", [])
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: "provider_rejected",
        status: 503,
        message: "provider_rejected",
      });
      expect(error).not.toHaveProperty("data");
    } finally {
      await server.close();
    }
  });

  it("constructs the actual Kernel SDK account and prepares faucet calldata through the HTTP proxy", async () => {
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      const base = { jsonrpc: "2.0", id: request.id };
      if (request.method === "eth_chainId")
        return Response.json({ ...base, result: "0x66eee" });
      if (request.method === "eth_getCode")
        return Response.json({ ...base, result: "0x" });
      if (request.method === "eth_call") {
        expect(request.params[0].to.toLowerCase()).toBe(
          ENTRY_POINT.address.toLowerCase(),
        );
        const call = decodeFunctionData({
          abi: entryPoint07Abi,
          data: request.params[0].data,
        });
        if (call.functionName === "getSenderAddress") {
          return Response.json({
            ...base,
            error: { code: 3, message: providerMessage, data: senderResult },
          });
        }
        if (call.functionName === "getNonce")
          return Response.json({ ...base, result: toHex(0n, { size: 32 }) });
      }
      throw new Error(`unexpected SDK RPC method: ${request.method}`);
    });
    vi.stubGlobal("fetch", fetch);
    const { server } = await setup();
    const clientRequests: Record<string, unknown>[] = [];
    try {
      const client = createPublicClient({
        chain: arbitrumSepolia,
        transport: http("http://app.invalid/v1/rpc", {
          retryCount: 0,
          fetchFn: async (_input, init) => {
            const payload = JSON.parse(String(init?.body));
            clientRequests.push(payload);
            const response = await server.inject({
              method: "POST",
              url: "/v1/rpc",
              payload,
            });
            return new Response(response.body, {
              status: response.statusCode,
              headers: { "content-type": "application/json" },
            });
          },
        }),
      });
      const account = await createAppKernel(
        client,
        readOnlyController(appAccount.controller),
        env,
      );
      expect(account.address).toBe(appAccount.address);
      expect(await account.getNonce()).toBe(0n);
      const factory = await account.getFactoryArgs();
      expect(factory.factory).toMatch(/^0x[\da-fA-F]{40}$/);
      expect(factory.factoryData).not.toBe("0x");
      const faucetData = encodeFunctionData({
        abi: parseAbi(["function mint(address to,uint256 amount)"]),
        functionName: "mint",
        args: [account.address, 100_000_000n],
      });
      expect(
        await account.encodeCalls([
          { to: env.deployment.paymentToken, data: faucetData, value: 0n },
        ]),
      ).toContain(faucetData.slice(2));
      const chainRequest = clientRequests.find(
        (request) => request.method === "eth_chainId",
      );
      expect(chainRequest).toBeDefined();
      expect(chainRequest).not.toHaveProperty("params");
      expect(
        clientRequests.every((request) =>
          ["eth_chainId", "eth_call", "eth_getCode"].includes(
            String(request.method),
          ),
        ),
      ).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(clientRequests.length);
    } finally {
      await server.close();
    }
  });
});
