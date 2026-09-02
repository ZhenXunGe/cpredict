import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { evidenceUriFromHash } from "../../sdk/src/evidence.js";
import { createIndexerApi } from "../src/api.js";
import type {
  ActivityView,
  ClaimView,
  FillView,
  IndexerQueryStore,
  ListingView,
  MarketCatalogOptions,
  MarketView,
  PositionView,
  QueryOptions,
  QueryPage,
} from "../src/store.js";

const MARKET = getAddress("0x0000000000000000000000000000000000001001");
const CREATOR = getAddress("0x000000000000000000000000000000000000C001");
const EVIDENCE_HASH = `0x${"ab".repeat(32)}` as Hex;
const EVIDENCE_URI = evidenceUriFromHash(EVIDENCE_HASH);
if (EVIDENCE_URI === null)
  throw new Error("non-zero evidence fixture has no URI");

describe("read-only indexer API", () => {
  it("serializes bigint fields and exposes confirmation status", async () => {
    const app = createIndexerApi(new FixtureQueryStore());
    const response = await app.inject({
      method: "GET",
      url: "/v1/markets?chainId=31337&limit=10",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [
        {
          market: MARKET,
          creatorBond: "10000000",
          evidenceHash: EVIDENCE_HASH,
          evidenceUri: EVIDENCE_URI,
          confirmationStatus: "confirmed",
        },
      ],
    });
    expect(response.json().items[0]).not.toHaveProperty("rulesHash");
    await app.close();
  });

  it("adds catalog metadata and wallet activity only on the versioned v2 API", async () => {
    const app = createIndexerApi(new FixtureQueryStore());
    const catalog = await app.inject({
      method: "GET",
      url: `/v2/markets?chainId=31337&limit=20&status=resolved&owner=${CREATOR}`,
    });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toMatchObject({
      items: [
        {
          market: MARKET,
          status: "resolved",
          rulesHash: `0x${"11".repeat(32)}`,
          resolutionWindow: "86400",
          primaryFilledUnits: "25000000",
        },
      ],
    });

    const activity = await app.inject({
      method: "GET",
      url: `/v2/activity/${CREATOR}?chainId=31337&limit=20`,
    });
    expect(activity.statusCode).toBe(200);
    expect(activity.json()).toMatchObject({
      items: [
        {
          kind: "market-created",
          vault: MARKET,
          actor: CREATOR,
          amount: "10000000",
        },
      ],
    });
    await app.close();
  });

  it("rejects invalid pagination without invoking a write surface", async () => {
    const app = createIndexerApi(new FixtureQueryStore());
    const response = await app.inject({
      method: "GET",
      url: "/v1/markets?chainId=31337&limit=101",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "invalid request" });
    const deepCursor = await app.inject({
      method: "GET",
      url: "/v1/markets?chainId=31337&limit=10&cursor=100001",
    });
    expect(deepCursor.statusCode).toBe(400);
    await app.close();
  });

  it("normalizes a stored zero commitment and never trusts a stored evidence URI", async () => {
    const app = createIndexerApi(new FixtureQueryStore(true));
    const response = await app.inject({
      method: "GET",
      url: `/v1/markets/${MARKET}?chainId=31337`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      evidenceHash: null,
      evidenceUri: null,
    });
    await app.close();
  });

  it("separates liveness from dependency readiness and exposes Prometheus metrics", async () => {
    const app = createIndexerApi(new FixtureQueryStore(), {
      readiness: async () => {
        throw new Error("database unavailable");
      },
    });
    expect(
      (await app.inject({ method: "GET", url: "/healthz" })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/readyz" })).statusCode,
    ).toBe(503);
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["content-type"]).toContain("text/plain");
    expect(metrics.body).toContain("cpredict_indexer_http_connections");
    expect(metrics.body).toContain("cpredict_indexer_http_requests_queued");
    expect(metrics.body).toContain("cpredict_indexer_http_requests_in_flight");
    expect(metrics.body).toContain(
      "cpredict_indexer_http_request_duration_seconds",
    );
    await app.close();
  });

  it("exposes a healthy indexed checkpoint and safe chain block", async () => {
    const app = createIndexerApi(new FixtureQueryStore(), {
      syncStatus: async (chainId) => ({
        chainId,
        indexedBlock: 304_503_617n,
        safeBlock: 304_503_618n,
      }),
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/sync-status?chainId=421614",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      chainId: 421614,
      indexedBlock: "304503617",
      safeBlock: "304503618",
    });
    await app.close();
  });

  it("fails closed when indexer sync health is unavailable", async () => {
    const app = createIndexerApi(new FixtureQueryStore(), {
      syncStatus: async () => {
        throw new Error("scheduler unhealthy");
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/sync-status?chainId=421614",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    await app.close();
  });
});

class FixtureQueryStore implements IndexerQueryStore {
  constructor(private readonly zeroEvidence = false) {}

  async listMarkets(chainId: number): Promise<QueryPage<MarketView>> {
    return { items: [market(chainId, this.zeroEvidence)] };
  }
  async market(chainId: number): Promise<MarketView | undefined> {
    return market(chainId, this.zeroEvidence);
  }
  async listMarketCatalog(
    chainId: number,
    _options: MarketCatalogOptions,
  ): Promise<QueryPage<MarketView>> {
    return { items: [market(chainId, this.zeroEvidence)] };
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
  async listActivity(
    chainId: number,
    _owner: Address,
    _options: QueryOptions,
  ): Promise<QueryPage<ActivityView>> {
    return {
      items: [
        {
          chainId,
          transactionHash: `0x${"33".repeat(32)}`,
          logIndex: 0,
          kind: "market-created",
          vault: MARKET,
          actor: CREATOR,
          counterparty: null,
          outcomeId: null,
          listingId: null,
          units: null,
          amount: 10_000_000n,
          blockNumber: 1n,
          confirmationStatus: "confirmed",
        },
      ],
    };
  }
}

function market(chainId: number, zeroEvidence = false): MarketView {
  return {
    chainId,
    market: MARKET,
    creator: CREATOR,
    deploymentMode: 0,
    outcomeCount: 2,
    closeAt: 1_000n,
    resolutionWindow: 86_400n,
    rulesHash: `0x${"11".repeat(32)}`,
    metadataUri: "https://metadata.example/market/{id}.json",
    resolutionSourceHash: `0x${"22".repeat(32)}`,
    resolutionSourceUri: "https://example.com/result",
    earlyBirdStart: 900n,
    creatorTreasury: CREATOR,
    featureFlags: 3n,
    marketPrimaryCap: 500_000_000n,
    primaryFilledUnits: 25_000_000n,
    primaryPayment: 25_000_000n,
    creatorBond: 10_000_000n,
    state: 1,
    winningOutcome: 0n,
    evidenceHash: zeroEvidence ? `0x${"00".repeat(32)}` : EVIDENCE_HASH,
    evidenceUri: "ipfs://untrusted-store-value",
    createdBlock: 1n,
    updatedBlock: 1n,
    confirmationStatus: "confirmed",
  };
}
