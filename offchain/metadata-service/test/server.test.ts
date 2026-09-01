import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildMetadataTypedData,
  encodeMarketRules,
  type MarketRules,
} from "../../sdk/src/index.js";
import type { MetadataServiceConfig } from "../src/config.js";
import { MemoryMetadataStore } from "../src/memory-store.js";
import { createMetadataServer } from "../src/server.js";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const factory = getAddress("0x00000000000000000000000000000000000000f1");
const rules: MarketRules = {
  version: "cpredict-rules-v1",
  question: "Will the Cpredict test market pass?",
  outcomes: ["Yes", "No"],
  closesAt: 1_900_000_000,
  resolutionSource: "https://example.invalid/public-result",
  resolutionCriteria: "Resolve Yes only when the cited source explicitly says pass.",
  cancellationPolicy: "Void when the cited source is unavailable after the resolution window.",
};

describe("wallet-authorized metadata service", () => {
  it("publishes immutable canonical rules and ERC-1155 outcome metadata", async () => {
    const store = new MemoryMetadataStore();
    const app = await createMetadataServer({
      config: configuration(),
      store,
      now: () => 1_800_000_000,
      nonce: sequenceHex(),
    });
    const encoded = encodeMarketRules(rules);
    const challengeResponse = await app.inject({
      method: "POST",
      url: "/v1/challenges",
      payload: {
        chainId: 421614,
        factory,
        creator: account.address,
        rulesHash: encoded.rulesHash,
      },
    });
    expect(challengeResponse.statusCode).toBe(200);
    const challengeId = challengeResponse.json().challengeId as Hex;
    const challenge = await store.challenge(challengeId);
    expect(challenge).toBeDefined();
    if (challenge === undefined) throw new Error("missing challenge");
    const signature = await account.signTypedData(buildMetadataTypedData(challenge));
    const publication = await app.inject({
      method: "POST",
      url: "/v1/markets",
      payload: { challengeId, signature, rules },
    });
    expect(publication.statusCode).toBe(201);
    expect(publication.json()).toMatchObject({
      rulesHash: encoded.rulesHash,
      metadataUri: `https://101.32.241.211/metadata/v1/markets/${encoded.rulesHash}/outcomes/{id}.json`,
      resolutionSourceUri: rules.resolutionSource,
    });

    const rulesResponse = await app.inject({
      method: "GET",
      url: `/v1/markets/${encoded.rulesHash}/rules.json`,
    });
    expect(rulesResponse.statusCode).toBe(200);
    expect(rulesResponse.headers["cache-control"]).toContain("immutable");
    expect(rulesResponse.json()).toEqual(rules);

    const tokenId = "0".repeat(64);
    const outcome = await app.inject({
      method: "GET",
      url: `/v1/markets/${encoded.rulesHash}/outcomes/${tokenId}.json`,
    });
    expect(outcome.statusCode).toBe(200);
    expect(outcome.json()).toMatchObject({
      name: `${rules.question} — Yes`,
      external_url: rules.resolutionSource,
    });
    expect(outcome.json().attributes).toContainEqual({
      trait_type: "Outcome",
      value: "Yes",
    });

    const replay = await app.inject({
      method: "POST",
      url: "/v1/markets",
      payload: { challengeId, signature, rules },
    });
    expect(replay.statusCode).toBe(409);
    await app.close();
  });

  it("rejects a signature from a wallet other than the challenged creator", async () => {
    const store = new MemoryMetadataStore();
    const app = await createMetadataServer({
      config: configuration(),
      store,
      now: () => 1_800_000_000,
      nonce: sequenceHex(),
    });
    const encoded = encodeMarketRules(rules);
    const issued = await app.inject({
      method: "POST",
      url: "/v1/challenges",
      payload: {
        chainId: 421614,
        factory,
        creator: account.address,
        rulesHash: encoded.rulesHash,
      },
    });
    const challengeId = issued.json().challengeId as Hex;
    const challenge = await store.challenge(challengeId);
    if (challenge === undefined) throw new Error("missing challenge");
    const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const signature = await other.signTypedData(buildMetadataTypedData(challenge));
    const response = await app.inject({
      method: "POST",
      url: "/v1/markets",
      payload: { challengeId, signature, rules },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid signature" });
    await app.close();
  });
});

function configuration(): MetadataServiceConfig {
  return {
    host: "127.0.0.1",
    containerMode: false,
    port: 8793,
    logLevel: "silent",
    chainId: 421_614,
    factory,
    publicBaseUrl: "https://101.32.241.211/metadata",
    databaseUrl: "postgresql://127.0.0.1/cpredict_metadata",
    challengeTtlSeconds: 300,
    databasePoolSize: 5,
  };
}

function sequenceHex(): () => Hex {
  let value = 1n;
  return () => {
    const result = `0x${value.toString(16).padStart(64, "0")}` as Hex;
    value += 1n;
    return result;
  };
}
