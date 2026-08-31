#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateBackupFiles } from "./restore-drill.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BACKUP_ROOT = resolve(ROOT, "runtime/arbitrum-sepolia/backups");

export function parsePruneArgs(argv) {
  const output = { apply: false, keep: 14, minimumAgeDays: 7 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") output.apply = true;
    else if (["--keep", "--minimum-age-days"].includes(flag)) {
      const value = argv[++index];
      if (value === undefined || !/^[0-9]+$/.test(value))
        throw new Error(`${flag} requires an integer`);
      const number = Number(value);
      if (flag === "--keep") output.keep = number;
      else output.minimumAgeDays = number;
    } else throw new Error(`unknown option ${flag}`);
  }
  if (output.keep < 7 || output.keep > 365)
    throw new Error("--keep must be between 7 and 365");
  if (output.minimumAgeDays < 1 || output.minimumAgeDays > 3650)
    throw new Error("--minimum-age-days must be between 1 and 3650");
  return output;
}

export async function pruneBackups({
  backupRoot = BACKUP_ROOT,
  keep = 14,
  minimumAgeDays = 7,
  apply = false,
  now = Date.now(),
} = {}) {
  if (keep < 7) throw new Error("at least seven backups must be retained");
  const canonicalRoot = await realpath(backupRoot);
  const entries = await readdir(canonicalRoot, { withFileTypes: true });
  const backups = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = resolve(canonicalRoot, entry.name);
    assertWithin(directory, canonicalRoot);
    const manifestPath = resolve(directory, "backup-manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      await validateBackupFiles(directory, manifest);
    } catch {
      continue;
    }
    const generatedAt = Date.parse(manifest.generatedAt);
    if (!Number.isFinite(generatedAt) || generatedAt > now + 5 * 60_000)
      continue;
    backups.push({ directory, manifestPath, generatedAt });
  }
  backups.sort((a, b) => b.generatedAt - a.generatedAt);
  if (backups.length === 0)
    return { status: "NO_VALID_BACKUPS", candidates: [], removed: [] };
  await requireVerifiedRestore(backups[0]);
  const cutoff = now - minimumAgeDays * 86_400_000;
  const candidates = backups
    .slice(keep)
    .filter((backup) => backup.generatedAt <= cutoff);
  const removed = [];
  if (apply) {
    for (const backup of candidates) {
      const metadata = await lstat(backup.directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error(
          `refusing unsafe backup target ${basename(backup.directory)}`,
        );
      assertWithin(backup.directory, canonicalRoot);
      await rm(backup.directory, { recursive: true, force: false });
      removed.push(backup.directory);
    }
  }
  return {
    status: apply ? "APPLIED" : "DRY_RUN",
    retained: backups.length - removed.length,
    candidates: candidates.map((backup) => backup.directory),
    removed,
  };
}

async function requireVerifiedRestore(backup) {
  const reportPath = resolve(backup.directory, "restore-drill-report.json");
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    throw new Error(
      "newest valid backup has no restore drill report; refusing retention changes",
    );
  }
  const manifestSha256 = createHash("sha256")
    .update(await readFile(backup.manifestPath))
    .digest("hex");
  if (
    report.schemaVersion !== "cpredict.restore-drill.v1" ||
    report.status !== "PASS" ||
    report.backupManifestSha256 !== manifestSha256
  )
    throw new Error(
      "newest valid backup restore report is missing, failed or mismatched",
    );
}

function assertWithin(path, parent) {
  const child = relative(parent, path);
  if (child === "" || child === ".")
    throw new Error("backup target cannot equal backup root");
  if (child.startsWith("..") || child.startsWith("/"))
    throw new Error("backup target escapes backup root");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = parsePruneArgs(process.argv.slice(2));
  pruneBackups(options)
    .then((result) => {
      for (const path of result.candidates)
        process.stdout.write(
          `${options.apply ? "REMOVE" : "WOULD_REMOVE"} ${path}\n`,
        );
      process.stdout.write(
        `${result.status}; retained=${result.retained ?? 0}; candidates=${result.candidates.length}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
