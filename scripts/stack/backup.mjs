#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStackConfiguration } from "./config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const INDEXER_TABLES = [
  "canonical_blocks", "chain_events", "chain_checkpoints", "registered_markets",
  "markets", "listings", "fills", "positions", "claims", "activities",
  "activity_participants",
];
const PAYMASTER_TABLES = [
  "sponsor_budget_global_usage", "sponsor_budget_user_usage", "sponsor_budget_leases",
  "permit2_relay_intents",
];
const METADATA_TABLES = ["metadata_challenges", "market_publications"];

export async function createStackBackup({
  outputRoot = resolve(ROOT, "runtime/arbitrum-sepolia/backups"),
  configuration,
  run = spawnCapture,
  stream = spawnToFile,
  generatedAt = new Date().toISOString(),
} = {}) {
  const config = configuration ?? await loadStackConfiguration();
  const id = generatedAt.replaceAll(/[:.]/g, "-");
  const directory = resolve(outputRoot, id);
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const base = composeBase(config);
  const env = { ...process.env, ...config.environment, PGPASSWORD: config.secret.CPREDICT_STACK_BACKUP_PASSWORD };
  const dumps = {};
  for (const [name, database] of [
    ["indexer", "cpredict_indexer"],
    ["paymaster", "cpredict_paymaster"],
    ["metadata", "cpredict_metadata"],
  ]) {
    const path = resolve(directory, `${name}.dump`);
    await stream("docker", [
      ...base, "exec", "-T", "-e", "PGPASSWORD", "postgres", "pg_dump",
      "--username=cpredict_backup", `--dbname=${database}`, "--format=custom",
      "--compress=9", "--no-owner", "--no-privileges",
    ], { cwd: ROOT, env, outputPath: path });
    dumps[name] = await fileRecord(path);
  }
  const snapshots = {
    indexer: await databaseSnapshot(run, base, env, "cpredict_indexer", INDEXER_TABLES, "indexer"),
    paymaster: await databaseSnapshot(run, base, env, "cpredict_paymaster", PAYMASTER_TABLES, "paymaster"),
    metadata: await databaseSnapshot(run, base, env, "cpredict_metadata", METADATA_TABLES, "metadata"),
  };
  const packageManifestPath = resolve(config.runtimeRoot, "package-manifest.json");
  const packageManifest = JSON.parse(await readFile(packageManifestPath, "utf8"));
  const migrations = await migrationInventory();
  const version = await run("docker", [...base, "exec", "-T", "postgres", "postgres", "--version"], {
    cwd: ROOT, env,
  });
  ensureSuccess(version, "postgres version");
  const manifest = buildBackupManifest({
    generatedAt,
    packageManifest,
    postgresVersion: version.stdout.trim(),
    dumps,
    migrations,
    snapshots,
  });
  const manifestPath = resolve(directory, "backup-manifest.json");
  await atomicJson(manifestPath, manifest);
  await writeFile(resolve(directory, "SHA256SUMS"), checksumText({
    "backup-manifest.json": await sha256File(manifestPath),
    "indexer.dump": dumps.indexer.sha256,
    "paymaster.dump": dumps.paymaster.sha256,
    "metadata.dump": dumps.metadata.sha256,
  }), { mode: 0o600 });
  return { directory, manifest };
}

export function buildBackupManifest({ generatedAt, packageManifest, postgresVersion, dumps, migrations, snapshots }) {
  for (const key of ["indexer", "paymaster", "metadata"])
    if (!/^[0-9a-f]{64}$/.test(dumps[key]?.sha256 ?? "") || dumps[key].bytes <= 0)
      throw new Error(`${key} dump record is invalid`);
  return {
    schemaVersion: "cpredict.stack-backup.v1",
    evidenceClass: "LOCAL_STACK_BACKUP",
    chainId: 421614,
    generatedAt,
    sourceManifestSha256: packageManifest.sourceManifestSha256,
    deploymentIdentity: packageManifest.deploymentIdentity,
    deploymentInputSha256: packageManifest.inputSha256,
    postgresVersion,
    dumps,
    migrations,
    snapshots,
  };
}

async function databaseSnapshot(run, base, env, database, tables, kind) {
  const sql = buildSnapshotSql(kind, tables);
  const result = await run("docker", [
    ...base, "exec", "-T", "-e", "PGPASSWORD", "postgres", "psql",
    "--username=cpredict_backup", `--dbname=${database}`, "--tuples-only", "--no-align",
    "--set=ON_ERROR_STOP=1", "--command", sql,
  ], { cwd: ROOT, env });
  ensureSuccess(result, `${database} snapshot`);
  const parsed = JSON.parse(result.stdout.trim());
  if (Object.keys(parsed).sort().join(",") !== [...tables].sort().join(","))
    throw new Error(`${database} snapshot table inventory mismatch`);
  return parsed;
}

export function buildSnapshotSql(kind, tables) {
  const rows = tables.map((table) => `'${table}', (SELECT count(*)::text FROM ${table})`).join(",");
  if (kind === "indexer") return `
    SELECT json_build_object(
      'rows', json_build_object(${rows}),
      'marketStates', COALESCE((SELECT json_object_agg(state::text, count::text) FROM (SELECT state, count(*) FROM markets GROUP BY state ORDER BY state) grouped), '{}'::json),
      'listingProjection', json_build_object(
        'active', (SELECT count(*)::text FROM listings WHERE active),
        'remainingUnits', (SELECT COALESCE(sum(remaining_units), 0)::text FROM listings WHERE active),
        'fills', (SELECT count(*)::text FROM fills),
        'filledUnits', (SELECT COALESCE(sum(filled_units), 0)::text FROM fills),
        'gross', (SELECT COALESCE(sum(gross), 0)::text FROM fills)
      ),
      'checkpoint', COALESCE((SELECT json_build_object('chainId', chain_id::text, 'blockNumber', block_number::text, 'blockHash', block_hash) FROM chain_checkpoints ORDER BY block_number DESC LIMIT 1), 'null'::json)
    )::text;`;
  if (kind === "paymaster") return `
    SELECT json_build_object(
      'rows', json_build_object(${rows}),
      'budgetTotals', json_build_object(
        'globalReserved', (SELECT COALESCE(sum(reserved_cost), 0)::text FROM sponsor_budget_global_usage),
        'globalCommitted', (SELECT COALESCE(sum(committed_cost), 0)::text FROM sponsor_budget_global_usage),
        'userReserved', (SELECT COALESCE(sum(reserved_cost), 0)::text FROM sponsor_budget_user_usage),
        'userCommitted', (SELECT COALESCE(sum(committed_cost), 0)::text FROM sponsor_budget_user_usage),
        'createReserved', (SELECT COALESCE(sum(reserved_create_listing), 0)::text FROM sponsor_budget_user_usage),
        'createCommitted', (SELECT COALESCE(sum(committed_create_listing), 0)::text FROM sponsor_budget_user_usage),
        'cancelReserved', (SELECT COALESCE(sum(reserved_cancel_listing), 0)::text FROM sponsor_budget_user_usage),
        'cancelCommitted', (SELECT COALESCE(sum(committed_cancel_listing), 0)::text FROM sponsor_budget_user_usage)
      ),
      'leaseStates', COALESCE((SELECT json_object_agg(state, count::text) FROM (SELECT state, count(*) FROM sponsor_budget_leases GROUP BY state ORDER BY state) grouped), '{}'::json)
    )::text;`;
  if (kind === "metadata") return `
    SELECT json_build_object(
      'rows', json_build_object(${rows}),
      'publicationTotals', json_build_object(
        'published', (SELECT count(*)::text FROM market_publications),
        'openChallenges', (SELECT count(*)::text FROM metadata_challenges WHERE consumed_at IS NULL),
        'consumedChallenges', (SELECT count(*)::text FROM metadata_challenges WHERE consumed_at IS NOT NULL)
      )
    )::text;`;
  throw new Error(`unknown snapshot kind ${kind}`);
}

async function migrationInventory() {
  const files = [
    ...["001_indexer.sql", "002_settlement_evidence.sql", "003_read_api_indexes.sql", "004_market_metadata.sql", "005_activity_catalog.sql"].map(
      (name) => `offchain/indexer/migrations/${name}`,
    ),
    "offchain/paymaster-service/migrations/001_sponsor_budget.sql",
    "offchain/paymaster-service/migrations/002_permit2_relay_intents.sql",
    "offchain/metadata-service/migrations/001_metadata.sql",
  ];
  return Promise.all(files.map(async (path) => ({ path, sha256: await sha256File(resolve(ROOT, path)) })));
}

function composeBase(config) {
  return [
    "compose", "--project-directory", ROOT, "--env-file", config.secretPath,
    "--env-file", config.publicPath, "-f", resolve(ROOT, "compose.yaml"),
  ];
}

async function spawnCapture(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function spawnToFile(command, args, options) {
  await new Promise((resolvePromise, reject) => {
    const output = createWriteStream(options.outputPath, { flags: "wx", mode: 0o600 });
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    const stderr = [];
    let exitCode = null;
    let outputFinished = false;
    const settle = () => {
      if (exitCode === null || !outputFinished) return;
      if (exitCode === 0) resolvePromise();
      else reject(new Error(`pg_dump failed (${exitCode}): ${Buffer.concat(stderr).toString("utf8").slice(-2000)}`));
    };
    child.stdout.pipe(output);
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    output.once("error", reject);
    output.once("finish", () => { outputFinished = true; settle(); });
    child.once("close", (code) => { exitCode = code ?? 1; settle(); });
  });
}

function ensureSuccess(result, label) {
  if (result.code !== 0) throw new Error(`${label} failed (${result.code}): ${result.stderr.slice(-2000)}`);
}

async function fileRecord(path) {
  const metadata = await stat(path);
  if (metadata.size === 0) throw new Error(`${basename(path)} is empty`);
  return { file: basename(path), bytes: metadata.size, sha256: await sha256File(path) };
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function checksumText(values) {
  return `${Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([path, hash]) => `${hash}  ${path}`).join("\n")}\n`;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createStackBackup().then(({ directory }) => process.stdout.write(`BACKUP ${directory}\n`)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
