import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBackupManifest } from "./backup.mjs";
import { compareSnapshots, validateBackupFiles } from "./restore-drill.mjs";

const sha = "a".repeat(64);

test("backup manifest binds deployment, migrations, dumps and snapshots", () => {
  const result = buildBackupManifest({
    generatedAt: "2026-08-21T00:00:00.000Z",
    packageManifest: { sourceManifestSha256: sha, deploymentIdentity: "b".repeat(24), inputSha256: "c".repeat(64) },
    postgresVersion: "postgres (PostgreSQL) 17.10",
    dumps: { indexer: { file: "indexer.dump", bytes: 1, sha256: sha }, paymaster: { file: "paymaster.dump", bytes: 2, sha256: sha } },
    migrations: [{ path: "x", sha256: sha }],
    snapshots: { indexer: { markets: "1" }, paymaster: { sponsor_budget_leases: "2" } },
  });
  assert.equal(result.chainId, 421614);
  assert.equal(result.deploymentIdentity, "b".repeat(24));
});

test("restore comparison fails closed on row-count drift", () => {
  assert.doesNotThrow(() => compareSnapshots({ indexer: { markets: "1" }, paymaster: { leases: "2" } }, { indexer: { markets: "1" }, paymaster: { leases: "2" } }));
  assert.throws(() => compareSnapshots({ indexer: { markets: "1" }, paymaster: { leases: "2" } }, { indexer: { markets: "0" }, paymaster: { leases: "2" } }), /changed during restore/);
});

test("backup file validation rejects traversal and tampering", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-backup-test-"));
  await writeFile(join(root, "indexer.dump"), "i");
  await writeFile(join(root, "paymaster.dump"), "p");
  const { createHash } = await import("node:crypto");
  const record = (file, value) => ({ file, bytes: 1, sha256: createHash("sha256").update(value).digest("hex") });
  const manifest = { schemaVersion: "cpredict.stack-backup.v1", chainId: 421614, dumps: { indexer: record("indexer.dump", "i"), paymaster: record("paymaster.dump", "p") } };
  await assert.doesNotReject(validateBackupFiles(root, manifest));
  manifest.dumps.indexer.file = "../indexer.dump";
  await assert.rejects(validateBackupFiles(root, manifest), /unsafe/);
});
