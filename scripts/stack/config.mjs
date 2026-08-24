import { access, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { getAddress, isAddress, zeroAddress } from "viem";
import { parseEnvText } from "../deployment/deploy-arbitrum-sepolia.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const SECRET_KEYS = new Set([
  "ARBITRUM_SEPOLIA_RPC_URL",
  "CPREDICT_STACK_POSTGRES_ADMIN_PASSWORD",
  "CPREDICT_STACK_MIGRATOR_PASSWORD",
  "CPREDICT_STACK_INDEXER_PASSWORD",
  "CPREDICT_STACK_PAYMASTER_PASSWORD",
  "CPREDICT_STACK_BACKUP_PASSWORD",
  "CPREDICT_STACK_PAYMASTER_ADAPTER_HOST_PATH",
]);
const REQUIRED_SECRET_KEYS = [...SECRET_KEYS].filter(
  (key) => key !== "CPREDICT_STACK_PAYMASTER_ADAPTER_HOST_PATH",
);
const REQUIRED_PUBLIC_KEYS = [
  "CPREDICT_STACK_RUNTIME_ROOT",
  "CPREDICT_INDEXER_FACTORY_ADDRESS",
  "CPREDICT_INDEXER_CORE_ADDRESSES",
  "CPREDICT_INDEXER_DEPLOYMENT_BLOCK",
  "CPREDICT_PAYMASTER_ENTRY_POINT",
  "CPREDICT_PAYMASTER_ADDRESS",
  "CPREDICT_PAYMASTER_EXPECTED_SIGNER",
  "CPREDICT_PAYMASTER_POLICY_VERSION",
  "CPREDICT_PAYMASTER_MAX_COST_PER_REQUEST",
  "CPREDICT_PAYMASTER_MAX_COST_PER_USER_DAY",
  "CPREDICT_PAYMASTER_MAX_COST_GLOBAL_DAY",
];
const SAFE_PASSWORD = /^[A-Za-z0-9_-]{24,128}$/;

export async function loadStackConfiguration({
  secretPath = resolve(ROOT, ".env.compose.local"),
  publicPath,
  sponsorship = false,
  runtimeBoundary = resolve(ROOT, "runtime/arbitrum-sepolia"),
} = {}) {
  const secret = await readRestrictedEnv(secretPath);
  const selectedPublicPath = resolve(
    ROOT,
    publicPath ??
      secret.CPREDICT_STACK_RUNTIME_ENV ??
      "runtime/arbitrum-sepolia/current.env",
  );
  const canonicalBoundary = await realpath(runtimeBoundary);
  const canonicalPublicPath = await realpath(selectedPublicPath);
  assertWithin(canonicalPublicPath, canonicalBoundary, "runtime public env");
  const publicEnv = parseEnvText(await readFile(selectedPublicPath, "utf8"));
  for (const key of SECRET_KEYS) {
    if (Object.hasOwn(publicEnv, key))
      throw new Error(`${selectedPublicPath}: public runtime env contains secret key ${key}`);
  }
  for (const key of REQUIRED_SECRET_KEYS) requireValue(secret, key);
  for (const key of REQUIRED_PUBLIC_KEYS) requireValue(publicEnv, key);
  for (const key of REQUIRED_SECRET_KEYS.filter((key) => key.endsWith("PASSWORD"))) {
    if (!SAFE_PASSWORD.test(secret[key]))
      throw new Error(`${key} must be 24-128 URL-safe characters`);
  }
  validateRpc(secret.ARBITRUM_SEPOLIA_RPC_URL);
  validateAddress(publicEnv.CPREDICT_INDEXER_FACTORY_ADDRESS, "factory");
  for (const [index, value] of publicEnv.CPREDICT_INDEXER_CORE_ADDRESSES.split(",").entries())
    validateAddress(value.trim(), `core address ${index}`);
  for (const key of [
    "CPREDICT_PAYMASTER_ENTRY_POINT",
    "CPREDICT_PAYMASTER_ADDRESS",
    "CPREDICT_PAYMASTER_EXPECTED_SIGNER",
  ]) validateAddress(publicEnv[key], key);
  validateUnsigned(publicEnv.CPREDICT_INDEXER_DEPLOYMENT_BLOCK, "deployment block");
  validateUnsigned(publicEnv.CPREDICT_PAYMASTER_POLICY_VERSION, "policy version");
  for (const key of [
    "CPREDICT_PAYMASTER_MAX_COST_PER_REQUEST",
    "CPREDICT_PAYMASTER_MAX_COST_PER_USER_DAY",
    "CPREDICT_PAYMASTER_MAX_COST_GLOBAL_DAY",
  ]) validateUnsigned(publicEnv[key], key);
  const runtimeRoot = await realpath(resolve(ROOT, publicEnv.CPREDICT_STACK_RUNTIME_ROOT));
  assertWithin(runtimeRoot, canonicalBoundary, "runtime root");
  await access(resolve(runtimeRoot, "web-demo/runtime-config.json"));
  await access(resolve(runtimeRoot, "web-demo/deployment"));
  if (sponsorship) {
    const adapter = requireValue(secret, "CPREDICT_STACK_PAYMASTER_ADAPTER_HOST_PATH");
    if (!isAbsolute(adapter)) throw new Error("paymaster adapter host path must be absolute");
    await access(adapter);
  }
  return {
    secretPath,
    publicPath: selectedPublicPath,
    runtimeRoot,
    secret,
    publicEnv,
    environment: { ...secret, ...publicEnv },
  };
}

async function readRestrictedEnv(path) {
  const metadata = await stat(path);
  if ((metadata.mode & 0o077) !== 0)
    throw new Error(`${path}: secret env file permissions must be 0600`);
  return parseEnvText(await readFile(path, "utf8"));
}

function requireValue(value, key) {
  if (!Object.hasOwn(value, key) || value[key].length === 0)
    throw new Error(`${key} is required`);
  return value[key];
}

function validateRpc(value) {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("ARBITRUM_SEPOLIA_RPC_URL must use HTTPS or loopback HTTP");
}

function validateAddress(value, label) {
  if (!isAddress(value) || getAddress(value) === zeroAddress)
    throw new Error(`${label} must be a non-zero EVM address`);
}

function validateUnsigned(value, label) {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error(`${label} must be an unsigned integer`);
}

function assertWithin(path, parent, label) {
  const child = relative(parent, path);
  if (child === "" || child === ".") return;
  if (child.startsWith("..") || isAbsolute(child))
    throw new Error(`${label} must stay under runtime/arbitrum-sepolia`);
}
