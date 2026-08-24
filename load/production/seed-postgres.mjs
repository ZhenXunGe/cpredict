import { createHash } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const databaseUrl = required("LOAD_DATABASE_URL");
const expectedDataDirectory = await realpath(
  required("LOAD_DATABASE_EXPECTED_DATA_DIR"),
);
const reportPath = required("REPORT_PATH");
const runId = required("RUN_ID");
const runStartedAt = new Date(required("RUN_STARTED_AT"));
const chainId = integer("LOAD_CHAIN_ID", 31_337, 1, Number.MAX_SAFE_INTEGER);
const marketCount = integer("SEED_MARKETS", 100, 100, 100);
const listingsPerMarket = integer(
  "SEED_LISTINGS_PER_MARKET",
  1_000,
  1_000,
  1_000,
);
if (process.env.CPREDICT_LOAD_CONFIRM !== "I_UNDERSTAND_RESOURCE_USAGE") {
  throw new Error(
    "production PostgreSQL seed requires explicit load acknowledgement",
  );
}
if (Number.isNaN(runStartedAt.valueOf()))
  throw new TypeError("RUN_STARTED_AT must be an ISO timestamp");
const parsedDatabaseUrl = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost", "[::1]", "::1"].includes(
    parsedDatabaseUrl.hostname,
  )
) {
  throw new Error("load PostgreSQL must be loopback-only");
}

const sql = postgres(databaseUrl, {
  max: 4,
  idle_timeout: 10,
  connect_timeout: 5,
  prepare: true,
  onnotice: () => undefined,
});

try {
  const [identity] = await sql`
    SELECT current_database() AS database_name,
           current_setting('server_version') AS server_version,
           current_setting('data_directory') AS data_directory,
           current_setting('listen_addresses') AS listen_addresses,
           current_setting('port')::int AS port,
           current_setting('checkpoint_timeout') AS checkpoint_timeout,
           pg_postmaster_start_time() AS postmaster_start_time,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
           to_regclass('public.markets')::text AS markets_table
  `;
  if (identity === undefined)
    throw new Error("PostgreSQL identity query returned no row");
  if (identity.markets_table !== null)
    throw new Error("refusing non-fresh load database schema");
  if (identity.server_version !== "17.10")
    throw new Error("load PostgreSQL version is not 17.10");
  if (identity.checkpoint_timeout !== "10min") {
    throw new Error("load PostgreSQL checkpoint_timeout must be 10min");
  }
  if ((await realpath(identity.data_directory)) !== expectedDataDirectory) {
    throw new Error("load PostgreSQL data directory identity mismatch");
  }
  if (identity.listen_addresses !== "127.0.0.1")
    throw new Error("load PostgreSQL is not loopback-only");
  if (
    identity.postmaster_start_time.valueOf() <
    runStartedAt.valueOf() - 5_000
  ) {
    throw new Error("load PostgreSQL is older than this RUN_ID");
  }

  const migrationNames = [
    "001_indexer.sql",
    "002_settlement_evidence.sql",
    "003_read_api_indexes.sql",
  ];
  const migrations = [];
  for (const name of migrationNames) {
    const path = resolve(projectRoot, "offchain/indexer/migrations", name);
    const source = await readFile(path, "utf8");
    await sql.unsafe(source);
    migrations.push({ name, sha256: sha256(source) });
  }

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO markets (
        chain_id, market, creator, deployment_mode, outcome_count, close_at,
        market_primary_cap, creator_bond, state, winning_outcome, evidence_hash,
        created_block, updated_block, confirmation_status
      )
      SELECT ${chainId},
             ('0x' || lpad(market_number::text, 40, '0'))::char(42),
             ('0x' || lpad((100000 + market_number)::text, 40, '0'))::char(42),
             0, 2, 2000000000, 5000000000, 100000000, 0, NULL, NULL,
             market_number, market_number, 'confirmed'
      FROM generate_series(1, ${marketCount}) AS market_number
    `;
    await transaction`
      INSERT INTO listings (
        chain_id, listing_id, vault, seller, outcome_id, remaining_units, unit_price,
        expires_at, active, created_block, updated_block, confirmation_status
      )
      SELECT ${chainId},
             ('0x' || lpad(to_hex(listing_number), 64, '0'))::char(66),
             ('0x' || lpad((((listing_number - 1) / ${listingsPerMarket}) + 1)::text, 40, '0'))::char(42),
             ('0x' || lpad((200000 + (listing_number % 10000))::text, 40, '0'))::char(42),
             listing_number % 2, 1000000, 1000000 + (listing_number % 1000000),
             2000000000, TRUE, listing_number, listing_number, 'confirmed'
      FROM generate_series(1, ${marketCount * listingsPerMarket}) AS listing_number
    `;
  });
  await sql`ANALYZE markets`;
  await sql`ANALYZE listings`;
  // The commercial read gate must measure the production composition, not a
  // five-minute checkpoint of the one-off 100k-row fixture seed. Wait until
  // those dirty pages are durable before any timed request is admitted.
  await sql`CHECKPOINT`;
  const bulkSeedCheckpointCompletedAt = new Date().toISOString();

  const [{ markets, listings }] = await sql`
    SELECT (SELECT count(*)::int FROM markets WHERE chain_id = ${chainId}) AS markets,
           (SELECT count(*)::int FROM listings WHERE chain_id = ${chainId}) AS listings
  `;
  if (markets !== marketCount || listings !== marketCount * listingsPerMarket) {
    throw new Error("seeded PostgreSQL dataset count mismatch");
  }

  const marketAddress = decimalAddress(1);
  const plans = {
    markets: await explain(
      sql,
      `
      SELECT * FROM markets WHERE chain_id = $1
      ORDER BY created_block DESC, market DESC LIMIT 21
    `,
      [chainId],
    ),
    listings: await explain(
      sql,
      `
      SELECT * FROM listings
      WHERE chain_id = $1 AND vault = $2 AND active = TRUE
      ORDER BY updated_block DESC, listing_id DESC LIMIT 21
    `,
      [chainId, marketAddress],
    ),
    market: await explain(
      sql,
      `
      SELECT * FROM markets WHERE chain_id = $1 AND market = $2
    `,
      [chainId, marketAddress],
    ),
  };
  const indexes = Object.fromEntries(
    Object.entries(plans).map(([key, plan]) => [
      key,
      [...new Set(collectIndexes(plan))],
    ]),
  );
  const requiredIndexNames = [
    "markets_chain_created_idx",
    "listings_chain_active_updated_idx",
    "listings_vault_active_idx",
    "fills_listing_block_idx",
    "positions_owner_updated_idx",
  ];
  const availableIndexRows = await sql`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = ANY(${requiredIndexNames})
    ORDER BY indexname
  `;
  const availableIndexes = availableIndexRows.map((row) => row.indexname);
  if (availableIndexes.length !== requiredIndexNames.length) {
    throw new Error("required production read index is missing");
  }
  if (indexes.listings.length === 0) {
    throw new Error("100k listing representative query did not use an index");
  }

  const report = {
    schemaVersion: 1,
    lane: "production-Fastify-PostgreSQL17-seed",
    runId,
    observedAt: new Date().toISOString(),
    chainId,
    postgres: {
      serverVersion: identity.server_version,
      databaseName: identity.database_name,
      port: identity.port,
      listenAddresses: identity.listen_addresses,
      dataDirectory: expectedDataDirectory,
      postmasterStartTime: identity.postmaster_start_time.toISOString(),
      systemIdentifier: identity.system_identifier,
      checkpointTimeout: identity.checkpoint_timeout,
    },
    migrations,
    dataset: { markets, listings, listingsPerMarket },
    availableIndexes,
    representativeQueryIndexes: indexes,
    thresholds: {
      freshPostgresIdentity: true,
      exactDataset: true,
      requiredReadIndexesPresent: true,
      largeListingQueryUsesIndex: true,
      bulkSeedCheckpointCompleted: true,
    },
    bulkSeedCheckpointCompletedAt,
    proofBoundary:
      "Fresh loopback PostgreSQL 17.10 with the production Indexer schema and query store; the one-off fixture seed was checkpointed before timing; not Arbitrum RPC or deployed infrastructure.",
  };
  await writeJsonAtomically(reportPath, report);
  await writeJsonAtomically(`${reportPath}.query-plans.json`, plans);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await sql.end({ timeout: 5 });
}

async function explain(connection, statement, parameters) {
  const rows = await connection.unsafe(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
    parameters,
  );
  return rows[0]?.["QUERY PLAN"]?.[0] ?? null;
}

function collectIndexes(value) {
  if (value === null || typeof value !== "object") return [];
  const result = [];
  if (typeof value["Index Name"] === "string") result.push(value["Index Name"]);
  for (const child of Object.values(value))
    result.push(...collectIndexes(child));
  return result;
}

async function writeJsonAtomically(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
}

function integer(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer within [${minimum}, ${maximum}]`,
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function decimalAddress(value) {
  return `0x${String(value).padStart(40, "0")}`;
}
