import type { Sql } from "postgres";
import { Registry } from "prom-client";
import { describe, expect, it, vi } from "vitest";
import type { PublicClient, WalletClient } from "viem";
import type { TerminalWorkerServiceConfig } from "../src/config.js";
import {
  preflightTerminalWorker,
  type TerminalWorkerRuntimeAdapters,
} from "../src/runtime.js";
import { createTerminalWorkerServer } from "../src/server.js";

const account = "0x00000000000000000000000000000000000000A1";
const config: TerminalWorkerServiceConfig = {
  host: "127.0.0.1",
  port: 3002,
  logLevel: "silent",
  adapterModule: "file:///adapter.js",
  chainId: 421_614,
  rpcUrl: "https://rpc.example.invalid",
  databaseUrl: "postgresql://db.example.invalid/cpredict?sslmode=verify-full",
  expectedAccount: account,
  bondEscrow: "0x00000000000000000000000000000000000000B1",
  exposureGuard: "0x00000000000000000000000000000000000000C1",
  indexerUrl: new URL("https://indexer.example.invalid"),
  indexerMaxPages: 100,
  indexerTimeoutMs: 5_000,
};

function adapters(
  overrides: Partial<TerminalWorkerRuntimeAdapters> = {},
): TerminalWorkerRuntimeAdapters {
  const sql = (async () => [
    { terminal_worker_attempts: "terminal_worker_attempts" },
  ]) as unknown as Sql;
  return {
    publicClient: {
      getChainId: vi.fn(async () => 421_614),
    } as unknown as PublicClient,
    walletClient: {} as WalletClient,
    account,
    sql,
    telemetry: { record: vi.fn(), unexpected: vi.fn() },
    registry: new Registry(),
    ready: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("terminal worker production runtime boundaries", () => {
  it("verifies signer identity, RPC chain, database migration and injected adapters", async () => {
    await expect(
      preflightTerminalWorker(config, adapters()),
    ).resolves.toBeUndefined();
    await expect(
      preflightTerminalWorker(
        config,
        adapters({
          account: "0x00000000000000000000000000000000000000A2",
        }),
      ),
    ).rejects.toThrow("expected account");
    await expect(
      preflightTerminalWorker(
        config,
        adapters({
          publicClient: {
            getChainId: vi.fn(async () => 1),
          } as unknown as PublicClient,
        }),
      ),
    ).rejects.toThrow("chainId");
  });

  it("exposes liveness, fail-closed readiness and Prometheus metrics only", async () => {
    const app = createTerminalWorkerServer({
      readiness: async () => {
        throw new Error("signer unavailable");
      },
      registry: new Registry(),
      logLevel: "silent",
    });
    expect(
      (await app.inject({ method: "GET", url: "/healthz" })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/readyz" })).statusCode,
    ).toBe(503);
    expect(
      (await app.inject({ method: "GET", url: "/metrics" })).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "POST", url: "/" })).statusCode).toBe(
      404,
    );
    await app.close();
  });
});
