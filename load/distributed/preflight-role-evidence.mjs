import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const role = process.argv[2];
if (!new Set(["sut", "load", "chain"]).has(role))
  throw new Error("preflight role must be sut, load, or chain");
const startedAt = Date.parse(required("CPREDICT_ROLE_STARTED_AT"));
if (!Number.isFinite(startedAt))
  throw new Error("CPREDICT_ROLE_STARTED_AT is invalid");

const declaredIdentity = required("CPREDICT_HOST_IDENTITY");
const identitySource = required("CPREDICT_HOST_IDENTITY_SOURCE");
if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/.test(declaredIdentity))
  throw new Error("CPREDICT_HOST_IDENTITY is invalid");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(identitySource))
  throw new Error("CPREDICT_HOST_IDENTITY_SOURCE is invalid");

const inputs = {
  sourceManifest: required("CPREDICT_SOURCE_MANIFEST_PATH"),
  releaseConfig: required("CPREDICT_RELEASE_CONFIG_PATH"),
  clockEvidence: required("CPREDICT_CLOCK_EVIDENCE_PATH"),
  hostIdentityEvidence: required("CPREDICT_HOST_IDENTITY_EVIDENCE_PATH"),
};
for (const [name, path] of Object.entries(inputs)) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${name} must be a regular non-symlink file`);
  if (metadata.size < 1 || metadata.size > 1_048_576)
    throw new Error(`${name} size must be within [1, 1048576]`);
}

const sourceManifestBody = await readFile(inputs.sourceManifest);
const releaseConfigBody = await readFile(inputs.releaseConfig);
const releaseConfig = JSON.parse(releaseConfigBody);
const migrationsSha256 = await inventoryTree(
  resolve("offchain/indexer/migrations"),
);
const commitSha = required("CPREDICT_GIT_COMMIT_SHA");
const runtimeImageDigest = required("CPREDICT_RUNTIME_IMAGE_DIGEST");
if (!/^[0-9a-f]{40}$/.test(commitSha))
  throw new Error("CPREDICT_GIT_COMMIT_SHA must be a lowercase commit SHA");
if (!/^sha256:[0-9a-f]{64}$/.test(runtimeImageDigest))
  throw new Error("CPREDICT_RUNTIME_IMAGE_DIGEST is invalid");
if (releaseConfig.schemaVersion !== 1)
  throw new Error("release config schemaVersion must be 1");
if (releaseConfig.gitCommitSha !== commitSha)
  throw new Error("release config commit does not match role commit");
if (releaseConfig.sourceManifestSha256 !== sha256(sourceManifestBody))
  throw new Error("release config source manifest digest mismatch");
if (releaseConfig.migrationsSha256 !== migrationsSha256)
  throw new Error("release config migration digest mismatch");
if (releaseConfig.runtimeImageDigests?.[role] !== runtimeImageDigest)
  throw new Error(`release config image digest mismatch for ${role}`);

const clockSource = required("CPREDICT_CLOCK_SOURCE");
const clockMaxOffsetMs = Number(required("CPREDICT_CLOCK_MAX_OFFSET_MS"));
if (
  !Number.isFinite(clockMaxOffsetMs) ||
  clockMaxOffsetMs < 0 ||
  clockMaxOffsetMs > 100
) {
  throw new Error("CPREDICT_CLOCK_MAX_OFFSET_MS must be within [0, 100]");
}
const clockEvidence = JSON.parse(await readFile(inputs.clockEvidence, "utf8"));
const clockObservedAt = Date.parse(clockEvidence.observedAt);
if (
  clockEvidence.schemaVersion !== 1 ||
  clockEvidence.source !== clockSource ||
  clockEvidence.maxOffsetMs !== clockMaxOffsetMs ||
  !Number.isFinite(clockObservedAt)
)
  throw new Error("clock evidence does not match the declared clock state");
const now = Date.now();
if (clockObservedAt < startedAt - 60_000 || clockObservedAt > now + 5_000) {
  throw new Error(
    "clock evidence must be observed within 60 seconds before preflight",
  );
}

validateTargets(role);
process.stdout.write(`preflighted ${role} evidence inputs for ${commitSha}\n`);

function validateTargets(expectedRole) {
  const sut = secureOrigin("SUT_BASE_URL", "https:");
  const websocket = secureWebsocketTarget("SUT_WS_URL");
  if (sut.host !== websocket.host)
    throw new Error(
      "SUT_BASE_URL and SUT_WS_URL must identify the same SUT host and port",
    );
  if (expectedRole === "sut" || expectedRole === "chain") {
    const chain = secureOrigin("CHAIN_RPC_URL", "https:");
    if (chain.hostname === sut.hostname)
      throw new Error(
        "CHAIN_RPC_URL and SUT_BASE_URL must identify distinct hosts",
      );
  }
  if (expectedRole === "chain") {
    const local = new URL(required("CHAIN_LOCAL_RPC_URL"));
    if (local.protocol !== "http:" || !isLoopback(local.hostname))
      throw new Error("CHAIN_LOCAL_RPC_URL must be loopback HTTP");
  }
}

function secureOrigin(name, protocol) {
  const url = new URL(required(name));
  if (
    url.protocol !== protocol ||
    isLoopback(url.hostname) ||
    url.hostname === "0.0.0.0"
  ) {
    throw new Error(`${name} must be a non-loopback ${protocol} origin`);
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${name} must be a credential-free normalized origin`);
  }
  return url;
}

function secureWebsocketTarget(name) {
  const url = new URL(required(name));
  if (
    url.protocol !== "wss:" ||
    isLoopback(url.hostname) ||
    url.hostname === "0.0.0.0"
  ) {
    throw new Error(`${name} must be a non-loopback wss: target`);
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/v1/stream" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `${name} must be exactly a credential-free /v1/stream target`,
    );
  }
  return url;
}

async function inventoryTree(directory) {
  const hash = createHash("sha256");
  const names = await readdir(directory);
  if (names.length === 0) throw new Error("migration inventory is empty");
  for (const name of names.sort()) {
    const path = resolve(directory, name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new Error(`migration is not a regular file: ${name}`);
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
}

function isLoopback(host) {
  return new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(host);
}
