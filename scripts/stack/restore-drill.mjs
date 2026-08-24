#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshotSql } from "./backup.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{8,62}$/;

export async function runRestoreDrill({ backupDirectory, run = spawnCapture, pipe = spawnWithInput }) {
  if (!backupDirectory) throw new Error("--backup <directory> is required");
  const directory = isAbsolute(backupDirectory) ? backupDirectory : resolve(ROOT, backupDirectory);
  const manifest = JSON.parse(await readFile(resolve(directory, "backup-manifest.json"), "utf8"));
  await validateBackupFiles(directory, manifest);
  const suffix = randomBytes(6).toString("hex");
  const container = `cpredict-restore-${suffix}`;
  const volume = `cpredict-restore-${suffix}`;
  const password = randomBytes(24).toString("base64url");
  if (!SAFE_ID.test(container) || !SAFE_ID.test(volume)) throw new Error("unsafe restore resource name");
  const env = { ...process.env, PGPASSWORD: password, POSTGRES_PASSWORD: password };
  const steps = [];
  const command = async (args, label) => {
    const result = await run("docker", args, { cwd: ROOT, env });
    steps.push({ label, exitCode: result.code });
    if (result.code !== 0) throw new Error(`${label} failed (${result.code}): ${result.stderr.slice(-2000)}`);
    return result;
  };
  let cleanupError = null;
  try {
    await command(["volume", "create", volume], "create disposable volume");
    await command([
      "run", "--detach", "--name", container, "--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
      "--tmpfs", "/var/run/postgresql:rw,noexec,nosuid,size=4m", "--security-opt", "no-new-privileges:true",
      "--volume", `${volume}:/var/lib/postgresql/data`, "--env", "POSTGRES_USER=restore_admin",
      "--env", "POSTGRES_PASSWORD", "--env", "POSTGRES_DB=postgres", "postgres:17.10-bookworm",
    ], "start disposable PostgreSQL");
    await waitForPostgres(run, container, env);
    for (const database of ["cpredict_indexer", "cpredict_paymaster"])
      await command(["exec", "-e", "PGPASSWORD", container, "createdb", "-U", "restore_admin", database], `create ${database}`);
    for (const [name, database] of [["indexer", "cpredict_indexer"], ["paymaster", "cpredict_paymaster"]]) {
      const result = await pipe("docker", [
        "exec", "-i", "-e", "PGPASSWORD", container, "pg_restore", "-U", "restore_admin",
        "-d", database, "--no-owner", "--no-privileges", "--exit-on-error",
      ], { cwd: ROOT, env, inputPath: resolve(directory, manifest.dumps[name].file) });
      steps.push({ label: `restore ${name}`, exitCode: result.code });
      if (result.code !== 0) throw new Error(`restore ${name} failed (${result.code}): ${result.stderr.slice(-2000)}`);
    }
    await verifyMigrations(pipe, container, env, manifest.migrations);
    const snapshots = {
      indexer: await snapshot(run, container, env, "cpredict_indexer", "indexer"),
      paymaster: await snapshot(run, container, env, "cpredict_paymaster", "paymaster"),
    };
    compareSnapshots(manifest.snapshots, snapshots);
    const report = {
      schemaVersion: "cpredict.restore-drill.v1",
      evidenceClass: "LOCAL_RESTORE_DRILL",
      chainId: 421614,
      status: "PASS",
      generatedAt: new Date().toISOString(),
      backupManifestSha256: await sha256File(resolve(directory, "backup-manifest.json")),
      deploymentIdentity: manifest.deploymentIdentity,
      sourceManifestSha256: manifest.sourceManifestSha256,
      disposableResource: { container, volume },
      snapshots,
      steps,
    };
    await writeFile(resolve(directory, "restore-drill-report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    return report;
  } finally {
    const removeContainer = await run("docker", ["rm", "--force", container], { cwd: ROOT, env });
    const removeVolume = await run("docker", ["volume", "rm", "--force", volume], { cwd: ROOT, env });
    if (![0, 1].includes(removeContainer.code) || ![0, 1].includes(removeVolume.code))
      cleanupError = new Error("restore drill cleanup did not complete");
    if (cleanupError) throw cleanupError;
  }
}

export async function validateBackupFiles(directory, manifest) {
  if (manifest.schemaVersion !== "cpredict.stack-backup.v1" || manifest.chainId !== 421614)
    throw new Error("backup manifest schema or chain is invalid");
  for (const name of ["indexer", "paymaster"]) {
    const record = manifest.dumps?.[name];
    if (!record || basename(record.file) !== record.file) throw new Error(`${name} dump path is unsafe`);
    const path = resolve(directory, record.file);
    const metadata = await stat(path);
    if (metadata.size !== record.bytes || await sha256File(path) !== record.sha256)
      throw new Error(`${name} dump hash or size mismatch`);
  }
}

export function compareSnapshots(expected, actual) {
  for (const database of ["indexer", "paymaster"]) {
    if (stableJson(expected[database]) !== stableJson(actual[database]))
      throw new Error(`${database} rows, projections, checkpoint or budget balances changed during restore`);
  }
}

async function waitForPostgres(run, container, env) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await run("docker", ["exec", "-e", "PGPASSWORD", container, "pg_isready", "-U", "restore_admin", "-d", "postgres"], { cwd: ROOT, env });
    if (result.code === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error("disposable PostgreSQL did not become ready");
}

async function verifyMigrations(pipe, container, env, migrations) {
  for (const migration of migrations) {
    const database = migration.path.includes("paymaster-service") ? "cpredict_paymaster" : "cpredict_indexer";
    const path = resolve(ROOT, migration.path);
    if (await sha256File(path) !== migration.sha256) throw new Error(`${migration.path} source hash drifted`);
    const result = await pipe("docker", [
      "exec", "-i", "-e", "PGPASSWORD", container, "psql", "-U", "restore_admin", "-d", database,
      "--set=ON_ERROR_STOP=1",
    ], { cwd: ROOT, env, inputPath: path });
    if (result.code !== 0) throw new Error(`${migration.path} idempotency verification failed`);
  }
}

async function snapshot(run, container, env, database, kind) {
  const tables = kind === "indexer"
    ? ["canonical_blocks", "chain_events", "chain_checkpoints", "registered_markets", "markets", "listings", "fills", "positions", "claims"]
    : ["sponsor_budget_global_usage", "sponsor_budget_user_usage", "sponsor_budget_leases"];
  const result = await run("docker", [
    "exec", "-e", "PGPASSWORD", container, "psql", "-U", "restore_admin", "-d", database,
    "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", "--command",
    buildSnapshotSql(kind, tables),
  ], { cwd: ROOT, env });
  if (result.code !== 0) throw new Error(`${database} restored snapshot failed`);
  return JSON.parse(result.stdout.trim());
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

async function spawnWithInput(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "ignore", "pipe"] });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const input = createReadStream(options.inputPath);
    input.once("error", reject);
    input.pipe(child.stdin);
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code: code ?? 1, stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function sha256File(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--backup") throw new Error("usage: stack:restore-drill -- --backup <directory>");
  return argv[1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRestoreDrill({ backupDirectory: parseArgs(process.argv.slice(2)) })
    .then((report) => process.stdout.write(`${report.status} restore drill\n`))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
