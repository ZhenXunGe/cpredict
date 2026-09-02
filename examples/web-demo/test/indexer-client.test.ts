import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeMarketRules, type MarketRules } from "../../../offchain/sdk/src/index.js";
import {
  fetchIndexerSyncStatus,
  fetchMarketCatalog,
  fetchMarketRules,
  fetchWalletActivity,
  fetchWalletPositions,
} from "../src/indexer-client.js";

const MARKET = "0x0000000000000000000000000000000000001001";
const CREATOR = "0x000000000000000000000000000000000000c001";

afterEach(() => vi.unstubAllGlobals());

describe("same-origin indexer client", () => {
  it("parses bigint catalog fields and sends bounded filters", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => json({
      items: [{
        market: MARKET,
        creator: CREATOR,
        deploymentMode: 0,
        outcomeCount: 2,
        closeAt: "1893456000",
        rulesHash: `0x${"11".repeat(32)}`,
        marketPrimaryCap: "20000000",
        primaryFilledUnits: "3000000",
        creatorBond: "10000000",
        status: "open",
        createdBlock: "123",
        confirmationStatus: "confirmed",
      }],
      nextCursor: "eyJibG9jayI6MTIzfQ",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchMarketCatalog({
      basePath: "/indexer",
      chainId: 421614,
      owner: CREATOR,
      status: "open",
    });
    expect(page.items[0]).toMatchObject({
      market: MARKET,
      marketPrimaryCap: 20_000_000n,
      primaryFilledUnits: 3_000_000n,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("owner=0x");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("status=open");
  });

  it("rejects malformed activity instead of rendering untrusted data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      items: [{ kind: "admin-drain", transactionHash: `0x${"22".repeat(32)}` }],
    })));
    await expect(fetchWalletActivity({
      basePath: "/indexer",
      chainId: 421614,
      owner: CREATOR,
    })).rejects.toThrow("invalid");
  });

  it("parses wallet positions and the indexer sync proof boundary", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({
        status: "ready",
        chainId: 421614,
        indexedBlock: "304503617",
        safeBlock: "304503618",
      }))
      .mockResolvedValueOnce(json({
        items: [{
          vault: MARKET,
          owner: CREATOR,
          outcomeId: "0",
          balance: "2000000",
          updatedBlock: "304503617",
          confirmationStatus: "confirmed",
        }],
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchIndexerSyncStatus({
      basePath: "/indexer",
      chainId: 421614,
    })).resolves.toEqual({
      chainId: 421614,
      indexedBlock: 304_503_617n,
      safeBlock: 304_503_618n,
    });
    await expect(fetchWalletPositions({
      basePath: "/indexer",
      chainId: 421614,
      owner: CREATOR,
    })).resolves.toMatchObject({
      items: [{ balance: 2_000_000n, outcomeId: 0n }],
    });
  });

  it("accepts only self-hosted metadata whose content matches rulesHash", async () => {
    const rules: MarketRules = {
      version: "cpredict-rules-v1",
      question: "Will the public result be Yes at close?",
      outcomes: ["Yes", "No"],
      closesAt: 1_893_456_000,
      resolutionSource: "https://example.com/result",
      resolutionCriteria: "Use the final result shown by the public source.",
      cancellationPolicy: "Void when no unambiguous final result is published.",
    };
    const encoded = encodeMarketRules(rules);
    vi.stubGlobal("fetch", vi.fn(async () => json(rules)));
    await expect(fetchMarketRules({
      metadataBasePath: "/metadata",
      rulesHash: encoded.rulesHash,
    })).resolves.toEqual(rules);
    await expect(fetchMarketRules({
      metadataBasePath: "https://evil.invalid",
      rulesHash: encoded.rulesHash,
    })).rejects.toThrow("same-origin");
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
