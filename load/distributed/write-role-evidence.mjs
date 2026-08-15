import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import {
  arch,
  cpus,
  hostname,
  networkInterfaces,
  platform,
  totalmem,
} from "node:os";
import { basename, resolve } from "node:path";

const role = argument(2, "role");
const reportDirectory = resolve(argument(3, "report directory"));
const runId = argument(4, "RUN_ID");
const runStatus = argument(5, "run status");
if (!new Set(["sut", "load", "chain"]).has(role))
  throw new Error("role must be sut, load, or chain");
if (!new Set(["completed", "aborted"]).has(runStatus))
  throw new Error("run status must be completed or aborted");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId))
  throw new Error("RUN_ID is invalid");

const declaredIdentity = required("CPREDICT_HOST_IDENTITY");
const identitySource = required("CPREDICT_HOST_IDENTITY_SOURCE");
const startedAt = new Date(required("CPREDICT_ROLE_STARTED_AT"));
const completedAt = new Date();
if (Number.isNaN(startedAt.valueOf()) || startedAt >= completedAt)
  throw new Error("role start time is invalid");
if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(declaredIdentity)) {
  throw new Error("CPREDICT_HOST_IDENTITY is invalid");
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(identitySource)) {
  throw new Error("CPREDICT_HOST_IDENTITY_SOURCE is invalid");
}

const sourceManifestPath = required("CPREDICT_SOURCE_MANIFEST_PATH");
const releaseConfigPath = required("CPREDICT_RELEASE_CONFIG_PATH");
const clockEvidencePath = required("CPREDICT_CLOCK_EVIDENCE_PATH");
const hostIdentityEvidencePath = required(
  "CPREDICT_HOST_IDENTITY_EVIDENCE_PATH",
);
for (const [source, name] of [
  [sourceManifestPath, "source-manifest.json"],
  [releaseConfigPath, "release-config.json"],
  [clockEvidencePath, "clock-evidence.json"],
  [hostIdentityEvidencePath, "host-identity-evidence.bin"],
]) {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${name} source must be a regular file`);
  if (metadata.size < 1 || metadata.size > 1_048_576)
    throw new Error(`${name} source size must be within [1, 1048576]`);
  await copyFile(source, resolve(reportDirectory, name));
}
const sourceManifestBody = await readFile(
  resolve(reportDirectory, "source-manifest.json"),
);
const releaseConfigBody = await readFile(
  resolve(reportDirectory, "release-config.json"),
);
const migrationInventory = await inventoryTree(
  resolve("offchain/indexer/migrations"),
);
const migrationsSha256 = migrationInventory.treeSha256;
await writeFile(
  resolve(reportDirectory, "migrations-manifest.json"),
  `${JSON.stringify({ schemaVersion: 1, ...migrationInventory }, null, 2)}\n`,
  "utf8",
);
const commitSha = required("CPREDICT_GIT_COMMIT_SHA");
const runtimeImageDigest = required("CPREDICT_RUNTIME_IMAGE_DIGEST");
if (!/^[0-9a-f]{40}$/.test(commitSha))
  throw new Error("CPREDICT_GIT_COMMIT_SHA must be a lowercase commit SHA");
if (!/^sha256:[0-9a-f]{64}$/.test(runtimeImageDigest))
  throw new Error("CPREDICT_RUNTIME_IMAGE_DIGEST is invalid");
const releaseConfig = JSON.parse(releaseConfigBody);
if (releaseConfig.schemaVersion !== 1)
  throw new Error("release config schemaVersion must be 1");
if (releaseConfig.gitCommitSha !== commitSha)
  throw new Error("release config commit does not match role commit");
if (releaseConfig.sourceManifestSha256 !== sha256(sourceManifestBody)) {
  throw new Error(
    "release config source manifest digest does not match role source manifest",
  );
}
if (releaseConfig.migrationsSha256 !== migrationsSha256) {
  throw new Error(
    "release config migration digest does not match role migration tree",
  );
}
if (releaseConfig.runtimeImageDigests?.[role] !== runtimeImageDigest) {
  throw new Error(
    `release config runtime image digest does not match ${role} role`,
  );
}
const clockSource = required("CPREDICT_CLOCK_SOURCE");
const clockMaxOffsetMs = Number(required("CPREDICT_CLOCK_MAX_OFFSET_MS"));
if (
  !Number.isFinite(clockMaxOffsetMs) ||
  clockMaxOffsetMs < 0 ||
  clockMaxOffsetMs > 100
) {
  throw new Error("CPREDICT_CLOCK_MAX_OFFSET_MS must be within [0, 100]");
}
const clockEvidence = JSON.parse(
  await readFile(resolve(reportDirectory, "clock-evidence.json"), "utf8"),
);
const clockObservedAt = Date.parse(clockEvidence.observedAt);
if (
  clockEvidence.schemaVersion !== 1 ||
  clockEvidence.source !== clockSource ||
  clockEvidence.maxOffsetMs !== clockMaxOffsetMs ||
  !Number.isFinite(clockObservedAt)
) {
  throw new Error("clock evidence does not match the declared clock state");
}
if (
  clockObservedAt < startedAt.valueOf() - 60_000 ||
  clockObservedAt > completedAt.valueOf()
) {
  throw new Error(
    "clock evidence must be observed within 60 seconds before or during the role window",
  );
}
const hostIdentityEvidenceBody = await readFile(
  resolve(reportDirectory, "host-identity-evidence.bin"),
);

const stages = JSON.parse(
  await readFile(resolve(reportDirectory, "stage-exit-codes.json"), "utf8"),
);
const files = [];
for (const name of (await readdir(reportDirectory)).sort()) {
  if (name === "role-evidence.json" || name.startsWith(".")) continue;
  const path = resolve(reportDirectory, name);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
  const body = await readFile(path);
  files.push({
    name: basename(path),
    bytes: body.byteLength,
    sha256: sha256(body),
  });
}
if (files.length === 0) throw new Error("role evidence has no artifacts");

const fingerprintInput =
  process.env.CPREDICT_MACHINE_FINGERPRINT_OVERRIDE ??
  JSON.stringify({
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    cpuModels: cpus().map((cpu) => cpu.model),
    totalMemory: totalmem(),
    macs: Object.values(networkInterfaces())
      .flat()
      .filter((entry) => entry !== undefined && !entry.internal)
      .map((entry) => entry.mac)
      .sort(),
  });
if (
  process.env.CPREDICT_MACHINE_FINGERPRINT_OVERRIDE !== undefined &&
  process.env.NODE_ENV !== "test"
) {
  throw new Error("machine fingerprint override is test-only");
}

const report = {
  schemaVersion: 1,
  lane: "distributed-commercial-load-role",
  runId,
  role,
  runStatus,
  observedAt: new Date().toISOString(),
  window: {
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    clockSource,
    clockMaxOffsetMs,
  },
  releaseBinding: {
    gitCommitSha: commitSha,
    sourceManifestSha256: sha256(sourceManifestBody),
    releaseConfigSha256: sha256(releaseConfigBody),
    migrationsSha256,
    runtimeImageDigest,
  },
  host: {
    identitySha256: sha256(declaredIdentity),
    identitySource,
    machineFingerprintSha256: sha256(fingerprintInput),
    platform: platform(),
    arch: arch(),
    identityEvidence: {
      path: "host-identity-evidence.bin",
      sha256: sha256(hostIdentityEvidenceBody),
      bytes: hostIdentityEvidenceBody.byteLength,
      assurance:
        "opaque-external-host-identity-evidence-not-cryptographically-verified-by-cpredict",
    },
  },
  targets: targets(),
  stages,
  artifacts: files,
};
const temporary = resolve(reportDirectory, ".role-evidence.json.tmp");
await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await rename(temporary, resolve(reportDirectory, "role-evidence.json"));
process.stdout.write(
  `wrote ${role} role evidence with ${files.length} artifacts\n`,
);

function targets() {
  const result = {};
  for (const [key, name] of [
    ["sutOrigin", "SUT_BASE_URL"],
    ["websocketTarget", "SUT_WS_URL"],
    ["chainRpcOrigin", "CHAIN_RPC_URL"],
  ]) {
    const value = process.env[name];
    if (value === undefined || value.length === 0) continue;
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.pathname = name === "SUT_WS_URL" ? "/v1/stream" : "/";
    parsed.search = "";
    parsed.hash = "";
    result[key] = name === "SUT_WS_URL" ? parsed.href : parsed.origin;
  }
  return result;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function inventoryTree(directory) {
  const hash = createHash("sha256");
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(`migration input is not a regular file: ${name}`);
    hash.update(name);
    hash.update("\0");
    const body = await readFile(path);
    hash.update(body);
    hash.update("\0");
    files.push({ name, bytes: body.byteLength, sha256: sha256(body) });
  }
  return { treeSha256: hash.digest("hex"), files };
}

function argument(index, label) {
  const value = process.argv[index];
  if (value === undefined || value.length === 0)
    throw new Error(`${label} is required`);
  return value;
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
}
