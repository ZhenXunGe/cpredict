import postgres, { type Sql } from "postgres";
import { getAddress, type Address, type Hex } from "viem";
import { marketRulesSchema } from "../../sdk/src/market-rules.js";
import {
  ChallengeUnavailableError,
  type MarketPublication,
  type MetadataChallenge,
  type MetadataStore,
} from "./types.js";

export class PostgresMetadataStore implements MetadataStore {
  private readonly sql: Sql;

  constructor(connectionString: string, maximumConnections = 5) {
    if (!/^postgres(?:ql)?:\/\//.test(connectionString))
      throw new TypeError("DATABASE_URL must use PostgreSQL");
    if (
      !Number.isSafeInteger(maximumConnections) ||
      maximumConnections < 1 ||
      maximumConnections > 20
    ) {
      throw new RangeError("maximumConnections must be within [1, 20]");
    }
    this.sql = postgres(connectionString, {
      max: maximumConnections,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: true,
      onnotice: () => undefined,
    });
  }

  async createChallenge(challenge: MetadataChallenge): Promise<void> {
    await this.sql`
      INSERT INTO metadata_challenges (
        challenge_id, chain_id, factory, creator, rules_hash, nonce, expires_at,
        consumed_at
      ) VALUES (
        ${challenge.challengeId}, ${challenge.chainId}, ${challenge.factory},
        ${challenge.creator}, ${challenge.rulesHash}, ${challenge.nonce},
        ${challenge.expiresAt}, ${challenge.consumedAt}
      )
    `;
  }

  async challenge(challengeId: Hex): Promise<MetadataChallenge | undefined> {
    const rows = await this.sql<Array<ChallengeRow>>`
      SELECT challenge_id, chain_id, factory, creator, rules_hash, nonce,
             expires_at, consumed_at
      FROM metadata_challenges
      WHERE challenge_id = ${challengeId}
    `;
    return rows[0] === undefined ? undefined : mapChallenge(rows[0]);
  }

  async publish(input: {
    challengeId: Hex;
    signature: Hex;
    canonicalJson: string;
    rules: MarketPublication["rules"];
    metadataUri: string;
    resolutionSourceHash: Hex;
    now: number;
  }): Promise<MarketPublication> {
    return this.sql.begin(async (transaction) => {
      const challenges = await transaction<Array<ChallengeRow>>`
        SELECT challenge_id, chain_id, factory, creator, rules_hash, nonce,
               expires_at, consumed_at
        FROM metadata_challenges
        WHERE challenge_id = ${input.challengeId}
        FOR UPDATE
      `;
      const row = challenges[0];
      if (
        row === undefined ||
        row.consumed_at !== null ||
        Number(row.expires_at) <= input.now
      ) {
        throw new ChallengeUnavailableError("challenge unavailable");
      }
      const challenge = mapChallenge(row);
      await transaction`
        INSERT INTO market_publications (
          rules_hash, chain_id, factory, creator, canonical_json, metadata_uri,
          resolution_source_hash, resolution_source_uri, signature, published_at
        ) VALUES (
          ${challenge.rulesHash}, ${challenge.chainId}, ${challenge.factory},
          ${challenge.creator}, ${input.canonicalJson},
          ${input.metadataUri}, ${input.resolutionSourceHash},
          ${input.rules.resolutionSource}, ${input.signature}, ${input.now}
        ) ON CONFLICT (rules_hash) DO NOTHING
      `;
      const publications = await transaction<Array<PublicationRow>>`
        SELECT rules_hash, chain_id, factory, creator, canonical_json,
               metadata_uri, resolution_source_hash, resolution_source_uri,
               signature, published_at
        FROM market_publications
        WHERE rules_hash = ${challenge.rulesHash}
      `;
      const publication = publications[0];
      if (publication === undefined)
        throw new Error("publication insert failed");
      if (publication.canonical_json !== input.canonicalJson)
        throw new Error("rules hash collision");
      await transaction`
        UPDATE metadata_challenges
        SET consumed_at = ${input.now}
        WHERE challenge_id = ${input.challengeId} AND consumed_at IS NULL
      `;
      return mapPublication(publication);
    });
  }

  async publication(rulesHash: Hex): Promise<MarketPublication | undefined> {
    const rows = await this.sql<Array<PublicationRow>>`
      SELECT rules_hash, chain_id, factory, creator, canonical_json,
             metadata_uri, resolution_source_hash, resolution_source_uri,
             signature, published_at
      FROM market_publications
      WHERE rules_hash = ${rulesHash}
    `;
    return rows[0] === undefined ? undefined : mapPublication(rows[0]);
  }

  async ready(): Promise<void> {
    const rows = await this.sql<
      Array<{ challenges: string | null; publications: string | null }>
    >`
      SELECT
        to_regclass('metadata_challenges')::text AS challenges,
        to_regclass('market_publications')::text AS publications
    `;
    if (
      rows[0]?.challenges === null ||
      rows[0]?.publications === null ||
      rows[0] === undefined
    ) {
      throw new Error("metadata database migration is not applied");
    }
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

interface ChallengeRow {
  challenge_id: Hex;
  chain_id: string;
  factory: Address;
  creator: Address;
  rules_hash: Hex;
  nonce: Hex;
  expires_at: string;
  consumed_at: string | null;
}

interface PublicationRow {
  rules_hash: Hex;
  chain_id: string;
  factory: Address;
  creator: Address;
  canonical_json: string;
  metadata_uri: string;
  resolution_source_hash: Hex;
  resolution_source_uri: string;
  signature: Hex;
  published_at: string;
}

function mapChallenge(row: ChallengeRow): MetadataChallenge {
  return {
    challengeId: row.challenge_id,
    chainId: Number(row.chain_id),
    factory: getAddress(row.factory),
    creator: getAddress(row.creator),
    rulesHash: row.rules_hash,
    nonce: row.nonce,
    expiresAt: Number(row.expires_at),
    consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
  };
}

function mapPublication(row: PublicationRow): MarketPublication {
  const rules = marketRulesSchema.parse(JSON.parse(row.canonical_json));
  return {
    chainId: Number(row.chain_id),
    factory: getAddress(row.factory),
    creator: getAddress(row.creator),
    rulesHash: row.rules_hash,
    canonicalJson: row.canonical_json,
    rules,
    metadataUri: row.metadata_uri,
    resolutionSourceHash: row.resolution_source_hash,
    resolutionSourceUri: row.resolution_source_uri,
    signature: row.signature,
    publishedAt: Number(row.published_at),
  };
}
