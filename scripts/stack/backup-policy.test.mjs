import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parsePruneArgs, pruneBackups } from "./prune-backups.mjs";
import { createVerifiedBackup } from "./verified-backup.mjs";

async function backupFixture(root, index, generatedAt, restorePass = false) {
  const directory = join(root, `backup-${String(index).padStart(2, "0")}`);
  await mkdir(directory);
  await writeFile(join(directory, "indexer.dump"), `indexer-${index}`);
  await writeFile(join(directory, "paymaster.dump"), `paymaster-${index}`);
  const record = async (name) => {
    const value = await readFile(join(directory, `${name}.dump`));
    return {
      file: `${name}.dump`,
      bytes: value.length,
      sha256: createHash("sha256").update(value).digest("hex"),
    };
  };
  const manifest = {
    schemaVersion: "cpredict.stack-backup.v1",
    chainId: 421614,
    generatedAt,
    dumps: {
      indexer: await record("indexer"),
      paymaster: await record("paymaster"),
    },
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(join(directory, "backup-manifest.json"), manifestText);
  if (restorePass) {
    await writeFile(
      join(directory, "restore-drill-report.json"),
      `${JSON.stringify({
        schemaVersion: "cpredict.restore-drill.v1",
        status: "PASS",
        backupManifestSha256: createHash("sha256")
          .update(manifestText)
          .digest("hex"),
      })}\n`,
    );
  }
  return directory;
}

test("verified backup completes only after an exact restore drill pass", async () => {
  const value = await createVerifiedBackup({
    backup: async () => ({ directory: "/safe/backup" }),
    restore: async ({ backupDirectory }) => ({
      status: "PASS",
      backupDirectory,
    }),
  });
  assert.equal(value.directory, "/safe/backup");
  await assert.rejects(
    createVerifiedBackup({
      backup: async () => ({ directory: "/safe/backup" }),
      restore: async () => ({ status: "FAIL" }),
    }),
    /did not pass/,
  );
});

test("backup retention is dry-run by default and requires a verified newest backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-backups-"));
  const now = Date.parse("2026-08-30T00:00:00.000Z");
  for (let index = 0; index < 9; index += 1) {
    const generatedAt = new Date(now - index * 86_400_000).toISOString();
    await backupFixture(root, index, generatedAt, index === 0);
  }
  const dryRun = await pruneBackups({
    backupRoot: root,
    keep: 7,
    minimumAgeDays: 1,
    now,
  });
  assert.equal(dryRun.status, "DRY_RUN");
  assert.equal(dryRun.candidates.length, 2);
  await stat(dryRun.candidates[0]);
  const applied = await pruneBackups({
    backupRoot: root,
    keep: 7,
    minimumAgeDays: 1,
    now,
    apply: true,
  });
  assert.equal(applied.removed.length, 2);
  await assert.rejects(stat(applied.removed[0]));
});

test("backup retention refuses deletion when newest backup was not restore-verified", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-backups-"));
  await backupFixture(root, 0, "2026-08-30T00:00:00.000Z", false);
  await assert.rejects(
    pruneBackups({ backupRoot: root, keep: 7 }),
    /no restore drill report/,
  );
});

test("backup retention parser keeps a safe minimum and requires explicit apply", () => {
  assert.deepEqual(parsePruneArgs([]), {
    apply: false,
    keep: 14,
    minimumAgeDays: 7,
  });
  assert.deepEqual(
    parsePruneArgs(["--apply", "--keep", "30", "--minimum-age-days", "14"]),
    {
      apply: true,
      keep: 30,
      minimumAgeDays: 14,
    },
  );
  assert.throws(() => parsePruneArgs(["--keep", "6"]), /between 7 and 365/);
});
