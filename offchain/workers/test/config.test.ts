import { describe, expect, it } from "vitest";
import { parseTerminalWorkerConfig } from "../src/config.js";

const valid = {
  CPREDICT_WORKER_HOST: "127.0.0.1",
  CPREDICT_WORKER_PORT: "3002",
  CPREDICT_WORKER_LOG_LEVEL: "silent",
  CPREDICT_WORKER_ADAPTER_MODULE: "file:///opt/cpredict/worker-adapters.js",
  CPREDICT_WORKER_CHAIN_ID: "421614",
  CPREDICT_WORKER_RPC_URL: "https://rpc.example.invalid",
  CPREDICT_WORKER_DATABASE_URL:
    "postgresql://worker@db.example.invalid/cpredict?sslmode=verify-full",
  CPREDICT_WORKER_EXPECTED_ACCOUNT:
    "0x00000000000000000000000000000000000000A1",
  CPREDICT_WORKER_BOND_ESCROW: "0x00000000000000000000000000000000000000B1",
  CPREDICT_WORKER_EXPOSURE_GUARD: "0x00000000000000000000000000000000000000C1",
  CPREDICT_WORKER_INDEXER_URL: "https://indexer.example.invalid",
  CPREDICT_WORKER_INDEXER_MAX_PAGES: "100",
  CPREDICT_WORKER_INDEXER_TIMEOUT_MS: "5000",
} as const;

describe("parseTerminalWorkerConfig", () => {
  it("parses deployment configuration without accepting signing material", () => {
    expect(parseTerminalWorkerConfig(valid)).toMatchObject({
      chainId: 421614,
      indexerMaxPages: 100,
    });
  });

  it("rejects raw private-key variables and non-file adapter modules", () => {
    expect(() =>
      parseTerminalWorkerConfig({
        ...valid,
        CPREDICT_WORKER_PRIVATE_KEY: "0xdead",
      }),
    ).toThrow("unsupported worker environment variable");
    expect(() =>
      parseTerminalWorkerConfig({
        ...valid,
        CPREDICT_WORKER_ADAPTER_MODULE: "https://example.invalid/adapter.js",
      }),
    ).toThrow("absolute file URL");
  });

  it("rejects insecure remote RPC, database and Indexer transports", () => {
    expect(() =>
      parseTerminalWorkerConfig({
        ...valid,
        CPREDICT_WORKER_RPC_URL: "http://rpc.invalid",
      }),
    ).toThrow();
    expect(() =>
      parseTerminalWorkerConfig({
        ...valid,
        CPREDICT_WORKER_DATABASE_URL:
          "postgresql://db.example.invalid/cpredict",
      }),
    ).toThrow();
    expect(() =>
      parseTerminalWorkerConfig({
        ...valid,
        CPREDICT_WORKER_INDEXER_URL: "http://indexer.invalid",
      }),
    ).toThrow();
  });
});
