import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbiItem,
  toHex,
  type Hex,
} from "viem";
import { PostgresEventStore } from "../src/postgres-store.js";
import type { CanonicalBlock, IndexedEvent } from "../src/store.js";
import { evidenceUriFromHash } from "../../sdk/src/evidence.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl !== undefined;
const suite = describe.skipIf(!run);

suite("PostgresEventStore integration", () => {
  const chainId = 9_991;
  const schema = `cpredict_indexer_${process.pid}_${Date.now()}`;
  let admin: ReturnType<typeof postgres>;
  let verificationSql: ReturnType<typeof postgres>;
  let store: PostgresEventStore;

  beforeAll(async () => {
    if (databaseUrl === undefined)
      throw new Error("TEST_DATABASE_URL unexpectedly missing");
    admin = postgres(databaseUrl, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    const migrationSql = postgres(scoped.toString(), { max: 1 });
    for (const name of [
      "001_indexer.sql",
      "002_settlement_evidence.sql",
      "003_read_api_indexes.sql",
    ]) {
      const migration = await readFile(
        new URL(`../migrations/${name}`, import.meta.url),
        "utf8",
      );
      await migrationSql.unsafe(migration);
    }
    await migrationSql.end();
    verificationSql = postgres(scoped.toString(), { max: 1 });
    store = new PostgresEventStore(scoped.toString());
  });

  afterAll(async () => {
    if (!run) return;
    await store.close();
    await verificationSql.end();
    await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  it("atomically rolls raw and derived state back to the canonical ancestor", async () => {
    const block1 = canonicalBlock(chainId, 1n, 1n, 0n);
    const block2 = canonicalBlock(chainId, 2n, 2n, 1n);
    await store.applyBatch([], [block1], {
      chainId,
      blockNumber: 1n,
      blockHash: block1.blockHash,
    });
    await store.applyBatch([marketCreated(chainId, block2)], [block2], {
      chainId,
      blockNumber: 2n,
      blockHash: block2.blockHash,
    });
    expect(await store.registeredMarkets(chainId)).toHaveLength(1);
    expect(
      (await store.listMarkets(chainId, { limit: 10 })).items,
    ).toHaveLength(1);
    expect(await tableCount(verificationSql, "canonical_blocks")).toBe(2);
    expect(await tableCount(verificationSql, "chain_events")).toBe(1);
    expect(await tableCount(verificationSql, "registered_markets")).toBe(1);
    expect(await tableCount(verificationSql, "markets")).toBe(1);

    await store.rollbackAfter(chainId, 1n);

    expect(await store.checkpoint(chainId)).toEqual({
      chainId,
      blockNumber: 1n,
      blockHash: block1.blockHash,
    });
    expect(await store.canonicalBlock(chainId, 2n)).toBeUndefined();
    expect(await store.registeredMarkets(chainId)).toEqual([]);
    expect((await store.listMarkets(chainId, { limit: 10 })).items).toEqual([]);
    expect(await tableCount(verificationSql, "canonical_blocks")).toBe(1);
    expect(await tableCount(verificationSql, "chain_events")).toBe(0);
    expect(await tableCount(verificationSql, "registered_markets")).toBe(0);
    expect(await tableCount(verificationSql, "markets")).toBe(0);
  });

  it("persists the terminal evidence hash and reconstructs its raw CID URI", async () => {
    const evidenceChainId = chainId + 1;
    const block1 = canonicalBlock(evidenceChainId, 1n, 11n, 0n);
    const block2 = canonicalBlock(evidenceChainId, 2n, 12n, 11n);
    const evidenceHash = hash(777n);
    await store.applyBatch([], [block1], {
      chainId: evidenceChainId,
      blockNumber: 1n,
      blockHash: block1.blockHash,
    });
    await store.applyBatch(
      [
        marketCreated(evidenceChainId, block2),
        marketResolved(evidenceChainId, block2, evidenceHash),
      ],
      [block2],
      {
        chainId: evidenceChainId,
        blockNumber: 2n,
        blockHash: block2.blockHash,
      },
    );

    expect(await store.market(evidenceChainId, MARKET)).toMatchObject({
      state: 1,
      winningOutcome: 0n,
      evidenceHash,
      evidenceUri: evidenceUriFromHash(evidenceHash),
    });
  });

  it("fails readiness until every required migration is applied", async () => {
    if (databaseUrl === undefined)
      throw new Error("TEST_DATABASE_URL unexpectedly missing");
    const legacySchema = `cpredict_indexer_legacy_${process.pid}_${Date.now()}`;
    await admin.unsafe(`CREATE SCHEMA ${legacySchema}`);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-csearch_path=${legacySchema}`);
    const migrationSql = postgres(scoped.toString(), { max: 1 });
    const legacyStore = new PostgresEventStore(scoped.toString());

    try {
      const initialMigration = await readFile(
        new URL("../migrations/001_indexer.sql", import.meta.url),
        "utf8",
      );
      await migrationSql.unsafe(initialMigration);
      await migrationSql`ALTER TABLE markets DROP COLUMN evidence_hash`;
      await expect(legacyStore.ready()).rejects.toThrow(
        "indexer database migration is not applied",
      );

      const evidenceMigration = await readFile(
        new URL("../migrations/002_settlement_evidence.sql", import.meta.url),
        "utf8",
      );
      await migrationSql.unsafe(evidenceMigration);
      await expect(legacyStore.ready()).rejects.toThrow(
        "indexer database migration is not applied",
      );
      const readApiIndexMigration = await readFile(
        new URL("../migrations/003_read_api_indexes.sql", import.meta.url),
        "utf8",
      );
      await migrationSql.unsafe(readApiIndexMigration);
      await expect(legacyStore.ready()).resolves.toBeUndefined();
    } finally {
      await legacyStore.close();
      await migrationSql.end();
      await admin.unsafe(`DROP SCHEMA ${legacySchema} CASCADE`);
    }
  });
});

async function tableCount(
  sql: ReturnType<typeof postgres>,
  table: "canonical_blocks" | "chain_events" | "registered_markets" | "markets",
): Promise<number> {
  const [row] = await sql.unsafe<{ count: number }[]>(
    `SELECT count(*)::int AS count FROM ${table}`,
  );
  return row?.count ?? 0;
}

const event = parseAbiItem(
  "event MarketCreated(address indexed market,address indexed creator,uint8 indexed deploymentMode,address implementation,bytes32 salt,bytes32 runtimeCodeHash,uint256 creatorNonce,uint256 creationFee,uint256 creatorBond)",
);
const resolvedEvent = parseAbiItem(
  "event MarketResolved(uint256 indexed winningOutcome,uint256 totalPrincipal,uint256 totalRake,uint256 protocolFee,uint256 creatorFee,uint256 earlyBirdPool,uint256 winnerPool,bytes32 indexed evidenceHash)",
);
const FACTORY = getAddress("0x000000000000000000000000000000000000F001");
const MARKET = getAddress("0x0000000000000000000000000000000000001001");
const CREATOR = getAddress("0x000000000000000000000000000000000000C001");
const ZERO = getAddress("0x0000000000000000000000000000000000000000");

function marketCreated(chainId: number, block: CanonicalBlock): IndexedEvent {
  return {
    chainId,
    blockNumber: block.blockNumber,
    blockHash: block.blockHash,
    transactionHash: hash(100n),
    transactionIndex: 0,
    logIndex: 0,
    address: FACTORY,
    topics: encodeEventTopics({
      abi: [event],
      eventName: "MarketCreated",
      args: { market: MARKET, creator: CREATOR, deploymentMode: 0 },
    }) as unknown as readonly Hex[],
    data: encodeAbiParameters(
      [
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [ZERO, hash(91n), hash(92n), 0n, 0n, 10_000_000n],
    ),
    confirmationStatus: "confirmed",
  };
}

function marketResolved(
  chainId: number,
  block: CanonicalBlock,
  evidenceHash: Hex,
): IndexedEvent {
  return {
    chainId,
    blockNumber: block.blockNumber,
    blockHash: block.blockHash,
    transactionHash: hash(101n),
    transactionIndex: 0,
    logIndex: 1,
    address: MARKET,
    topics: encodeEventTopics({
      abi: [resolvedEvent],
      eventName: "MarketResolved",
      args: { winningOutcome: 0n, evidenceHash },
    }) as unknown as readonly Hex[],
    data: encodeAbiParameters(
      Array.from({ length: 6 }, () => ({ type: "uint256" as const })),
      [100n, 10n, 2n, 3n, 1n, 90n],
    ),
    confirmationStatus: "confirmed",
  };
}

function canonicalBlock(
  chainId: number,
  blockNumber: bigint,
  blockHash: bigint,
  parentHash: bigint,
): CanonicalBlock {
  return {
    chainId,
    blockNumber,
    blockHash: hash(blockHash),
    parentHash: hash(parentHash),
    timestamp: blockNumber * 10n,
    confirmationStatus: "confirmed",
  };
}

function hash(value: bigint): Hex {
  return toHex(value, { size: 32 });
}
