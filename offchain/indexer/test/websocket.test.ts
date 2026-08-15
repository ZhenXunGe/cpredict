import { once } from "node:events";
import type { Address, Hex } from "viem";
import { Registry } from "prom-client";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createIndexerApi } from "../src/api.js";
import type {
  ClaimView,
  FillView,
  IndexerQueryStore,
  ListingView,
  MarketView,
  PositionView,
  QueryOptions,
  QueryPage,
} from "../src/store.js";
import { IndexerWebSocketHub } from "../src/websocket.js";

const CHAIN_ID = 31_337;
const clients: WebSocket[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.terminate();
});

describe("indexer WebSocket stream", () => {
  it("validates subscriptions, caps connections, and exposes bounded metrics", async () => {
    const { app, endpoint, registry } = await startApi(1);
    const first = connect(`${endpoint}?chainId=${CHAIN_ID}`);
    const [ready] = await once(first, "message");
    expect(JSON.parse(String(ready))).toMatchObject({
      type: "ready",
      protocolVersion: 1,
      chainId: CHAIN_ID,
      market: null,
    });

    const rejected = connect(`${endpoint}?chainId=${CHAIN_ID}`);
    const [, response] = await once(rejected, "unexpected-response");
    expect((response as { statusCode?: number }).statusCode).toBe(429);
    rejected.terminate();

    const metrics = await registry.metrics();
    expect(metrics).toContain("cpredict_indexer_ws_connections 1");
    expect(metrics).toContain("cpredict_indexer_ws_peak_connections 1");
    expect(metrics).toContain(
      'cpredict_indexer_ws_rejected_total{reason="capacity"} 1',
    );
    expect(metrics).toContain(
      'cpredict_indexer_ws_outbound_total{kind="ready"} 1',
    );
    expect(metrics).toContain(
      'cpredict_indexer_ws_heartbeat_total{kind="ping"} 0',
    );
    first.close();
    await once(first, "close");
    await app.close();
  });

  it("rejects client messages and gracefully closes open streams", async () => {
    const { app, endpoint } = await startApi(2);
    const policyClient = connect(`${endpoint}?chainId=${CHAIN_ID}`);
    await once(policyClient, "open");
    policyClient.send("writes are forbidden");
    const [policyCode] = await once(policyClient, "close");
    expect(policyCode).toBe(1008);

    const shutdownClient = connect(`${endpoint}?chainId=${CHAIN_ID}`);
    await once(shutdownClient, "open");
    const closed = once(shutdownClient, "close");
    await app.close();
    const [shutdownCode] = await closed;
    expect(shutdownCode).toBe(1001);
  });

  it("evicts peers that do not answer heartbeat pings", async () => {
    const { app, endpoint, registry } = await startApi(2, 20);
    const silentClient = connect(`${endpoint}?chainId=${CHAIN_ID}`, {
      autoPong: false,
    });
    await once(silentClient, "open");
    const [code] = await once(silentClient, "close");
    expect(code).toBe(1006);
    await expectMetric(
      registry,
      'cpredict_indexer_ws_closed_total{reason="heartbeat_timeout"} 1',
    );
    await app.close();
  });
});

async function startApi(maxConnections: number, heartbeatIntervalMs = 5_000) {
  const registry = new Registry();
  const websocket = new IndexerWebSocketHub(
    {
      chainId: CHAIN_ID,
      maxConnections,
      heartbeatIntervalMs,
      maxBufferedAmountBytes: 1_024,
      shutdownGraceMs: 1_000,
    },
    registry,
  );
  const app = createIndexerApi(new EmptyQueryStore(), { registry, websocket });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string")
    throw new Error("test server has no TCP address");
  return {
    app,
    registry,
    endpoint: `ws://127.0.0.1:${address.port}/v1/stream`,
  };
}

async function expectMetric(
  registry: Registry,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await registry.metrics()).includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(await registry.metrics()).toContain(expected);
}

function connect(
  url: string,
  options: WebSocket.ClientOptions = {},
): WebSocket {
  const client = new WebSocket(url, { perMessageDeflate: false, ...options });
  client.on("error", () => undefined);
  clients.push(client);
  return client;
}

class EmptyQueryStore implements IndexerQueryStore {
  async listMarkets(
    _chainId: number,
    _options: QueryOptions,
  ): Promise<QueryPage<MarketView>> {
    return { items: [] };
  }
  async market(
    _chainId: number,
    _market: Address,
  ): Promise<MarketView | undefined> {
    return undefined;
  }
  async listListings(
    _chainId: number,
    _options: QueryOptions & {
      vault?: Address | undefined;
      active?: boolean | undefined;
    },
  ): Promise<QueryPage<ListingView>> {
    return { items: [] };
  }
  async listFills(
    _chainId: number,
    _options: QueryOptions & {
      vault?: Address | undefined;
      listingId?: Hex | undefined;
    },
  ): Promise<QueryPage<FillView>> {
    return { items: [] };
  }
  async listPositions(
    _chainId: number,
    _owner: Address,
    _options: QueryOptions & { vault?: Address | undefined },
  ): Promise<QueryPage<PositionView>> {
    return { items: [] };
  }
  async listClaims(
    _chainId: number,
    _owner: Address,
    _options: QueryOptions & { vault?: Address | undefined },
  ): Promise<QueryPage<ClaimView>> {
    return { items: [] };
  }
}
