import { describe, expect, it } from "vitest";
import { parseMetadataServiceConfig } from "../src/config.js";

const valid = {
  CPREDICT_METADATA_HOST: "127.0.0.1",
  CPREDICT_METADATA_CONTAINER_MODE: "false",
  CPREDICT_METADATA_PORT: "8793",
  CPREDICT_METADATA_LOG_LEVEL: "silent",
  CPREDICT_METADATA_CHAIN_ID: "421614",
  CPREDICT_METADATA_FACTORY_ADDRESS:
    "0x00000000000000000000000000000000000000f1",
  CPREDICT_METADATA_PUBLIC_BASE_URL: "https://101.32.241.211/metadata/",
  CPREDICT_METADATA_DATABASE_URL:
    "postgresql://user:pass@db.example.invalid/cpredict?sslmode=verify-full",
  CPREDICT_METADATA_CHALLENGE_TTL_SECONDS: "300",
} as const;

describe("metadata service environment", () => {
  it("parses bounded configuration and normalizes the public base URL", () => {
    expect(parseMetadataServiceConfig(valid)).toMatchObject({
      chainId: 421614,
      publicBaseUrl: "https://101.32.241.211/metadata",
      challengeTtlSeconds: 300,
      databasePoolSize: 5,
    });
  });

  it("fails closed for unknown values, insecure origins, and broad container databases", () => {
    expect(() =>
      parseMetadataServiceConfig({
        ...valid,
        CPREDICT_METADATA_PRIVATE_KEY: "secret",
      }),
    ).toThrow("unsupported metadata environment variable");
    expect(() =>
      parseMetadataServiceConfig({
        ...valid,
        CPREDICT_METADATA_PUBLIC_BASE_URL: "http://example.invalid/metadata",
      }),
    ).toThrow();
    expect(() =>
      parseMetadataServiceConfig({
        ...valid,
        CPREDICT_METADATA_HOST: "0.0.0.0",
        CPREDICT_METADATA_CONTAINER_MODE: "true",
        CPREDICT_METADATA_DATABASE_URL:
          "postgresql://metadata:placeholder@other/cpredict_metadata?sslmode=disable",
      }),
    ).toThrow("internal postgres service");
  });
});
