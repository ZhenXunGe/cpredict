import { describe, expect, it } from "vitest";
import { parseIndexerServiceConfig } from "../src/config.js";

const valid = {
  CPREDICT_INDEXER_HOST: "127.0.0.1",
  CPREDICT_INDEXER_PORT: "3001",
  CPREDICT_INDEXER_LOG_LEVEL: "silent",
  CPREDICT_INDEXER_CHAIN_ID: "84532",
  CPREDICT_INDEXER_RPC_URL: "https://rpc.example.invalid",
  CPREDICT_INDEXER_DATABASE_URL:
    "postgresql://user:pass@db.example.invalid/cpredict?sslmode=verify-full",
  CPREDICT_INDEXER_FACTORY_ADDRESS:
    "0x00000000000000000000000000000000000000f1",
  CPREDICT_INDEXER_CORE_ADDRESSES:
    "0x00000000000000000000000000000000000000f1,0x00000000000000000000000000000000000000f2",
  CPREDICT_INDEXER_DEPLOYMENT_BLOCK: "123",
  CPREDICT_INDEXER_CONFIRMATIONS: "2",
  CPREDICT_INDEXER_BATCH_SIZE: "500",
  CPREDICT_INDEXER_MAX_BATCHES_PER_TICK: "4",
  CPREDICT_INDEXER_POLL_INTERVAL_MS: "1000",
  CPREDICT_INDEXER_RPC_TIMEOUT_MS: "5000",
  CPREDICT_INDEXER_LISTEN_BACKLOG: "16384",
  CPREDICT_INDEXER_HTTP_MAX_CONNECTIONS: "20000",
  CPREDICT_INDEXER_WS_MAX_CONNECTIONS: "12000",
  CPREDICT_INDEXER_WS_HEARTBEAT_INTERVAL_MS: "15000",
  CPREDICT_INDEXER_WS_MAX_BUFFERED_AMOUNT_BYTES: "65536",
  CPREDICT_INDEXER_WS_SHUTDOWN_GRACE_MS: "5000",
} as const;

describe("parseIndexerServiceConfig", () => {
  it("parses bounded production configuration and normalizes addresses", () => {
    const config = parseIndexerServiceConfig(valid);
    expect(config).toMatchObject({
      chainId: 84532,
      deploymentBlock: 123n,
      batchSize: 500n,
      databasePoolSize: 10,
    });
    expect(config.coreAddresses).toHaveLength(2);
  });

  it("rejects unknown names and insecure remote transports", () => {
    expect(() =>
      parseIndexerServiceConfig({
        ...valid,
        CPREDICT_INDEXER_PRIVATE_KEY: "secret",
      }),
    ).toThrow("unsupported indexer environment variable");
    expect(() =>
      parseIndexerServiceConfig({
        ...valid,
        CPREDICT_INDEXER_RPC_URL: "http://rpc.example.invalid",
      }),
    ).toThrow();
    expect(() =>
      parseIndexerServiceConfig({
        ...valid,
        CPREDICT_INDEXER_DATABASE_URL:
          "postgresql://db.example.invalid/cpredict",
      }),
    ).toThrow();
  });

  it("allows loopback development transports but rejects unbounded scheduler inputs", () => {
    expect(() =>
      parseIndexerServiceConfig({
        ...valid,
        CPREDICT_INDEXER_RPC_URL: "http://127.0.0.1:8545",
        CPREDICT_INDEXER_DATABASE_URL: "postgresql://127.0.0.1/cpredict",
      }),
    ).not.toThrow();
    expect(() =>
      parseIndexerServiceConfig({
        ...valid,
        CPREDICT_INDEXER_MAX_BATCHES_PER_TICK: "101",
      }),
    ).toThrow();
    expect(() =>
      parseIndexerServiceConfig({
        ...valid,
        CPREDICT_INDEXER_HTTP_MAX_CONNECTIONS: "10000",
      }),
    ).toThrow("must be >= CPREDICT_INDEXER_WS_MAX_CONNECTIONS");
    expect(() =>
      parseIndexerServiceConfig({
        ...valid,
        CPREDICT_INDEXER_DATABASE_POOL_SIZE: "101",
      }),
    ).toThrow();
  });
});
