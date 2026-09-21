import { describe, expect, it } from "vitest";
import { Registry } from "prom-client";
import { PrometheusIndexerTelemetry } from "../src/telemetry.js";

describe("sparse canonical telemetry", () => {
  it("exports bounded read purposes and range outcomes", async () => {
    const registry = new Registry();
    const telemetry = new PrometheusIndexerTelemetry(registry);
    telemetry.ingestion.blockHeaderRead("fence");
    telemetry.ingestion.blockHeaderRead("event");
    telemetry.ingestion.fenceFailure();
    telemetry.ingestion.rollback(2, 200n);
    telemetry.batch({
      fromBlock: 1n,
      toBlock: 100n,
      blockCount: 100,
      anchorCount: 3,
      eventCount: 2,
      discoveredMarkets: 0,
      confirmationStatus: "confirmed",
      caughtUp: false,
    });

    const metrics = await registry.metrics();
    expect(metrics).toContain('cpredict_indexer_block_headers_total{purpose="fence"} 1');
    expect(metrics).toContain('cpredict_indexer_block_headers_total{purpose="event"} 1');
    expect(metrics).toContain("cpredict_indexer_scanned_blocks_total 100");
    expect(metrics).toContain("cpredict_indexer_saved_anchors_total 3");
    expect(metrics).toContain("cpredict_indexer_fence_failures_total 1");
    expect(metrics).toContain("cpredict_indexer_rollback_batches_total 2");
    expect(metrics).toContain("cpredict_indexer_rollback_blocks_total 200");
  });
});
