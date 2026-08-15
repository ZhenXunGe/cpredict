import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { evidenceUriFromHash } from "../../sdk/src/evidence.js";
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
});

class FixtureQueryStore implements IndexerQueryStore {
  constructor(private readonly zeroEvidence = false) {}

  async listMarkets(chainId: number): Promise<QueryPage<MarketView>> {
    return { items: [market(chainId, this.zeroEvidence)] };
  }
  async market(chainId: number): Promise<MarketView | undefined> {
    return market(chainId, this.zeroEvidence);
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

function market(chainId: number, zeroEvidence = false): MarketView {
  return {
    chainId,
    market: MARKET,
    creator: CREATOR,
    deploymentMode: 0,
    outcomeCount: 2,
    closeAt: 1_000n,
    marketPrimaryCap: 500_000_000n,
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
