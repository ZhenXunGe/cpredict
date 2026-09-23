import { Registry } from "prom-client";
import { describe, expect, it } from "vitest";
import {
  RpcAdmission,
  parseRpcAdmissionConfig,
  rpcAdmissionConfigSchema,
} from "../src/rpc-admission.js";

const call = (method: string, params: unknown[] = []) => ({ method, params });

describe("public RPC cost and concurrency admission", () => {
  it("charges every batch member and bounds expensive log ranges", () => {
    const admission = new RpcAdmission(
      rpcAdmissionConfigSchema.parse({
        mode: "enforce",
        perClientUnitsPerMinute: 64,
        globalUnitsPerMinute: 64,
      }),
    );
    const first = admission.enter(
      "client",
      Array.from({ length: 16 }, () => call("eth_call")),
    );
    expect(first.allowed).toBe(true);
    first.release();
    expect(
      admission.enter("client", [call("eth_sendRawTransaction")]),
    ).toMatchObject({
      allowed: false,
      reason: "client_budget",
    });
    const range = new RpcAdmission(
      rpcAdmissionConfigSchema.parse({
        mode: "enforce",
        perClientUnitsPerMinute: 64,
        globalUnitsPerMinute: 64,
      }),
    );
    const bounded = range.enter("client", [
      call("eth_getLogs", [{ fromBlock: "0x1", toBlock: "0x12c" }]),
    ]);
    expect(bounded.allowed).toBe(true);
    bounded.release();
    const unbounded = range.enter("client", [
      call("eth_getLogs", [{ fromBlock: "earliest", toBlock: "latest" }]),
    ]);
    expect(unbounded).toMatchObject({
      allowed: false,
      reason: "client_budget",
    });
  });

  it("limits calls across requests, releases slots once, and never trusts client labels in metrics", async () => {
    const registry = new Registry();
    const admission = new RpcAdmission(
      rpcAdmissionConfigSchema.parse({
        mode: "enforce",
        perClientUnitsPerMinute: 64,
        globalUnitsPerMinute: 64,
        maxConcurrentCalls: 4,
      }),
      registry,
    );
    const first = admission.enter(
      "private-client-address",
      [call("eth_chainId")],
      4,
    );
    expect(first.allowed).toBe(true);
    expect(admission.enter("other", [call("eth_chainId")])).toMatchObject({
      allowed: false,
      reason: "concurrency",
    });
    first.release();
    first.release();
    expect(admission.enter("other", [call("eth_chainId")]).allowed).toBe(true);
    const metrics = await registry.metrics();
    expect(metrics).toContain(
      'decision="rejected",lane="read",reason="concurrency"',
    );
    expect(metrics).not.toContain("private-client-address");
  });

  it("observes a would-be denial without disrupting requests and rejects invalid budgets", async () => {
    let now = 0;
    const registry = new Registry();
    const admission = new RpcAdmission(
      rpcAdmissionConfigSchema.parse({
        mode: "observe",
        perClientUnitsPerMinute: 64,
        globalUnitsPerMinute: 64,
      }),
      registry,
      () => now,
    );
    admission
      .enter(
        "client",
        Array.from({ length: 64 }, () => call("eth_chainId")),
      )
      .release();
    expect(admission.enter("client", [call("eth_chainId")]).allowed).toBe(true);
    now = 60_000;
    expect(admission.enter("client", [call("eth_chainId")]).allowed).toBe(true);
    expect(await registry.metrics()).toContain(
      'decision="would_reject",lane="read",reason="client_budget"',
    );
    expect(() =>
      parseRpcAdmissionConfig({
        CPREDICT_RPC_ADMISSION_MODE: "enforce",
        CPREDICT_RPC_CLIENT_UNITS_PER_MINUTE: "200",
        CPREDICT_RPC_GLOBAL_UNITS_PER_MINUTE: "100",
      }),
    ).toThrow();
  });
});
