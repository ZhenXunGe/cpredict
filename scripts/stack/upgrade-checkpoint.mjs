#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStackConfiguration } from "./config.mjs";
import { createVerifiedBackup } from "./verified-backup.mjs";
import { verifyRuntime } from "./verify-runtime.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function createUpgradeCheckpoint({
  root = ROOT,
  configuration,
  sponsorship = false,
  generatedAt = new Date().toISOString(),
  outputRoot = resolve(root, "runtime/arbitrum-sepolia/upgrade-checkpoints"),
  run = runCommand,
  verify = verifyRuntime,
  backup = createVerifiedBackup,
} = {}) {
  const canonicalRoot = await realpath(root);
  const status = run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    root,
  );
  ensureSuccess(status, "Git worktree check");
  if (status.stdout.trim().length > 0)
    throw new Error("Git worktree must be clean before an upgrade checkpoint");
  const commit = run("git", ["rev-parse", "HEAD"], root);
  ensureSuccess(commit, "Git commit lookup");
  if (!/^[0-9a-f]{40}$/.test(commit.stdout.trim()))
    throw new Error("Git HEAD is not a full commit hash");

  const config =
    configuration ?? (await loadStackConfiguration({ sponsorship }));
  const checks = await verify({ configuration: config, sponsorship, root });
  if (checks.some((check) => check.status === "FAIL"))
    throw new Error(
      "current stack runtime verification failed; refusing upgrade checkpoint",
    );

  const verified = await backup();
  const backupDirectory = await realpath(verified.directory);
  assertWithin(backupDirectory, canonicalRoot, "verified backup");
  const backupManifestPath = resolve(backupDirectory, "backup-manifest.json");
  const restoreReportPath = resolve(
    backupDirectory,
    "restore-drill-report.json",
  );
  const packageManifestPath = resolve(
    config.runtimeRoot,
    "package-manifest.json",
  );

  const base = [
    "compose",
    "--project-directory",
    root,
    "--env-file",
    config.secretPath,
    "--env-file",
    config.publicPath,
    "-f",
    resolve(root, "compose.yaml"),
  ];
  if (sponsorship) base.push("--profile", "sponsorship");
  const ps = run(
    "docker",
    [...base, "ps", "--all", "--format", "json"],
    root,
    config.environment,
  );
  const images = run(
    "docker",
    [...base, "images", "--format", "json"],
    root,
    config.environment,
  );
  ensureSuccess(ps, "Compose process inventory");
  ensureSuccess(images, "Compose image inventory");

  const checkpoint = {
    schemaVersion: "cpredict.stack-upgrade-checkpoint.v1",
    evidenceClass: "LOCAL_STACK_UPGRADE_CHECKPOINT",
    generatedAt,
    gitCommit: commit.stdout.trim(),
    sponsorship,
    runtimeVerification: checks,
    runtimePackage: {
      path: relative(canonicalRoot, packageManifestPath),
      sha256: await sha256File(packageManifestPath),
    },
    verifiedBackup: {
      path: relative(canonicalRoot, backupDirectory),
      manifestSha256: await sha256File(backupManifestPath),
      restoreReportSha256: await sha256File(restoreReportPath),
    },
    compose: {
      processes: parseJsonRecords(ps.stdout, "Compose process inventory"),
      images: parseJsonRecords(images.stdout, "Compose image inventory"),
    },
  };
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const canonicalOutputRoot = await realpath(outputRoot);
  assertWithin(canonicalOutputRoot, canonicalRoot, "checkpoint output");
  const id = generatedAt.replaceAll(/[:.]/g, "-");
  const path = resolve(canonicalOutputRoot, `${id}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
  return { path, checkpoint };
}

export function parseJsonRecords(text, label) {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error(`${label} is empty`);
  let records;
  try {
    const parsed = JSON.parse(trimmed);
    records = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    try {
      records = trimmed
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      throw new Error(`${label} is not valid JSON`);
    }
  }
  return validateRecords(records, label);
}

function validateRecords(records, label) {
  if (
    records.length === 0 ||
    records.some(
      (record) =>
        record === null || typeof record !== "object" || Array.isArray(record),
    )
  )
    throw new Error(`${label} must contain JSON objects`);
  return records;
}

function runCommand(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function ensureSuccess(result, label) {
  if (result.code !== 0) throw new Error(`${label} failed (${result.code})`);
}

function assertWithin(path, parent, label) {
  const child = relative(parent, path);
  if (
    child === "" ||
    child === "." ||
    child.startsWith("..") ||
    isAbsolute(child)
  )
    throw new Error(`${label} must stay inside the repository`);
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const sponsorship = process.argv.slice(2).includes("--sponsorship");
  const unknown = process.argv
    .slice(2)
    .filter((value) => value !== "--sponsorship");
  if (unknown.length > 0) {
    process.stderr.write(`unknown option ${unknown[0]}\n`);
    process.exitCode = 2;
  } else {
    createUpgradeCheckpoint({ sponsorship })
      .then(({ path }) => process.stdout.write(`UPGRADE CHECKPOINT ${path}\n`))
      .catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      });
  }
}
