#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const CHAIN_ID = 421_614;
export const NETWORK = "arbitrum-sepolia";
export const ACKNOWLEDGEMENT = "ARBITRUM_SEPOLIA_TESTNET_ONLY";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO_HASH = `0x${"0".repeat(64)}`;
export const USDC = "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d";
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
export const ENTRY_POINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
export const CANONICAL_USDC_KIND = "canonical-usdc";
export const SANDBOX_TOKEN_KIND = "sandbox-test-token";
export const DEFAULT_MIN_BALANCE_WEI = 20_000_000_000_000_000n;
export const FINGERPRINT_MARKER = "CPREDICT_FACTORY_DEPENDENCY_FINGERPRINT";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATIC_PENDING = resolve(ROOT, "deployments/arbitrum-sepolia/pending.json");
const DEFAULT_STATE_DIR = resolve(
  ROOT,
  "deployments/arbitrum-sepolia/runtime",
);
const DEPLOY_SCRIPT =
  "script/DeployArbitrumSepolia.s.sol:DeployArbitrumSepolia";
const FINALIZE_SCRIPT = "script/FinalizeBootstrap.s.sol:FinalizeBootstrap";
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const PRIVATE_KEY_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;
const ADDRESS_KEYS = [
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
  "temporaryAdmin",
  "governanceSafe",
  "emergencySafe",
  "protocolTreasury",
  "sponsorSigner",
  "usdc",
  "permit2",
  "entryPoint",
];
const ACTIVE_SECRETS = new Set();

const SAFE_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
]);
const ERC20_METADATA_ABI = parseAbi([
  "function decimals() view returns (uint8)",
]);
const FACTORY_ABI = parseAbi([
  "function active() view returns (bool)",
  "function activationFingerprint() view returns (bytes32)",
  "function setMarketplace(address)",
  "function activate(bytes32)",
]);
const SET_FACTORY_ABI = parseAbi(["function setFactory(address)"]);
const TIMELOCK_ABI = parseAbi([
  "function hashOperationBatch(address[] targets,uint256[] values,bytes[] payloads,bytes32 predecessor,bytes32 salt) view returns (bytes32)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
]);
const BOOTSTRAP_SALT = keccak256(stringToHex("CPREDICT_V1_BOOTSTRAP"));

function fail(message, code = 1) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

export function parseEnvText(text) {
  const result = Object.create(null);
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) fail(`env line ${index + 1}: expected KEY=VALUE`, 2);
    const [, key, rawValue] = match;
    if (Object.hasOwn(result, key))
      fail(`env line ${index + 1}: duplicate key ${key}`, 2);
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        try {
          value = JSON.parse(`"${value}"`);
        } catch {
          fail(`env line ${index + 1}: invalid quoted value`, 2);
        }
      }
    } else if (/[`\n\r\0]/.test(value) || value.includes("$(")) {
      fail(`env line ${index + 1}: executable shell syntax is forbidden`, 2);
    }
    result[key] = value;
  }
  return result;
}

export function parseArgs(argv) {
  const options = {
    command: "help",
    envFile: resolve(ROOT, ".env.arbitrum-sepolia.local"),
    envFileExplicit: false,
    stateDir: DEFAULT_STATE_DIR,
    profile: undefined,
    yes: false,
    resume: false,
    waitForTimelock: false,
    pollSeconds: 30,
    manifest: undefined,
    canaryEvidence: undefined,
    opsEvidence: undefined,
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) options.command = args.shift();
  while (args.length > 0) {
    const flag = args.shift();
    const take = () => {
      const value = args.shift();
      if (!value || value.startsWith("--")) fail(`${flag} needs a value`, 2);
      return value;
    };
    if (flag === "--env-file") {
      options.envFile = resolve(take());
      options.envFileExplicit = true;
    } else if (flag === "--state-dir") options.stateDir = resolve(take());
    else if (flag === "--profile") options.profile = take();
    else if (flag === "--manifest") options.manifest = resolve(take());
    else if (flag === "--canary-evidence")
      options.canaryEvidence = resolve(take());
    else if (flag === "--ops-evidence") options.opsEvidence = resolve(take());
    else if (flag === "--poll-seconds") {
      options.pollSeconds = Number(take());
      if (!Number.isInteger(options.pollSeconds) || options.pollSeconds < 5)
        fail("--poll-seconds must be an integer >= 5", 2);
    } else if (flag === "--yes") options.yes = true;
    else if (flag === "--resume") options.resume = true;
    else if (flag === "--wait-for-timelock") options.waitForTimelock = true;
    else if (flag === "--help" || flag === "-h") options.command = "help";
    else fail(`unknown option ${flag}`, 2);
  }
  const commands = new Set([
    "help",
    "preflight",
    "plan",
    "deploy",
    "finalize",
    "status",
    "verify",
    "all",
  ]);
  if (!commands.has(options.command)) fail(`unknown command ${options.command}`, 2);
  if (!new Set(["formal", "debug", "sandbox", undefined]).has(options.profile))
    fail("--profile must be formal, debug, or sandbox", 2);
  return options;
}

function normalizePrivateKey(value) {
  if (!PRIVATE_KEY_RE.test(value ?? ""))
    fail("DEPLOYER_PRIVATE_KEY must be exactly 32 bytes of hex", 2);
  return value.startsWith("0x") ? value : `0x${value}`;
}

function normalizeAddress(value, name) {
  if (!value) fail(`${name} is required`, 2);
  let address;
  try {
    address = getAddress(value);
  } catch {
    fail(`${name} must be a valid EVM address`, 2);
  }
  if (address.toLowerCase() === ZERO_ADDRESS) fail(`${name} must not be zero`, 2);
  return address;
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig(
  options,
  { needSigner = true, requireSecondary = needSigner } = {},
) {
  let fileEnv = Object.create(null);
  if (await fileExists(options.envFile)) {
    const info = await stat(options.envFile);
    if ((info.mode & 0o077) !== 0)
      fail(`${options.envFile}: secret env file permissions must be 0600`, 2);
    fileEnv = parseEnvText(await readFile(options.envFile, "utf8"));
  } else if (options.envFileExplicit) {
    fail(`${options.envFile}: env file does not exist`, 2);
  }
  const env = { ...fileEnv, ...process.env };
  const profile = options.profile ?? env.CPREDICT_DEPLOYMENT_PROFILE ?? "formal";
  if (!new Set(["formal", "debug", "sandbox"]).has(profile))
    fail("CPREDICT_DEPLOYMENT_PROFILE must be formal, debug, or sandbox", 2);
  const rpcA = env.ARBITRUM_SEPOLIA_RPC_URL_A ?? env.ARBITRUM_SEPOLIA_RPC_URL;
  const rpcB = env.ARBITRUM_SEPOLIA_RPC_URL_B;
  if (!rpcA) fail("ARBITRUM_SEPOLIA_RPC_URL_A is required", 2);
  if (profile === "formal" && requireSecondary && !rpcB)
    fail("formal profile requires ARBITRUM_SEPOLIA_RPC_URL_B", 2);
  let privateKey;
  let deployer;
  if (needSigner) {
    privateKey = normalizePrivateKey(env.DEPLOYER_PRIVATE_KEY);
    deployer = privateKeyToAccount(privateKey).address;
  }
  const roles = needSigner
    ? {
        governanceSafe: normalizeAddress(env.GOVERNANCE_SAFE, "GOVERNANCE_SAFE"),
        emergencySafe: normalizeAddress(env.EMERGENCY_SAFE, "EMERGENCY_SAFE"),
        treasury: normalizeAddress(env.PROTOCOL_TREASURY, "PROTOCOL_TREASURY"),
        sponsorSigner: normalizeAddress(env.SPONSOR_SIGNER, "SPONSOR_SIGNER"),
      }
    : undefined;
  const expectedFingerprint = env.EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT;
  if (expectedFingerprint && !HASH_RE.test(expectedFingerprint))
    fail("EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT must be bytes32 hex", 2);
  const minimumBalance = BigInt(
    env.DEPLOYER_MIN_BALANCE_WEI ?? DEFAULT_MIN_BALANCE_WEI,
  );
  if (minimumBalance < 0n) fail("DEPLOYER_MIN_BALANCE_WEI must be >= 0", 2);
  for (const secret of [privateKey, rpcA, rpcB]) if (secret) ACTIVE_SECRETS.add(secret);
  return {
    env,
    profile,
    rpcA,
    rpcB,
    privateKey,
    deployer,
    roles,
    expectedFingerprint: expectedFingerprint?.toLowerCase(),
    minimumBalance,
    stateDir: options.stateDir,
    statePath: resolve(options.stateDir, "state.json"),
  };
}

async function ensurePrivateStateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await stat(path);
  if (!info.isDirectory()) fail(`${path}: state path must be a directory`, 2);
  if ((info.mode & 0o077) !== 0)
    fail(`${path}: deployment state directory permissions must be 0700`, 2);
}

function rpcOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    fail("RPC URL must be an absolute http(s) URL", 2);
  }
}

function client(url) {
  return createPublicClient({
    transport: http(url, { retryCount: 0, timeout: 20_000 }),
  });
}

function codehash(code) {
  if (!code || code === "0x") fail("required contract code is missing");
  return keccak256(code);
}

async function inspectExternalContracts(publicClient, { includeUsdc = true } = {}) {
  const [usdcCode, permit2Code, entryPointCode, decimals] = await Promise.all([
    includeUsdc ? publicClient.getBytecode({ address: USDC }) : undefined,
    publicClient.getBytecode({ address: PERMIT2 }),
    publicClient.getBytecode({ address: ENTRY_POINT }),
    includeUsdc ? publicClient.readContract({
      address: USDC,
      abi: ERC20_METADATA_ABI,
      functionName: "decimals",
    }) : undefined,
  ]);
  if (includeUsdc && Number(decimals) !== 6)
    fail("Arbitrum Sepolia USDC decimals must equal 6");
  return {
    ...(includeUsdc ? { usdc: codehash(usdcCode) } : {}),
    permit2: codehash(permit2Code),
    entryPoint: codehash(entryPointCode),
  };
}

async function inspectSafe(publicClient, address, threshold, label) {
  const code = await publicClient.getBytecode({ address });
  codehash(code);
  let owners;
  let actualThreshold;
  try {
    [owners, actualThreshold] = await Promise.all([
      publicClient.readContract({
        address,
        abi: SAFE_ABI,
        functionName: "getOwners",
      }),
      publicClient.readContract({
        address,
        abi: SAFE_ABI,
        functionName: "getThreshold",
      }),
    ]);
  } catch (error) {
    fail(`${label} is not a readable Safe (${error.shortMessage ?? error.message})`);
  }
  if (owners.length !== 6 || Number(actualThreshold) !== threshold)
    fail(`${label} must be an exact ${threshold}/6 Safe`);
  return { owners, threshold: Number(actualThreshold), runtimeCodehash: codehash(code) };
}

function assertFormalRoleSeparation(config) {
  const entries = [
    ["deployer", config.deployer],
    ["governanceSafe", config.roles.governanceSafe],
    ["emergencySafe", config.roles.emergencySafe],
    ["treasury", config.roles.treasury],
    ["sponsorSigner", config.roles.sponsorSigner],
  ];
  const seen = new Map();
  for (const [name, address] of entries) {
    const key = address.toLowerCase();
    if (seen.has(key)) fail(`formal profile requires distinct ${seen.get(key)} and ${name}`);
    seen.set(key, name);
  }
}

async function gitSourceStatus() {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (head.status !== 0) fail("git HEAD is unavailable");
  const dirty = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all"],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (dirty.status !== 0) fail("git status failed");
  return { commit: head.stdout.trim(), dirty: dirty.stdout.trim() !== "" };
}

export async function preflight(config) {
  const rpcAOrigin = rpcOrigin(config.rpcA);
  const rpcBOrigin = config.rpcB ? rpcOrigin(config.rpcB) : undefined;
  if (config.profile === "formal" && rpcAOrigin === rpcBOrigin)
    fail("formal profile requires two RPC providers with distinct origins");
  const primary = client(config.rpcA);
  const secondary = config.rpcB ? client(config.rpcB) : undefined;
  const includeUsdc = config.profile !== "sandbox";
  const [chainA, chainB, balance, externalA, externalB, source] = await Promise.all([
    primary.getChainId(),
    secondary?.getChainId(),
    primary.getBalance({ address: config.deployer }),
    inspectExternalContracts(primary, { includeUsdc }),
    secondary ? inspectExternalContracts(secondary, { includeUsdc }) : undefined,
    gitSourceStatus(),
  ]);
  if (chainA !== CHAIN_ID || (chainB !== undefined && chainB !== CHAIN_ID))
    fail(`RPC chainId must equal ${CHAIN_ID}`);
  if (balance < config.minimumBalance)
    fail(`deployer balance ${balance} is below minimum ${config.minimumBalance}`);
  if (externalB && JSON.stringify(externalA) !== JSON.stringify(externalB))
    fail("canonical external contract codehash differs across RPC providers");
  let safeEvidence;
  if (config.profile === "formal") {
    assertFormalRoleSeparation(config);
    if (source.dirty) fail("formal profile requires a clean Git checkout");
    const auditTag = config.env.CPREDICT_AUDIT_TAG;
    if (!auditTag) fail("formal profile requires CPREDICT_AUDIT_TAG");
    const tagCommit = spawnSync("git", ["rev-parse", `${auditTag}^{commit}`], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (tagCommit.status !== 0 || tagCommit.stdout.trim() !== source.commit)
      fail("CPREDICT_AUDIT_TAG must resolve to current HEAD");
    const signature = spawnSync("git", ["tag", "-v", auditTag], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (signature.status !== 0) fail("CPREDICT_AUDIT_TAG must be a valid signed tag");
    safeEvidence = {
      governance: await inspectSafe(
        primary,
        config.roles.governanceSafe,
        4,
        "GOVERNANCE_SAFE",
      ),
      emergency: await inspectSafe(
        primary,
        config.roles.emergencySafe,
        2,
        "EMERGENCY_SAFE",
      ),
    };
  }
  return {
    result: "PASS",
    profile: config.profile,
    chainId: chainA,
    rpcOrigins: [rpcAOrigin, ...(rpcBOrigin ? [rpcBOrigin] : [])],
    deployer: config.deployer,
    deployerBalanceWei: balance.toString(),
    source,
    externalContracts: externalA,
    safes: safeEvidence,
    warning:
      config.profile === "sandbox"
        ? "SANDBOX profile deploys an unrestricted-mint ctUSD token and can never produce FINALIZED_VERIFIED evidence"
        : config.profile === "debug"
          ? "DEBUG profile permits EOA/reused roles and cannot produce FINALIZED_VERIFIED evidence"
          : undefined,
  };
}

function redact(text, secrets) {
  let result = String(text);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    result = result.split(secret).join("[REDACTED]");
  return result;
}

async function runCommand(command, args, options = {}) {
  const {
    cwd = ROOT,
    env = process.env,
    logPath,
    secrets = [],
    quiet = false,
  } = options;
  if (logPath) {
    await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    await writeFile(logPath, "", { mode: 0o600 });
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let combined = "";
    let pendingLogWrite = Promise.resolve();
    const consume = (chunk, target) => {
      const safe = redact(chunk.toString(), secrets);
      combined += safe;
      if (combined.length > 20_000_000) combined = combined.slice(-20_000_000);
      if (!quiet) target.write(safe);
      if (logPath) {
        pendingLogWrite = pendingLogWrite.then(() =>
          writeFile(logPath, safe, { flag: "a", mode: 0o600 }),
        );
      }
    };
    child.stdout.on("data", (chunk) => consume(chunk, process.stdout));
    child.stderr.on("data", (chunk) => consume(chunk, process.stderr));
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      pendingLogWrite.then(() => {
        if (code === 0) resolvePromise({ output: combined, code: 0 });
        else {
        const error = new Error(
            `${basename(command)} failed (exit=${code ?? "signal"}, signal=${signal ?? "none"})${logPath ? `; log=${logPath}` : ""}`,
          );
          error.output = combined;
          error.exitCode = code ?? 1;
          rejectPromise(error);
        }
      }, rejectPromise);
    });
  });
}

function timestampId() {
  return new Date().toISOString().replaceAll(/[:.]/g, "-");
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${path}: invalid or missing JSON (${error.message})`);
  }
}

export function extractFingerprint(output) {
  const marker = output.lastIndexOf(FINGERPRINT_MARKER);
  if (marker < 0) fail("deployment preview did not emit the fingerprint marker");
  const match = output.slice(marker + FINGERPRINT_MARKER.length).match(/0x[0-9a-fA-F]{64}/);
  if (!match) fail("deployment preview did not emit a bytes32 fingerprint");
  return match[0].toLowerCase();
}

export function validatePendingManifest(value, { profile } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("pending manifest must be an object");
  if (value.chainId !== CHAIN_ID) fail(`pending.chainId must equal ${CHAIN_ID}`);
  if (value.status !== "BOOTSTRAP_SCHEDULED_NOT_FINAL")
    fail("pending.status must equal BOOTSTRAP_SCHEDULED_NOT_FINAL");
  if (![CANONICAL_USDC_KIND, SANDBOX_TOKEN_KIND].includes(value.paymentTokenKind))
    fail("pending.paymentTokenKind must be canonical-usdc or sandbox-test-token");
  const expectedKind = profile === "sandbox" ? SANDBOX_TOKEN_KIND :
    profile === "formal" || profile === "debug" ? CANONICAL_USDC_KIND : undefined;
  if (expectedKind !== undefined && value.paymentTokenKind !== expectedKind)
    fail(`pending.paymentTokenKind does not match ${profile} profile`);
  for (const key of ADDRESS_KEYS) value[key] = normalizeAddress(value[key], `pending.${key}`);
  if (!HASH_RE.test(value.factoryActivationFingerprint ?? ""))
    fail("pending.factoryActivationFingerprint must be bytes32");
  value.factoryActivationFingerprint = value.factoryActivationFingerprint.toLowerCase();
  if (
    value.paymentTokenKind === CANONICAL_USDC_KIND &&
    value.usdc.toLowerCase() !== USDC.toLowerCase()
  ) fail("pending.usdc mismatch");
  if (
    value.paymentTokenKind === SANDBOX_TOKEN_KIND &&
    value.usdc.toLowerCase() === USDC.toLowerCase()
  ) fail("pending sandbox payment token must not equal canonical USDC");
  if (value.permit2.toLowerCase() !== PERMIT2.toLowerCase()) fail("pending.permit2 mismatch");
  if (value.entryPoint.toLowerCase() !== ENTRY_POINT.toLowerCase())
    fail("pending.entryPoint mismatch");
  if (!Number.isSafeInteger(value.paymasterPolicyVersion) || value.paymasterPolicyVersion < 1)
    fail("pending.paymasterPolicyVersion must be a positive safe integer");
  for (const key of [
    "paymasterMaxCostPerOperation",
    "paymasterMaxCostPerUserDay",
    "paymasterMaxCostGlobalDay",
  ]) {
    if (!/^[1-9][0-9]*$/.test(value[key] ?? ""))
      fail(`pending.${key} must be a positive decimal string`);
  }
  if (
    BigInt(value.paymasterMaxCostPerOperation) > BigInt(value.paymasterMaxCostPerUserDay)
    || BigInt(value.paymasterMaxCostPerUserDay) > BigInt(value.paymasterMaxCostGlobalDay)
  ) fail("pending Paymaster budget ordering is invalid");
  return value;
}

export function validateBroadcastDocument(value, minimumReceipts) {
  if (!value || typeof value !== "object" || !Array.isArray(value.receipts))
    fail("Foundry broadcast JSON must contain receipts[]");
  if (value.receipts.length < minimumReceipts)
    fail(`Foundry broadcast has ${value.receipts.length} receipts; expected >= ${minimumReceipts}`);
  for (const [index, receipt] of value.receipts.entries()) {
    const status = receipt.status;
    if (!(status === 1 || status === "1" || /^0x0*1$/i.test(status ?? "")))
      fail(`Foundry receipt[${index}] is not successful`);
    if (!/^0x[0-9a-fA-F]{64}$/.test(receipt.transactionHash ?? receipt.hash ?? ""))
      fail(`Foundry receipt[${index}] is missing transaction hash`);
  }
  return { receipts: value.receipts.length };
}

async function sourceSnapshot() {
  const source = await gitSourceStatus();
  const manifest = resolve(ROOT, "manifests/source-manifest.json");
  return {
    ...source,
    sourceManifestSha256: (await fileExists(manifest))
      ? await sha256File(manifest)
      : undefined,
  };
}

async function runLocalGates(config, logRoot) {
  const secrets = [config.privateKey, config.rpcA, config.rpcB];
  const commands = [
    [process.execPath, ["scripts/deployment/validate-deployment-abi.mjs"]],
    [process.execPath, ["scripts/deployment/check-deployment-links.mjs"]],
  ];
  if (config.profile === "formal" || config.profile === "sandbox") {
    commands.push(
      ["npm", ["run", "check:artifacts"]],
      ["npm", ["run", "scan:secrets"]],
      ["npm", ["run", "test:deployment-tools"]],
    );
  }
  for (let index = 0; index < commands.length; index += 1) {
    const [command, args] = commands[index];
    await runCommand(command, args, {
      env: { ...process.env, ...config.env },
      logPath: resolve(logRoot, `local-gate-${index + 1}.log`),
      secrets,
    });
  }
}

function forgeEnvironment(config, extra = {}) {
  return {
    ...process.env,
    ...config.env,
    ARBITRUM_SEPOLIA_RPC_URL: config.rpcA,
    DEPLOYER_PRIVATE_KEY: config.privateKey,
    GOVERNANCE_SAFE: config.roles.governanceSafe,
    EMERGENCY_SAFE: config.roles.emergencySafe,
    PROTOCOL_TREASURY: config.roles.treasury,
    SPONSOR_SIGNER: config.roles.sponsorSigner,
    // Foundry writes dry-run signer material under its cache/broadcast roots. Keep
    // those artifacts in the operator's ignored, mode-restricted state directory.
    FOUNDRY_BROADCAST: resolve(config.stateDir, "foundry/broadcast"),
    FOUNDRY_CACHE_PATH: resolve(config.stateDir, "foundry/cache"),
    ...extra,
    // The selected CLI profile owns this flag; an env file cannot silently switch tokens.
    CPREDICT_SANDBOX_TOKEN_ENABLED: config.profile === "sandbox" ? "true" : "false",
  };
}

async function runForgeScript(
  config,
  target,
  { broadcast = false, resume = false, env = {}, logPath, quiet = false },
) {
  const args = [
    "scripts/forge.sh",
    "script",
    target,
    "--rpc-url",
    "arbitrum_sepolia",
    "-vvvv",
  ];
  if (broadcast) args.push("--broadcast", "--slow");
  if (resume) args.push("--resume");
  return await runCommand("bash", args, {
    env: forgeEnvironment(config, env),
    logPath,
    secrets: [config.privateKey, config.rpcA, config.rpcB],
    quiet,
  });
}

async function persistState(config, patch) {
  const previous = (await fileExists(config.statePath))
    ? await readJson(config.statePath)
    : {};
  const value = {
    schemaVersion: "cpredict.arbitrum-sepolia.orchestrator.v1",
    network: NETWORK,
    chainId: CHAIN_ID,
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(config.statePath, value);
  return value;
}

async function runPlan(config, { runGates = true } = {}) {
  const logRoot = resolve(config.stateDir, "logs", timestampId());
  const evidence = await preflight(config);
  if (runGates) await runLocalGates(config, logRoot);
  const publicClient = client(config.rpcA);
  const nonceBefore = await publicClient.getTransactionCount({
    address: config.deployer,
    blockTag: "pending",
  });
  const preview = await runForgeScript(config, DEPLOY_SCRIPT, {
    env: {
      DEPLOYMENT_PREVIEW_ONLY: "true",
      EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT: ZERO_HASH,
    },
    logPath: resolve(logRoot, "deployment-preview.log"),
    quiet: true,
  });
  const fingerprint = extractFingerprint(preview.output);
  const nonceAfter = await publicClient.getTransactionCount({
    address: config.deployer,
    blockTag: "pending",
  });
  if (nonceAfter !== nonceBefore)
    fail("deployer nonce changed during preview; discard plan and investigate");
  await persistState(config, {
    status: "PLANNED_NOT_BROADCAST",
    profile: config.profile,
    deployer: config.deployer,
    roles: config.roles,
    plannedNonce: nonceBefore,
    factoryDependencyFingerprint: fingerprint,
    preflight: evidence,
    source: await sourceSnapshot(),
    logs: { root: logRoot },
  });
  process.stdout.write(`\nPlan ready. Factory fingerprint: ${fingerprint}\n`);
  return { fingerprint, nonce: nonceBefore, logRoot };
}

async function confirmAction(options, config, action, fingerprint) {
  const expected = `${action} ${NETWORK} ${fingerprint}`;
  if (options.yes) {
    if (config.env.CPREDICT_DEPLOYMENT_ACKNOWLEDGEMENT !== ACKNOWLEDGEMENT)
      fail(`--yes requires CPREDICT_DEPLOYMENT_ACKNOWLEDGEMENT=${ACKNOWLEDGEMENT}`, 2);
    return;
  }
  if (!process.stdin.isTTY) fail("non-interactive broadcast requires --yes", 2);
  process.stdout.write(
    `\nBroadcast target: ${NETWORK} (${CHAIN_ID})\nFingerprint: ${fingerprint}\n`,
  );
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`Type exactly '${expected}' to continue: `);
  prompt.close();
  if (answer !== expected) fail("broadcast confirmation did not match", 2);
}

async function broadcastEvidence(path, minimumReceipts) {
  const document = await readJson(path);
  const result = validateBroadcastDocument(document, minimumReceipts);
  return { path, sha256: await sha256File(path), ...result };
}

async function finishDeployment(config, plan, logRoot) {
  if (!(await fileExists(STATIC_PENDING)))
    fail("broadcast returned success but pending.json was not written");
  const pending = validatePendingManifest(await readJson(STATIC_PENDING), {
    profile: config.profile,
  });
  if (pending.temporaryAdmin.toLowerCase() !== config.deployer.toLowerCase())
    fail("pending temporaryAdmin does not match deployer");
  if (pending.factoryActivationFingerprint !== plan.fingerprint)
    fail("pending fingerprint does not match reviewed plan");
  const broadcastPath = resolve(
    config.stateDir,
    "foundry/broadcast/DeployArbitrumSepolia.s.sol/421614/run-latest.json",
  );
  const broadcast = await broadcastEvidence(
    broadcastPath,
    config.profile === "sandbox" ? 13 : 12,
  );
  await persistState(config, {
    status: "BOOTSTRAP_SCHEDULED_NOT_FINAL",
    pendingManifest: STATIC_PENDING,
    paymentTokenKind: pending.paymentTokenKind,
    paymentToken: pending.usdc,
    factoryDependencyFingerprint: plan.fingerprint,
    deploymentBroadcast: broadcast,
    logs: { root: logRoot },
  });
  process.stdout.write(`\nDeployment transactions succeeded (${broadcast.receipts} receipts).\n`);
  process.stdout.write(`Pending manifest: ${STATIC_PENDING}\n`);
  process.stdout.write(
    `Next: scripts/deployment/deploy-arbitrum-sepolia.sh finalize --env-file <file>\n`,
  );
  return pending;
}

async function runDeploy(options, config) {
  if ((await fileExists(STATIC_PENDING)) && !options.resume)
    fail("pending.json already exists; use status/finalize, or --resume only after a partial broadcast");
  if (options.resume) {
    const state = await readJson(config.statePath);
    if (state.status !== "BROADCAST_FAILED_REQUIRES_INSPECTION")
      fail("--resume is allowed only after a recorded partial broadcast failure");
    const fingerprint = state.factoryDependencyFingerprint;
    if (!HASH_RE.test(fingerprint ?? "")) fail("resume state has no valid fingerprint");
    const logRoot = resolve(config.stateDir, "logs", timestampId());
    await preflight(config);
    await runLocalGates(config, logRoot);
    await confirmAction(options, config, "RESUME", fingerprint);
    try {
      await runForgeScript(config, DEPLOY_SCRIPT, {
        broadcast: true,
        resume: true,
        env: {
          DEPLOYMENT_PREVIEW_ONLY: "false",
          EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT: fingerprint,
        },
        logPath: resolve(logRoot, "deployment-resume.log"),
      });
      return await finishDeployment(config, { fingerprint }, logRoot);
    } catch (error) {
      await persistState(config, {
        status: "BROADCAST_FAILED_REQUIRES_INSPECTION",
        lastFailure: redact(error.message, [config.privateKey, config.rpcA, config.rpcB]),
      });
      throw error;
    }
  }
  const plan = await runPlan(config);
  if (
    config.expectedFingerprint &&
    config.expectedFingerprint !== plan.fingerprint
  )
    fail("configured EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT differs from fresh plan");
  if (config.profile === "formal" && !config.expectedFingerprint)
    fail(
      "formal deploy requires independently reviewed EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT; run plan first",
    );
  const logRoot = plan.logRoot;
  await runForgeScript(config, DEPLOY_SCRIPT, {
    env: {
      DEPLOYMENT_PREVIEW_ONLY: "false",
      EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT: plan.fingerprint,
    },
    logPath: resolve(logRoot, "deployment-exact-simulation.log"),
    quiet: true,
  });
  const publicClient = client(config.rpcA);
  const currentNonce = await publicClient.getTransactionCount({
    address: config.deployer,
    blockTag: "pending",
  });
  if (currentNonce !== plan.nonce)
    fail("deployer nonce changed after exact simulation; deployment aborted");
  await confirmAction(options, config, "DEPLOY", plan.fingerprint);
  await persistState(config, { status: "BROADCASTING" });
  try {
    await runForgeScript(config, DEPLOY_SCRIPT, {
      broadcast: true,
      env: {
        DEPLOYMENT_PREVIEW_ONLY: "false",
        EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT: plan.fingerprint,
      },
      logPath: resolve(logRoot, "deployment-broadcast.log"),
    });
    return await finishDeployment(config, plan, logRoot);
  } catch (error) {
    await persistState(config, {
      status: "BROADCAST_FAILED_REQUIRES_INSPECTION",
      factoryDependencyFingerprint: plan.fingerprint,
      plannedNonce: plan.nonce,
      lastFailure: redact(error.message, [config.privateKey, config.rpcA, config.rpcB]),
    });
    throw error;
  }
}

function bootstrapPayload(pending) {
  const targets = [
    pending.exposureGuard,
    pending.feeVault,
    pending.bondEscrow,
    pending.fullMarketDeployer,
    pending.factory,
    pending.factory,
  ];
  const payloads = [
    encodeFunctionData({ abi: SET_FACTORY_ABI, functionName: "setFactory", args: [pending.factory] }),
    encodeFunctionData({ abi: SET_FACTORY_ABI, functionName: "setFactory", args: [pending.factory] }),
    encodeFunctionData({ abi: SET_FACTORY_ABI, functionName: "setFactory", args: [pending.factory] }),
    encodeFunctionData({ abi: SET_FACTORY_ABI, functionName: "setFactory", args: [pending.factory] }),
    encodeFunctionData({ abi: FACTORY_ABI, functionName: "setMarketplace", args: [pending.marketplace] }),
    encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "activate",
      args: [pending.factoryActivationFingerprint],
    }),
  ];
  return { targets, values: targets.map(() => 0n), payloads };
}

async function bootstrapStatus(publicClient, pending) {
  const batch = bootstrapPayload(pending);
  const operationId = await publicClient.readContract({
    address: pending.timelock,
    abi: TIMELOCK_ABI,
    functionName: "hashOperationBatch",
    args: [batch.targets, batch.values, batch.payloads, ZERO_HASH, BOOTSTRAP_SALT],
  });
  const [timestamp, ready, done, active, activationFingerprint] = await Promise.all([
    publicClient.readContract({
      address: pending.timelock,
      abi: TIMELOCK_ABI,
      functionName: "getTimestamp",
      args: [operationId],
    }),
    publicClient.readContract({
      address: pending.timelock,
      abi: TIMELOCK_ABI,
      functionName: "isOperationReady",
      args: [operationId],
    }),
    publicClient.readContract({
      address: pending.timelock,
      abi: TIMELOCK_ABI,
      functionName: "isOperationDone",
      args: [operationId],
    }),
    publicClient.readContract({
      address: pending.factory,
      abi: FACTORY_ABI,
      functionName: "active",
    }),
    publicClient.readContract({
      address: pending.factory,
      abi: FACTORY_ABI,
      functionName: "activationFingerprint",
    }),
  ]);
  return {
    operationId,
    scheduledTimestamp: timestamp.toString(),
    ready,
    done,
    factoryActive: active,
    activationFingerprint,
  };
}

async function publicStatus(config) {
  if (!(await fileExists(STATIC_PENDING))) {
    return { status: "NOT_DEPLOYED", chainId: CHAIN_ID, network: NETWORK };
  }
  const pending = validatePendingManifest(await readJson(STATIC_PENDING), {
    profile: config.profile,
  });
  const publicClient = client(config.rpcA);
  if ((await publicClient.getChainId()) !== CHAIN_ID) fail("status RPC is on the wrong chain");
  const missingCode = [];
  const codeKeys = [
    ...ADDRESS_KEYS.slice(0, 11),
    ...(pending.paymentTokenKind === SANDBOX_TOKEN_KIND ? ["usdc"] : []),
  ];
  for (const key of codeKeys) {
    const code = await publicClient.getBytecode({ address: pending[key] });
    if (!code || code === "0x") missingCode.push(key);
  }
  const bootstrap = missingCode.length === 0
    ? await bootstrapStatus(publicClient, pending)
    : undefined;
  return {
    status: bootstrap?.factoryActive
      ? "FINALIZED_PENDING_EVIDENCE_VERIFICATION"
      : "BOOTSTRAP_SCHEDULED_NOT_FINAL",
    chainId: CHAIN_ID,
    network: NETWORK,
    profile: (await fileExists(config.statePath))
      ? (await readJson(config.statePath)).profile
      : undefined,
    pendingManifest: STATIC_PENDING,
    missingCode,
    bootstrap,
    addresses: Object.fromEntries(
      ADDRESS_KEYS.slice(0, 11).map((key) => [key, pending[key]]),
    ),
  };
}

async function runFinalize(options, config) {
  if (!(await fileExists(STATIC_PENDING))) fail("pending.json is required before finalize");
  const pending = validatePendingManifest(await readJson(STATIC_PENDING), {
    profile: config.profile,
  });
  if (pending.temporaryAdmin.toLowerCase() !== config.deployer.toLowerCase())
    fail("current deployer does not match pending temporaryAdmin");
  const logRoot = resolve(config.stateDir, "logs", timestampId());
  await preflight(config);
  await runLocalGates(config, logRoot);
  const publicClient = client(config.rpcA);
  const before = await bootstrapStatus(publicClient, pending);
  if (before.done || before.factoryActive)
    fail("bootstrap is already finalized; use status/verify");
  if (!before.ready)
    fail(`bootstrap is not ready; Timelock timestamp is ${before.scheduledTimestamp}`, 75);
  const finalizeEnv = {
    EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT: pending.factoryActivationFingerprint,
    TIMELOCK_ADDRESS: pending.timelock,
    FACTORY_ADDRESS: pending.factory,
    MARKETPLACE_ADDRESS: pending.marketplace,
    EXPOSURE_GUARD_ADDRESS: pending.exposureGuard,
    FEE_VAULT_ADDRESS: pending.feeVault,
    BOND_ESCROW_ADDRESS: pending.bondEscrow,
    FULL_DEPLOYER_ADDRESS: pending.fullMarketDeployer,
  };
  await runForgeScript(config, FINALIZE_SCRIPT, {
    env: finalizeEnv,
    logPath: resolve(logRoot, "finalize-simulation.log"),
    quiet: true,
  });
  await confirmAction(
    options,
    config,
    "FINALIZE",
    pending.factoryActivationFingerprint,
  );
  await persistState(config, { status: "FINALIZING" });
  try {
    await runForgeScript(config, FINALIZE_SCRIPT, {
      broadcast: true,
      env: finalizeEnv,
      logPath: resolve(logRoot, "finalize-broadcast.log"),
    });
    const broadcastPath = resolve(
      config.stateDir,
      "foundry/broadcast/FinalizeBootstrap.s.sol/421614/run-latest.json",
    );
    const broadcast = await broadcastEvidence(broadcastPath, 4);
    const after = await bootstrapStatus(publicClient, pending);
    if (!after.done || !after.factoryActive) fail("post-finalize bootstrap state is incomplete");
    if (
      after.activationFingerprint.toLowerCase() !==
      pending.factoryActivationFingerprint.toLowerCase()
    )
      fail("post-finalize activation fingerprint mismatch");
    const [proposerRole, cancellerRole] = await Promise.all([
      publicClient.readContract({
        address: pending.timelock,
        abi: TIMELOCK_ABI,
        functionName: "PROPOSER_ROLE",
      }),
      publicClient.readContract({
        address: pending.timelock,
        abi: TIMELOCK_ABI,
        functionName: "CANCELLER_ROLE",
      }),
    ]);
    const roles = await Promise.all(
      [proposerRole, cancellerRole, ZERO_HASH].map((role) =>
        publicClient.readContract({
          address: pending.timelock,
          abi: TIMELOCK_ABI,
          functionName: "hasRole",
          args: [role, config.deployer],
        }),
      ),
    );
    if (roles.some(Boolean)) fail("temporary deployer Timelock role remains after finalize");
    await persistState(config, {
      status: "FINALIZED_PENDING_EVIDENCE_VERIFICATION",
      finalizeBroadcast: broadcast,
      bootstrap: after,
      logs: { root: logRoot },
    });
    process.stdout.write("\nBootstrap finalized and temporary deployer roles revoked.\n");
    process.stdout.write("Next: build final runtime manifest, then run verify.\n");
    return after;
  } catch (error) {
    await persistState(config, {
      status: "FINALIZE_FAILED_REQUIRES_INSPECTION",
      lastFailure: redact(error.message, [config.privateKey, config.rpcA, config.rpcB]),
    });
    throw error;
  }
}

async function waitUntilReady(config) {
  const pending = validatePendingManifest(await readJson(STATIC_PENDING), {
    profile: config.profile,
  });
  const publicClient = client(config.rpcA);
  for (;;) {
    const status = await bootstrapStatus(publicClient, pending);
    if (status.ready || status.done) return status;
    const remaining = Math.max(
      0,
      Number(status.scheduledTimestamp) - Math.floor(Date.now() / 1000),
    );
    process.stdout.write(`Timelock not ready; approximately ${remaining}s remaining.\n`);
    await new Promise((resolvePromise) =>
      setTimeout(resolvePromise, optionsPollMilliseconds(config)),
    );
  }
}

function optionsPollMilliseconds(config) {
  return (config.pollSeconds ?? 30) * 1000;
}

async function runVerify(options, config) {
  if (!options.manifest) fail("verify requires --manifest <final-manifest.json>", 2);
  const logRoot = resolve(config.stateDir, "logs", timestampId());
  const verifyEnv = {
    ...process.env,
    ...config.env,
    ARBITRUM_SEPOLIA_RPC_URL_A: config.rpcA,
    ARBITRUM_SEPOLIA_RPC_URL_B: config.rpcB ?? "",
  };
  const commands = [
    ["scripts/deployment/validate-final-manifest.mjs", [options.manifest]],
    ["scripts/deployment/verify-live-rpc.mjs", [options.manifest]],
  ];
  if (options.canaryEvidence)
    commands.push([
      "scripts/deployment/validate-canary-evidence.mjs",
      [options.canaryEvidence],
    ]);
  if (options.opsEvidence)
    commands.push([
      "scripts/deployment/validate-ops-evidence.mjs",
      [options.opsEvidence],
    ]);
  for (let index = 0; index < commands.length; index += 1) {
    const [script, args] = commands[index];
    await runCommand(process.execPath, [script, ...args], {
      env: verifyEnv,
      logPath: resolve(logRoot, `verify-${index + 1}.log`),
      secrets: [config.rpcA, config.rpcB],
    });
  }
  await persistState(config, {
    status:
      options.canaryEvidence && options.opsEvidence
        ? "FINALIZED_VERIFIED"
        : "FINALIZED_MANIFEST_AND_RPC_VERIFIED",
    finalManifest: options.manifest,
    finalManifestSha256: await sha256File(options.manifest),
    logs: { root: logRoot },
  });
}

function printHelp() {
  process.stdout.write(`Cpredict Arbitrum Sepolia deployment orchestrator

Usage:
  scripts/deployment/deploy-arbitrum-sepolia.sh <command> [options]

Commands:
  preflight  Validate config, chain, balance, roles, dependencies and local gates
  plan       Simulate deployment and derive the address-bound Factory fingerprint
  deploy     Preflight + plan + exact simulation + confirmed broadcast
  finalize   After the 1h Timelock, simulate + confirmed broadcast + revoke deployer roles
  status     Read-only live deployment/bootstrap status
  verify     Validate final manifest and compare it through two RPC providers
  all        Deploy; optionally wait and finalize with --wait-for-timelock

Options:
  --env-file <path>          Default: .env.arbitrum-sepolia.local (safe KEY=VALUE parser)
  --profile formal|debug|sandbox
                              Default: formal; sandbox deploys unrestricted-mint ctUSD
  --state-dir <path>         Default: deployments/arbitrum-sepolia/runtime
  --yes                      Non-interactive; requires CPREDICT_DEPLOYMENT_ACKNOWLEDGEMENT
  --resume                   Resume only a recorded partial deployment broadcast
  --wait-for-timelock        With all, poll and finalize after the one-hour delay
  --poll-seconds <n>         Timelock polling interval, minimum 5, default 30
  --manifest <path>          Required by verify
  --canary-evidence <path>   Optional strict canary evidence for verify
  --ops-evidence <path>      Optional strict operations evidence for verify

Examples:
  cp deployments/arbitrum-sepolia/deploy.env.example .env.arbitrum-sepolia.local
  chmod 600 .env.arbitrum-sepolia.local
  scripts/deployment/deploy-arbitrum-sepolia.sh preflight --profile debug
  scripts/deployment/deploy-arbitrum-sepolia.sh deploy --profile debug
  scripts/deployment/deploy-arbitrum-sepolia.sh finalize --profile debug
  scripts/deployment/deploy-arbitrum-sepolia.sh all --profile sandbox --wait-for-timelock
`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === "help") return printHelp();
  const needSigner = !new Set(["status", "verify"]).has(options.command);
  const config = await loadConfig(options, {
    needSigner,
    requireSecondary: options.command !== "status",
  });
  config.pollSeconds = options.pollSeconds;
  if (options.command !== "status")
    await ensurePrivateStateDirectory(config.stateDir);
  if (options.command === "status") {
    process.stdout.write(`${JSON.stringify(await publicStatus(config), null, 2)}\n`);
    return;
  }
  if (options.command === "verify") return await runVerify(options, config);
  if (options.command === "preflight") {
    const logRoot = resolve(config.stateDir, "logs", timestampId());
    const result = await preflight(config);
    await runLocalGates(config, logRoot);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (options.command === "plan") return await runPlan(config);
  if (options.command === "deploy") return await runDeploy(options, config);
  if (options.command === "finalize") return await runFinalize(options, config);
  if (options.command === "all") {
    if (!(await fileExists(STATIC_PENDING))) await runDeploy(options, config);
    const current = await publicStatus(config);
    if (current.bootstrap?.factoryActive) {
      process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
      return;
    }
    if (!options.waitForTimelock) {
      process.stdout.write(
        "Deployment scheduled. Re-run with finalize after the Timelock, or use all --wait-for-timelock.\n",
      );
      return;
    }
    await waitUntilReady(config);
    return await runFinalize(options, config);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `FAIL ${redact(error.message, [...ACTIVE_SECRETS])}\n`,
    );
    process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1;
  });
}
