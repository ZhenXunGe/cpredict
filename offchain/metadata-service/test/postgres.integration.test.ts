import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { encodeMarketRules, type MarketRules } from "../../sdk/src/index.js";
import { PostgresMetadataStore } from "../src/postgres-store.js";
import { ChallengeUnavailableError } from "../src/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl !== undefined;
const suite = describe.skipIf(!run);

suite("PostgresMetadataStore integration", () => {
  const schema = `cpredict_metadata_${process.pid}_${Date.now()}`;
  let admin: ReturnType<typeof postgres>;
  let store: PostgresMetadataStore;
  let scopedUrl: string;

  beforeAll(async () => {
    if (databaseUrl === undefined)
      throw new Error("TEST_DATABASE_URL unexpectedly missing");
    admin = postgres(databaseUrl, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    scopedUrl = scoped.toString();
    const migrationSql = postgres(scopedUrl, { max: 1 });
    const migration = await readFile(
      new URL("../migrations/001_metadata.sql", import.meta.url),
      "utf8",
    );
    await migrationSql.unsafe(migration);
    await migrationSql.end();
    store = new PostgresMetadataStore(scopedUrl);
  });

  afterAll(async () => {
    if (!run) return;
    await store.close();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("preserves exact canonical JSON and consumes a challenge once", async () => {
    const encoded = encodeMarketRules(rules);
    const challenge = challengeFor(encoded.rulesHash, 1);
    await store.createChallenge(challenge);
    const publication = await store.publish({
      challengeId: challenge.challengeId,
      signature: signature(1),
      canonicalJson: encoded.canonicalJson,
      rules,
      metadataUri: `https://metadata.example/v1/markets/${encoded.rulesHash}/outcomes/{id}.json`,
      resolutionSourceHash: hash(3),
      now: 1_800_000_001,
    });
    expect(publication.canonicalJson).toBe(encoded.canonicalJson);
    expect(publication.rules).toEqual(rules);
    await expect(store.publish({
      challengeId: challenge.challengeId,
      signature: signature(1),
      canonicalJson: encoded.canonicalJson,
      rules,
      metadataUri: publication.metadataUri,
      resolutionSourceHash: hash(3),
      now: 1_800_000_002,
    })).rejects.toBeInstanceOf(ChallengeUnavailableError);
  });

  it("fails readiness without the migration and rejects exact-expiry use", async () => {
    const missingSchema = `cpredict_metadata_missing_${process.pid}_${Date.now()}`;
    await admin.unsafe(`CREATE SCHEMA ${missingSchema}`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-csearch_path=${missingSchema}`);
    const missingStore = new PostgresMetadataStore(url.toString());
    try {
      await expect(missingStore.ready()).rejects.toThrow("metadata database migration is not applied");
    } finally {
      await missingStore.close();
      await admin.unsafe(`DROP SCHEMA ${missingSchema} CASCADE`);
    }

    const encoded = encodeMarketRules(rules);
    const challenge = { ...challengeFor(encoded.rulesHash, 2), expiresAt: 1_800_000_300 };
    await store.createChallenge(challenge);
    await expect(store.publish({
      challengeId: challenge.challengeId,
      signature: signature(2),
      canonicalJson: encoded.canonicalJson,
      rules,
      metadataUri: `https://metadata.example/v1/markets/${encoded.rulesHash}/outcomes/{id}.json`,
      resolutionSourceHash: hash(3),
      now: challenge.expiresAt,
    })).rejects.toBeInstanceOf(ChallengeUnavailableError);
  });
});

const factory = getAddress("0x000000000000000000000000000000000000f001");
const creator = getAddress("0x000000000000000000000000000000000000c001");
const rules: MarketRules = {
  version: "cpredict-rules-v1",
  question: "Will the published public result be Yes?",
  outcomes: ["Yes", "No"],
  closesAt: 1_900_000_000,
  resolutionSource: "https://example.com/result",
  resolutionCriteria: "Use the final result published by the cited source.",
  cancellationPolicy: "Void if no unambiguous result is published in time.",
};

function challengeFor(rulesHash: Hex, sequence: number) {
  return {
    challengeId: hash(10 + sequence),
    chainId: 421_614,
    factory,
    creator,
    rulesHash,
    nonce: hash(20 + sequence),
    expiresAt: 1_800_000_300,
    consumedAt: null,
  };
}

function hash(value: number): Hex {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function signature(value: number): Hex {
  return `0x${value.toString(16).padStart(130, "0")}`;
}
