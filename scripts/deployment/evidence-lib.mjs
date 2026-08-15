import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const BASE_SEPOLIA_CHAIN_ID = 84_532;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const CONTRACT_KEYS = Object.freeze([
  "timelock",
  "config",
  "emergencyController",
  "exposureGuard",
  "feeVault",
  "bondEscrow",
  "cloneImplementation",
  "fullMarketDeployer",
  "factory",
  "marketplace",
  "paymaster",
]);

export const EXTERNAL_KEYS = Object.freeze(["usdc", "permit2", "entryPoint"]);

export const REQUIRED_CANARY_STEPS = Object.freeze([
  "full.create",
  "clone.create",
  "primary.allowanceBuy",
  "primary.permit2Buy",
  "security.permit2ReplayRejected",
  "aa.approvalAndListing",
  "c2c.partialFill",
  "c2c.cancel",
  "c2c.terminalReturn",
  "resolve.winnerClaim",
  "resolve.earlyBirdClaim",
  "resolve.feeClaim",
  "resolve.bondClaim",
  "creatorVoid.refund",
  "emergency.pauseNewRisk",
  "emergency.exitWhilePaused",
  "emergency.autoExpiry",
  "paymaster.sponsored",
  "paymaster.budgetRejected",
  "paymaster.fallback",
  "timeout.deadlineMinusOneCreatorVoid",
  "timeout.deadlineCreatorVoidRejected",
]);

export const REQUIRED_DRILLS = Object.freeze([
  "roles.independentRpcSnapshot",
  "monitoring.metricsScrape",
  "monitoring.alertDelivery",
  "incident.rpcDivergence",
  "incident.liabilityCoverage",
  "emergency.pauseNewRisk",
  "emergency.exitStillAvailable",
  "emergency.autoExpiry",
  "indexer.reorgRecovery",
  "indexer.backupRestore",
  "paymaster.kmsRotation",
  "paymaster.depositLossCap",
  "rpc.failover",
]);

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

export function assertObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value;
}

export function assertExactKeys(value, keys, path) {
  assertObject(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, i) => key !== expected[i])
  ) {
    fail(
      path,
      `keys must be exactly ${expected.join(", ")}; got ${actual.join(", ")}`,
    );
  }
}

export function assertString(value, path, { nonEmpty = true } = {}) {
  if (typeof value !== "string" || (nonEmpty && value.length === 0)) {
    fail(path, "must be a non-empty string");
  }
  return value;
}

export function assertInteger(value, path, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min)
    fail(path, `must be an integer >= ${min}`);
  return value;
}

export function assertDecimalString(value, path) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail(path, "must be a canonical unsigned decimal string");
  }
  return value;
}

export function assertAddress(value, path, { allowZero = false } = {}) {
  if (typeof value !== "string" || !ADDRESS_RE.test(value))
    fail(path, "must be a 20-byte hex address");
  if (!allowZero && value.toLowerCase() === ZERO_ADDRESS)
    fail(path, "must not be the zero address");
  return value.toLowerCase();
}

export function assertHash(value, path) {
  if (typeof value !== "string" || !HASH_RE.test(value))
    fail(path, "must be a 32-byte hex value");
  return value.toLowerCase();
}

export function assertSha256(value, path) {
  if (typeof value !== "string" || !SHA256_RE.test(value))
    fail(path, "must be a lowercase SHA-256 hex digest");
  return value;
}

export function assertTimestamp(value, path) {
  if (
    typeof value !== "string" ||
    !RFC3339_RE.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    fail(path, "must be an RFC3339 UTC timestamp");
  }
  return value;
}

export function assertUnique(values, path) {
  if (
    new Set(values.map((value) => String(value).toLowerCase())).size !==
    values.length
  ) {
    fail(path, "must contain unique values");
  }
}

export function validateReceipt(receipt, path, { expectedStatus = 1 } = {}) {
  assertExactKeys(
    receipt,
    ["txHash", "status", "blockNumber", "blockHash", "timestamp"],
    path,
  );
  assertHash(receipt.txHash, `${path}.txHash`);
  if (receipt.status !== expectedStatus)
    fail(`${path}.status`, `must equal ${expectedStatus}`);
  assertInteger(receipt.blockNumber, `${path}.blockNumber`, { min: 1 });
  assertHash(receipt.blockHash, `${path}.blockHash`);
  assertInteger(receipt.timestamp, `${path}.timestamp`, { min: 1 });
  return receipt;
}

export async function readJson(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error.message})`);
  }
  return parsed;
}

export function canonicalJson(value) {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Json(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function assertRuntimeEvidence(value, schemaVersion, path = "evidence") {
  assertObject(value, path);
  if (value.schemaVersion !== schemaVersion)
    fail(`${path}.schemaVersion`, `must equal ${schemaVersion}`);
  if (value.evidenceClass !== "BASE_SEPOLIA_RUNTIME") {
    fail(
      `${path}.evidenceClass`,
      "must equal BASE_SEPOLIA_RUNTIME; templates are not proof",
    );
  }
  if (value.chainId !== BASE_SEPOLIA_CHAIN_ID)
    fail(`${path}.chainId`, `must equal ${BASE_SEPOLIA_CHAIN_ID}`);
}

export function normalizeAddressSet(values, path) {
  if (!Array.isArray(values)) fail(path, "must be an array");
  const normalized = values.map((value, i) =>
    assertAddress(value, `${path}[${i}]`, { allowZero: true }),
  );
  assertUnique(normalized, path);
  return normalized.sort();
}
