import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backupColumnsSql, backupDatabaseInventory, buildBackupManifest, buildSnapshotSql, createStackBackup } from "./backup.mjs";
import { compareSnapshots, snapshotTables, validateBackupFiles } from "./restore-drill.mjs";
import { readSourceRevision } from "./source-revision.mjs";

const sha = "a".repeat(64);

test("backup manifest binds deployment, migrations, dumps and snapshots", () => {
  const result = buildBackupManifest({
    generatedAt: "2026-08-21T00:00:00.000Z",
    packageManifest: { sourceManifestSha256: sha, deploymentIdentity: "b".repeat(24), inputSha256: "c".repeat(64) },
    postgresVersion: "postgres (PostgreSQL) 17.10",
    dumps: { indexer: { file: "indexer.dump", bytes: 1, sha256: sha }, paymaster: { file: "paymaster.dump", bytes: 2, sha256: sha }, metadata: { file: "metadata.dump", bytes: 3, sha256: sha } },
    migrations: [{ path: "x", sha256: sha }],
    snapshots: { indexer: { markets: "1" }, paymaster: { sponsor_budget_leases: "2" }, metadata: { market_publications: "3" } },
  });
  assert.equal(result.chainId, 421614);
  assert.equal(result.deploymentIdentity, "b".repeat(24));
});

test("restore comparison fails closed on row-count drift", () => {
  assert.doesNotThrow(() => compareSnapshots({ indexer: { markets: "1" }, paymaster: { leases: "2" }, metadata: { publications: "3" } }, { indexer: { markets: "1" }, paymaster: { leases: "2" }, metadata: { publications: "3" } }));
  assert.throws(() => compareSnapshots({ indexer: { markets: "1" }, paymaster: { leases: "2" }, metadata: { publications: "3" } }, { indexer: { markets: "0" }, paymaster: { leases: "2" }, metadata: { publications: "3" } }), /changed during restore/);
});

test("restore snapshots include catalog activity and metadata tables", () => {
  assert.deepEqual(snapshotTables("metadata"), ["metadata_challenges", "market_publications"]);
  assert.ok(snapshotTables("indexer").includes("activities"));
  assert.ok(snapshotTables("indexer").includes("activity_participants"));
  assert.throws(() => snapshotTables("unknown"), /unknown snapshot kind/);
});

test("backup file validation rejects traversal and tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-backup-test-"));
  await writeFile(join(root, "indexer.dump"), "i");
  await writeFile(join(root, "paymaster.dump"), "p");
  await writeFile(join(root, "metadata.dump"), "m");
  const { createHash } = await import("node:crypto");
  const record = (file, value) => ({ file, bytes: 1, sha256: createHash("sha256").update(value).digest("hex") });
  const manifest = { schemaVersion: "cpredict.stack-backup.v1", chainId: 421614, dumps: { indexer: record("indexer.dump", "i"), paymaster: record("paymaster.dump", "p"), metadata: record("metadata.dump", "m") } };
  await assert.doesNotReject(validateBackupFiles(root, manifest));
  manifest.dumps.indexer.file = "../indexer.dump";
  await assert.rejects(validateBackupFiles(root, manifest), /unsafe/);
});

test("v2 backup covers all five databases and actual application tables", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-backup-v2-"));
  t.after(() => rm(root, { recursive: true }));
  await writeFile(join(root, "package-manifest.json"), JSON.stringify({ sourceManifestSha256: sha, deploymentIdentity: "proof", inputSha256: sha }));
  const columns = { app_operations: ["id", "record"], chain_events: ["chain_id", "data"] };
  const snapshot = { rows: { app_operations: "1", chain_events: "2" }, columns, contentSha256: { app_operations: sha, chain_events: sha } };
  const databases = [];
  const revision = "b".repeat(40);
  const result = await createStackBackup({
    outputRoot: root,
    usdc: true,
    configuration: { runtimeRoot: root, environment: { CPREDICT_IMAGE_REVISION: revision }, secret: { CPREDICT_STACK_BACKUP_PASSWORD: "test" }, secretPath: join(root, "test.env"), publicPath: join(root, "public.env") },
    run: async (_command, args, { env }) => {
      assert.equal(env.CPREDICT_IMAGE_REVISION, revision);
      return { code: 0, stderr: "", stdout: args.includes("--version") ? "postgres (PostgreSQL) 17.10" : JSON.stringify(args.includes(backupColumnsSql) ? columns : snapshot) };
    },
    stream: async (_command, args, { outputPath, env }) => {
      assert.equal(env.CPREDICT_IMAGE_REVISION, revision);
      databases.push(args.find((arg) => arg.startsWith("--dbname=")));
      await writeFile(outputPath, "test archive bytes");
    },
  });
  assert.equal(result.manifest.schemaVersion, "cpredict.stack-backup.v2");
  assert.equal(databases.length, 5);
  assert.ok(databases.includes("--dbname=cpredict_usdc_indexer"));
  assert.deepEqual(result.manifest.snapshots["usdc-indexer"], snapshot);
  assert.ok(result.manifest.migrations.some((m) => m.path.endsWith("app-service/migrations/001_application.sql")));
  await assert.doesNotReject(validateBackupFiles(result.directory, result.manifest));
  assert.match(await readFile(join(result.directory, "SHA256SUMS"), "utf8"), /usdc-indexer.dump/);
  delete result.manifest.dumps["usdc-metadata"];
  await assert.rejects(validateBackupFiles(result.directory, result.manifest), /inventory/);
});

test("standalone backup resolves the source revision before its first Compose query", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-backup-revision-"));
  t.after(() => rm(root, { recursive: true }));
  let revision;
  await assert.rejects(createStackBackup({
    outputRoot: root,
    configuration: {
      runtimeRoot: root,
      environment: { CPREDICT_IMAGE_REVISION: undefined },
      secret: { CPREDICT_STACK_BACKUP_PASSWORD: "test" },
      secretPath: join(root, "test.env"),
      publicPath: join(root, "public.env"),
    },
    run: async (_command, _args, { env }) => {
      revision = env.CPREDICT_IMAGE_REVISION;
      throw new Error("query inspected without database access");
    },
  }), /query inspected without database access/);
  assert.equal(revision, readSourceRevision());
});

test("scoped backup dumps only the selected database and keeps an explicit restore inventory", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-scoped-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package-manifest.json"), JSON.stringify({ sourceManifestSha256: sha, deploymentIdentity: "proof", inputSha256: sha }));
  const dumped = [], columns = { market_publications: ["id"] };
  const result = await createStackBackup({
    outputRoot: root, databaseNames: ["metadata"],
    configuration: { runtimeRoot: root, environment: { CPREDICT_IMAGE_REVISION: "b".repeat(40) },
      secret: { CPREDICT_STACK_BACKUP_PASSWORD: "fixture" }, secretPath: join(root, "secret.env"), publicPath: join(root, "public.env") },
    run: async (_command, args) => ({ code: 0, stderr: "", stdout: args.includes("--version") ? "postgres 17.10" :
      JSON.stringify(args.includes(backupColumnsSql) ? columns : { rows: { market_publications: "1" }, columns }) }),
    stream: async (_command, args, options) => { dumped.push(args.find((a) => a.startsWith("--dbname="))); await writeFile(options.outputPath, "archive fixture"); },
  });
  assert.deepEqual(dumped, ["--dbname=cpredict_metadata"]);
  assert.equal(result.manifest.schemaVersion, "cpredict.stack-backup.v3");
  assert.deepEqual(result.manifest.databaseNames, ["metadata"]);
  assert.deepEqual(Object.keys(result.manifest.dumps), ["metadata"]);
  await assert.doesNotReject(validateBackupFiles(result.directory, result.manifest));
  result.manifest.databaseNames.push("indexer");
  await assert.rejects(validateBackupFiles(result.directory, result.manifest), /inventory/);
  assert.throws(() => backupDatabaseInventory({ names: [] }), /inventory/);
  assert.throws(() => backupDatabaseInventory({ names: ["metadata", "metadata"] }), /inventory/);
});

test("restore comparison catches content and operation changes even with unchanged row counts", () => {
  const before = { indexer: { rows: { app_operations: "1" }, contentSha256: { app_operations: sha } } };
  const after = structuredClone(before);
  after.indexer.contentSha256.app_operations = "b".repeat(64);
  assert.throws(() => compareSnapshots(before, after), /changed during restore/);
  assert.equal(backupDatabaseInventory().length, 3);
  assert.throws(() => buildSnapshotSql("indexer", ["app_operations;DROP DATABASE postgres"]), /unsafe/);
  assert.throws(() => buildSnapshotSql("indexer", ["app_operations"], { fingerprints: true, columns: { app_operations: ["id');SELECT"] } }), /unsafe/);
});
