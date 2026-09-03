import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeMarketRules,
  type MarketRules,
} from "../../../offchain/sdk/src/index.js";
import {
  fetchIndexerSyncStatus,
  fetchListings,
  fetchMarketCatalog,
  fetchMarketRules,
  fetchTerminalMarketCatalog,
  fetchWalletActivity,
  fetchWalletPositions,
} from "../src/indexer-client.js";

const MARKET = "0x0000000000000000000000000000000000001001";
const CREATOR = "0x000000000000000000000000000000000000c001";

afterEach(() => vi.unstubAllGlobals());

describe("same-origin indexer client", () => {
  it("parses bigint catalog fields and sends bounded filters", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      json({
        items: [
          {
            market: MARKET,
            creator: CREATOR,
            deploymentMode: 0,
            outcomeCount: 2,
            closeAt: "1893456000",
            resolutionWindow: "900",
            rulesHash: `0x${"11".repeat(32)}`,
            marketPrimaryCap: "20000000",
            primaryFilledUnits: "3000000",
            creatorBond: "10000000",
            status: "open",
            voidReason: 0,
            winningOutcome: null,
            createdBlock: "123",
            confirmationStatus: "confirmed",
          },
        ],
        nextCursor: "eyJibG9jayI6MTIzfQ",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchMarketCatalog({
      basePath: "/indexer",
      chainId: 421614,
      owner: CREATOR,
      status: "open",
      limit: 100,
    });
    expect(page.items[0]).toMatchObject({
      market: MARKET,
      marketPrimaryCap: 20_000_000n,
      primaryFilledUnits: 3_000_000n,
      resolutionWindow: 900n,
      winningOutcome: null,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("owner=0x");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("status=open");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("limit=100");
  });

  it("merges resolved and voided catalogs into one terminal page", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const status = new URL(url, "http://demo.local").searchParams.get(
        "status",
      );
      const item = {
        market:
          status === "resolved"
            ? MARKET
            : "0x0000000000000000000000000000000000001002",
        creator: CREATOR,
        deploymentMode: 0,
        outcomeCount: 2,
        closeAt: status === "resolved" ? "100" : "200",
        resolutionWindow: "900",
        rulesHash: `0x${"11".repeat(32)}`,
        marketPrimaryCap: "20000000",
        primaryFilledUnits: "3000000",
        creatorBond: "10000000",
        status,
        voidReason: status === "resolved" ? 0 : 1,
        winningOutcome: status === "resolved" ? "0" : null,
        createdBlock: "123",
        confirmationStatus: "confirmed",
      };
      return json({ items: [item] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const page = await fetchTerminalMarketCatalog({
      basePath: "/indexer",
      chainId: 421614,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("status=resolved"),
        expect.stringContaining("status=voided"),
      ]),
    );
    expect(page.items.map((item) => item.status)).toEqual([
      "voided",
      "resolved",
    ]);
    expect(page.items.at(-1)?.winningOutcome).toBe(0n);
  });

  it("filters listings by vault", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      json({ items: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await fetchListings({
      basePath: "/indexer",
      chainId: 421614,
      vault: MARKET,
      active: true,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`vault=${MARKET}`);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("active=true");
  });

  it("rejects malformed activity instead of rendering untrusted data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          items: [
            { kind: "admin-drain", transactionHash: `0x${"22".repeat(32)}` },
          ],
        }),
      ),
    );
    await expect(
      fetchWalletActivity({
        basePath: "/indexer",
        chainId: 421614,
        owner: CREATOR,
      }),
    ).rejects.toThrow("invalid");
  });

  it("parses wallet positions and the indexer sync proof boundary", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          status: "ready",
          chainId: 421614,
          indexedBlock: "304503617",
          safeBlock: "304503618",
        }),
      )
      .mockResolvedValueOnce(
        json({
          items: [
            {
              vault: MARKET,
              owner: CREATOR,
              outcomeId: "0",
              balance: "2000000",
              updatedBlock: "304503617",
              confirmationStatus: "confirmed",
            },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchIndexerSyncStatus({
        basePath: "/indexer",
        chainId: 421614,
      }),
    ).resolves.toEqual({
      chainId: 421614,
      indexedBlock: 304_503_617n,
      safeBlock: 304_503_618n,
    });
    await expect(
      fetchWalletPositions({
        basePath: "/indexer",
        chainId: 421614,
        owner: CREATOR,
      }),
    ).resolves.toMatchObject({
      items: [
        {
          balance: 2_000_000n,
          outcomeId: 0n,
          marketState: null,
          winningOutcome: null,
        },
      ],
    });
  });

  it("parses indexed position market snapshots when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          items: [
            {
              vault: MARKET,
              owner: CREATOR,
              outcomeId: "1",
              balance: "5000000",
              updatedBlock: "304503617",
              confirmationStatus: "confirmed",
              marketState: 1,
              winningOutcome: "0",
            },
          ],
        }),
      ),
    );
    await expect(
      fetchWalletPositions({
        basePath: "/indexer",
        chainId: 421614,
        owner: CREATOR,
      }),
    ).resolves.toMatchObject({
      items: [
        {
          outcomeId: 1n,
          balance: 5_000_000n,
          marketState: 1,
          winningOutcome: 0n,
        },
      ],
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(rules)),
    );
    await expect(
      fetchMarketRules({
        metadataBasePath: "/metadata",
        rulesHash: encoded.rulesHash,
      }),
    ).resolves.toEqual(rules);
    await expect(
      fetchMarketRules({
        metadataBasePath: "https://evil.invalid",
        rulesHash: encoded.rulesHash,
      }),
    ).rejects.toThrow("same-origin");
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
