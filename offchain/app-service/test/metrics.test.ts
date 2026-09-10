import { describe, expect, it, vi, afterEach } from "vitest";
import { ApplicationMetrics } from "../src/metrics.js";
import { ProviderRpc } from "../src/http.js";

afterEach(() => vi.unstubAllGlobals());
describe("application service monitoring", () => {
  it("separates unknown data, measured backlog and failed dependency observations", async () => {
    const metrics = new ApplicationMetrics();
    metrics.observeDependency("database", true);
    metrics.observeState(
      {
        pending: 8,
        unknown: 3,
        oldestPendingSeconds: 120,
        indexedBlock: "100",
        budget: [
          {
            lane: "exit",
            reservedWei: "1000000000000000",
            remainingWei: "19000000000000000",
          },
        ],
      },
      104n,
    );
    metrics.recoveryResults({ attempted: 8, failed: 2 });
    metrics.observeDependency("chain", false);
    let text = await metrics.registry.metrics();
    expect(text).toContain("cpredict_app_operations_pending 8");
    expect(text).toContain("cpredict_app_index_delay_blocks 4");
    expect(text).toContain(
      'cpredict_app_dependency_available{service="chain"} 0',
    );
    expect(text).toContain(
      'cpredict_app_recovery_queries_total{outcome="failed"} 2',
    );
    metrics.observeState(
      {
        pending: 8,
        unknown: 3,
        oldestPendingSeconds: 121,
        indexedBlock: null,
        budget: [],
      },
      null,
    );
    text = await metrics.registry.metrics();
    expect(text).not.toMatch(/^cpredict_app_indexed_block /m);
    expect(text).not.toMatch(/^cpredict_app_index_delay_blocks /m);
  });
  it("does not label a business RPC rejection as an unavailable provider", async () => {
    const observed = vi.fn();
    const rpc = new ProviderRpc("https://rpc.example.invalid", observed);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32000, message: "simulation rejected" },
            }),
          ),
      ),
    );
    await expect(
      rpc.request("eth_estimateUserOperationGas", []),
    ).rejects.toMatchObject({ code: "provider_rejected" });
    expect(observed).toHaveBeenLastCalledWith(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unavailable");
      }),
    );
    await expect(
      rpc.request("eth_getUserOperationReceipt", []),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
    expect(observed).toHaveBeenLastCalledWith(false);
  });
});
