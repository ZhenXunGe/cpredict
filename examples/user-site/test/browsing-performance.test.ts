import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { env } from "../../../offchain/app-core/test/fixtures.js";
import { SiteApi } from "../src/api.js";
import { marketQueryOptions, rulesQueryKey, type Market } from "../src/data.js";
import { routePage } from "../src/route-preload.js";

const market: Market = {
  chainId: 421614,
  creator: "0x0000000000000000000000000000000000000066",
  creatorTreasury: null, outcomeCount: 2, createdAt: "90",
  metadataUri: null, resolutionSourceHash: null, resolutionSourceUri: null,
  featureFlags: "0", marketPrimaryCap: "0", primaryFilledUnits: "0",
  primaryPayment: "0", creatorBond: "0", state: 0, voidReason: 0,
  winningOutcome: null, evidenceHash: null, createdBlock: "49",
  confirmationStatus: "confirmed", question: "测试市场",
  market: "0x0000000000000000000000000000000000000065",
  rulesHash: `0x${"12".repeat(32)}`,
  closeAt: "100",
  eventStartsAt: "110",
  outcomeDeadlineAt: "120",
  resolutionWindow: "60",
  updatedBlock: "50",
};

describe("public browsing cache boundaries", () => {
  it("reuses the authoritative prefetched detail without another request", async () => {
    const api = new SiteApi(env);
    const request = vi.spyOn(api, "request").mockResolvedValue(market);
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    try {
      await Promise.all([
        cache.prefetchQuery(marketQueryOptions(api, market.market)),
        cache.prefetchQuery(marketQueryOptions(api, market.market)),
      ]);
      expect(
        await cache.fetchQuery(marketQueryOptions(api, market.market)),
      ).toEqual(market);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[2]).toMatchObject({ service: "indexer" });
      expect(request.mock.calls[0]?.[2]).not.toHaveProperty("auth");
    } finally {
      cache.clear();
    }
  });
  it("ignores trading block changes for immutable rules", () => {
    const api = new SiteApi(env);
    expect(rulesQueryKey(api, market)).toEqual(
      rulesQueryKey(api, { ...market, updatedBlock: "51" }),
    );
  });
  it.each([
    "rulesHash",
    "closeAt",
    "eventStartsAt",
    "outcomeDeadlineAt",
    "resolutionWindow",
  ] as const)("rechecks rules when %s changes", (field) => {
    const api = new SiteApi(env);
    expect(rulesQueryKey(api, market)).not.toEqual(
      rulesQueryKey(api, { ...market, [field]: null }),
    );
  });
  it("does not share verification across deployments", () => {
    const other = new SiteApi({
      ...env,
      deployment: { ...env.deployment, id: `${env.deployment.id}-other` },
    });
    expect(rulesQueryKey(new SiteApi(env), market)).not.toEqual(
      rulesQueryKey(other, market),
    );
  });
});

describe("code-only route preparation", () => {
  it.each([
    ["/", "markets"],
    ["/ctusd-test/markets", "markets"],
    ["/ctusd-test/markets/0x123", "market"],
    ["/ctusd-test/creator/new", "creator"],
    ["/ctusd-test/history", "history"],
    ["/ctusd-test/leaderboard", "reports"],
    ["/ctusd-test/unknown", null],
  ])("maps %s to %s", (path, expected) =>
    expect(routePage(path!)).toBe(expected),
  );
});
