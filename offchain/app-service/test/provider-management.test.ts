import { afterEach, describe, expect, it, vi } from "vitest";
import { ZeroDevManagementReader } from "../src/provider-management.js";

const config = {
  apiKey: "fixture-only-management-key",
  projectId: "fixture-project",
  teamId: "fixture-team",
  chainId: 421614 as const,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fixed ZeroDev management transport (fixtures, not live billing contracts)", () => {
  it("reads only the four official GET paths, requests testnet spend and keeps raw responses private", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ fixture: "raw-data-must-stay-private" }),
    );
    vi.stubGlobal("fetch", fetcher);
    const reader = new ZeroDevManagementReader(
      config,
      undefined,
      () => new Date("2026-09-10T03:00:00.000Z"),
    );
    const pending = reader.poll();
    await Promise.all([pending, reader.poll()]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const calls = fetcher.mock.calls as unknown as [URL, RequestInit][];
    expect(calls.map(([url]) => url.pathname)).toEqual([
      "/v2/projects/fixture-project/statistics",
      "/v2/projects/fixture-project/chains/421614/policies",
      "/v2/projects/fixture-project/policies/webhooks",
      "/teams/fixture-team/project-spend",
    ]);
    for (const [url, init] of calls) {
      expect(url.origin).toBe("https://public-api.zerodev.app");
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: { "X-API-KEY": config.apiKey },
      });
      expect(init.body).toBeUndefined();
      expect(url.href).not.toContain(config.apiKey);
    }
    for (const index of [0, 3]) {
      expect(calls[index]![0].searchParams.get("startDate")).toBe(
        "2026-08-11T03:00:00.000Z",
      );
      expect(calls[index]![0].searchParams.get("endDate")).toBe(
        "2026-09-10T03:00:00.000Z",
      );
    }
    expect(calls[3]![0].searchParams.get("includeTestnet")).toBe("true");
    expect(reader.status().mappingStatus).toBe(
      "awaiting-real-response-contract",
    );
    expect(
      reader.status().endpoints.every((e) => !e.stale && e.error === null),
    ).toBe(true);
    expect(JSON.stringify(reader)).not.toContain(config.apiKey);
    expect(JSON.stringify(reader.status())).not.toMatch(
      /raw-data-must-stay-private|fixture-only-management-key/,
    );
    await reader.stop();
    expect(reader.latest("statistics")).toBeUndefined();
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [429, "rate-limited"],
    [500, "provider-error"],
  ] as const)(
    "classifies HTTP %i without discarding or relabeling the prior successful window",
    async (code, error) => {
      let now = new Date("2026-09-10T03:00:00.000Z");
      const observed = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ fixture: "last-success" })),
      );
      const reader = new ZeroDevManagementReader(config, observed, () => now);
      await reader.poll();
      const original = reader.status().endpoints[0]!;
      now = new Date("2026-09-10T03:05:00.000Z");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () => new Response("upstream private detail", { status: code }),
        ),
      );
      await reader.poll();
      let state = reader.status().endpoints[0]!;
      expect(state).toMatchObject({
        error,
        stale: false,
        lastSuccessAt: original.lastSuccessAt,
        dataWindow: original.dataWindow,
      });
      expect(state.requestedWindow?.end).toBe(now.toISOString());
      expect(reader.latest("statistics")).toEqual({ fixture: "last-success" });
      expect(observed).toHaveBeenLastCalledWith(false);
      now = new Date("2026-09-10T03:15:00.000Z");
      state = reader.status().endpoints[0]!;
      expect(state.stale).toBe(true);
      expect(state.lastSuccessAt).toBe(original.lastSuccessAt);
      expect(JSON.stringify(reader.status())).not.toContain(
        "upstream private detail",
      );
      await reader.stop();
    },
  );

  it("rejects malformed, oversized or non-object responses and retains an unknown result before the first success", async () => {
    const reader = new ZeroDevManagementReader(config);
    expect(
      reader
        .status()
        .endpoints.every((e) => e.stale && e.lastSuccessAt === null),
    ).toBe(true);
    for (const response of [
      "not json",
      "null",
      "42",
      JSON.stringify({ huge: "x".repeat(1_048_576) }),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(response)),
      );
      await reader.poll();
      expect(
        reader
          .status()
          .endpoints.every(
            (e) => e.error === "invalid-response" && e.lastSuccessAt === null,
          ),
      ).toBe(true);
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("secret upstream error");
      }),
    );
    await reader.poll();
    expect(
      reader.status().endpoints.every((e) => e.error === "unavailable"),
    ).toBe(true);
    await reader.stop();
  });

  it("bounds stalled requests and stops polling without starting a second interval", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      AbortSignal.abort(new DOMException("timed out", "TimeoutError")),
    );
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      init.signal?.throwIfAborted();
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetcher);
    const reader = new ZeroDevManagementReader(config);
    reader.start();
    reader.start();
    await reader.poll();
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(reader.status().endpoints.every((e) => e.error === "timeout")).toBe(
      true,
    );
    await reader.stop();
    await reader.poll();
    reader.start();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("rejects path traversal, other chains and header injection before making a request", () => {
    for (const patch of [
      { projectId: "../other" },
      { teamId: "team?query=1" },
      { chainId: 1 },
      { apiKey: "secret\r\ninjected-header" },
    ])
      expect(
        () =>
          new ZeroDevManagementReader({ ...config, ...patch } as typeof config),
      ).toThrow();
  });
});
