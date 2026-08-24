#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
} from "viem";
import { canonicalJson, readJson } from "./evidence-lib.mjs";
import { validateFinalManifest } from "./validate-final-manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONTRACTS = {
  timelock: "lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController",
  config: "src/core/ProtocolConfigV1.sol:ProtocolConfigV1",
  emergencyController: "src/core/EmergencyControllerV1.sol:EmergencyControllerV1",
  exposureGuard: "src/core/LaunchExposureGuardV1.sol:LaunchExposureGuardV1",
  feeVault: "src/core/FeeVaultV1.sol:FeeVaultV1",
  bondEscrow: "src/core/BondEscrowV1.sol:BondEscrowV1",
  cloneImplementation: "src/market/CloneMarketVaultV1.sol:CloneMarketVaultV1",
  fullMarketDeployer: "src/core/FullMarketDeployerV1.sol:FullMarketDeployerV1",
  factory: "src/core/MarketFactoryV1.sol:MarketFactoryV1",
  marketplace: "src/marketplace/FixedPriceMarketplaceV1.sol:FixedPriceMarketplaceV1",
  paymaster: "src/paymaster/SponsorshipPaymasterV1.sol:SponsorshipPaymasterV1",
};

export function buildVerificationPlan(manifest) {
  validateFinalManifest(manifest, {
    allowPendingCanary: true,
    allowPendingSourceVerification: true,
  });
  return Object.entries(CONTRACTS).map(([contract, source]) => {
    const record = manifest.contracts[contract];
    const constructorArgs = encodeConstructorArgs(record.constructorArgs);
    return {
      contract,
      address: getAddress(record.address),
      source,
      constructorArgs,
      runtimeCodehash: record.runtimeCodehash.toLowerCase(),
      compiler: manifest.source.compiler,
      optimizerRuns: manifest.source.optimizerRuns,
      viaIR: manifest.source.viaIR,
      evmVersion: manifest.source.evmVersion,
      command: buildForgeVerificationCommand({
        address: record.address,
        source,
        constructorArgs,
        compiler: manifest.source.compiler,
        optimizerRuns: manifest.source.optimizerRuns,
        viaIR: manifest.source.viaIR,
        evmVersion: manifest.source.evmVersion,
      }),
    };
  });
}

export async function executeVerificationPlan({
  manifest,
  rpcUrl,
  apiKey,
  outputPath,
  runner = runCommand,
  client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000 }) }),
}) {
  if (!apiKey) throw new Error("ARBISCAN_API_KEY is required");
  await assertCurrentSourceIdentity(manifest);
  const plan = buildVerificationPlan(manifest);
  const inputSha256 = verificationInputSha(manifest, plan);
  const existing = await readExisting(outputPath);
  if (existing !== null) {
    if (existing.inputSha256 !== inputSha256)
      throw new Error("existing source verification evidence belongs to different input");
    if (canReuseEvidence(existing, inputSha256)) {
      for (const item of plan)
        if (await runtimeCodehash(client, item.address) !== item.runtimeCodehash)
          throw new Error(`${item.contract}: runtime codehash drifted after verification`);
      return { evidence: existing, idempotent: true };
    }
  }
  const results = [];
  for (const item of plan) {
    const before = await runtimeCodehash(client, item.address);
    if (before !== item.runtimeCodehash)
      throw new Error(`${item.contract}: RPC runtime codehash does not match manifest`);
    const startedAt = new Date().toISOString();
    const result = await runner(item.command, {
      cwd: ROOT,
      env: { ...process.env, ETHERSCAN_API_KEY: apiKey, ETH_RPC_URL: rpcUrl },
      secrets: [apiKey, rpcUrl],
    });
    const after = await runtimeCodehash(client, item.address);
    if (after !== before) throw new Error(`${item.contract}: runtime bytecode changed during verification`);
    const combined = `${result.stdout}\n${result.stderr}`;
    const logFile = `${basenameWithoutJson(outputPath)}.${item.contract}.log`;
    await writePrivateText(resolve(dirname(outputPath), logFile), combined);
    const success = verificationSucceeded(result.code, combined);
    const record = {
      contract: item.contract,
      address: item.address,
      status: success ? "VERIFIED" : "FAILED",
      constructorArgsVerified: success,
      runtimeBytecodeVerified: after === item.runtimeCodehash,
      startedAt,
      finishedAt: new Date().toISOString(),
      source: item.source,
      sourceCommit: manifest.source.commit,
      compiler: item.compiler,
      optimizerRuns: item.optimizerRuns,
      viaIR: item.viaIR,
      evmVersion: item.evmVersion,
      constructorArgsSha256: sha256Text(item.constructorArgs),
      runtimeCodehash: after,
      commandSummary: redactCommand(item.command),
      exitCode: result.code,
      submissionGuid: extractGuid(combined),
      explorerUrl: `https://sepolia.arbiscan.io/address/${item.address}`,
      logFile,
      logSha256: sha256Text(combined),
    };
    results.push(record);
    if (!success) {
      await writeEvidence(outputPath, buildEvidence(manifest, inputSha256, results, "FAILED"));
      throw new Error(`${item.contract}: Arbiscan verification failed (exit ${result.code})`);
    }
  }
  const evidence = buildEvidence(manifest, inputSha256, results, "COMPLETE");
  await writeEvidence(outputPath, evidence);
  return { evidence, idempotent: false };
}

export function verificationInputSha(manifest, plan = buildVerificationPlan(manifest)) {
  return sha256Text(canonicalJson({
    source: manifest.source,
    contracts: plan.map(({ contract, address, source, constructorArgs, runtimeCodehash }) => ({
      contract, address, source, constructorArgs, runtimeCodehash,
    })),
  }));
}

export async function assertCurrentSourceIdentity(manifest, git = spawnSync) {
  const sourceManifestSha256 = sha256Text(await readFile(resolve(ROOT, "manifests/source-manifest.json")));
  if (manifest.source.sourceManifestSha256 !== sourceManifestSha256)
    throw new Error("source manifest SHA-256 drifted before source verification");
  const head = git("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (head.status !== 0 || head.stdout.trim() !== manifest.source.commit)
    throw new Error("source verification manifest commit does not equal checkout HEAD");
  const status = git("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: ROOT, encoding: "utf8" });
  if (status.status !== 0 || status.stdout.trim() !== "")
    throw new Error("source verification requires a clean checkout");
}

function buildEvidence(manifest, inputSha256, contracts, status) {
  return {
    schemaVersion: "cpredict.arbitrum-sepolia.source-verification.v1",
    evidenceClass: "ARBITRUM_SEPOLIA_RUNTIME",
    chainId: 421614,
    status,
    generatedAt: new Date().toISOString(),
    sourceCommit: manifest.source.commit,
    sourceManifestSha256: manifest.source.sourceManifestSha256,
    inputSha256,
    contracts,
  };
}

export function encodeConstructorArgs(args) {
  if (!Array.isArray(args)) throw new Error("constructorArgs must be an array");
  if (args.length === 0) return "0x";
  const parameters = args.map((argument, index) => {
    if (!argument || typeof argument.name !== "string" || typeof argument.type !== "string")
      throw new Error(`constructorArgs[${index}] is invalid`);
    return { name: argument.name, type: argument.type };
  });
  return encodeAbiParameters(parameters, args.map((argument) => normalizeAbiValue(argument.type, argument.value)));
}

export function buildForgeVerificationCommand({ address, source, constructorArgs, compiler, optimizerRuns, viaIR, evmVersion }) {
  return [
    "bash", "scripts/forge.sh", "verify-contract", getAddress(address), source,
    "--chain", "421614", "--verifier", "etherscan", "--watch", "--retries", "0",
    "--compiler-version", compiler, "--num-of-optimizations", String(optimizerRuns),
    "--evm-version", evmVersion, ...(viaIR ? ["--via-ir"] : []),
    ...(constructorArgs === "0x" ? [] : ["--constructor-args", constructorArgs]),
  ];
}

export function verificationSucceeded(code, output) {
  return code === 0 && /already verified|verified|pass/i.test(output);
}

export function canReuseEvidence(existing, inputSha256) {
  return existing?.inputSha256 === inputSha256 &&
    existing.status === "COMPLETE" &&
    Array.isArray(existing.contracts) &&
    existing.contracts.length === 11 &&
    existing.contracts.every((item) => item.status === "VERIFIED");
}

function normalizeAbiValue(type, value) {
  if (type.endsWith("[]")) {
    if (!Array.isArray(value)) throw new Error(`${type} constructor value must be an array`);
    return value.map((item) => normalizeAbiValue(type.slice(0, -2), item));
  }
  if (/^u?int(?:[0-9]+)?$/.test(type)) return BigInt(value);
  if (type === "address") return getAddress(value);
  return value;
}

async function runtimeCodehash(client, address) {
  const code = await client.getCode({ address });
  if (code === undefined || code === "0x") throw new Error(`${address}: no runtime bytecode`);
  return keccak256(code).toLowerCase();
}

async function runCommand(command, { cwd, env, secrets }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({
      code: code ?? 1,
      stdout: redact(Buffer.concat(stdout).toString("utf8"), secrets),
      stderr: redact(Buffer.concat(stderr).toString("utf8"), secrets),
    }));
  });
}

function redact(value, secrets) {
  return secrets.reduce((output, secret) => secret ? output.split(secret).join("[REDACTED]") : output, value);
}

export function redactCommand(command) {
  const copy = [...command];
  const index = copy.indexOf("--constructor-args");
  if (index >= 0) copy[index + 1] = `[sha256:${sha256Text(copy[index + 1])}]`;
  return copy.join(" ");
}

function extractGuid(value) {
  return value.match(/(?:GUID|guid)[:\s]+([A-Za-z0-9_-]{6,128})/)?.[1] ?? null;
}

async function readExisting(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`${path}: existing source verification evidence is invalid (${error.message})`);
  }
}

async function writeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function writePrivateText(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}

function basenameWithoutJson(path) {
  const name = path.split(/[\\/]/).at(-1) ?? "source-verification";
  return name.endsWith(".json") ? name.slice(0, -5) : name;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[++index];
    if (value === undefined) throw new Error(`${key}: missing value`);
    if (key === "--manifest") options.manifest = value;
    else if (key === "--rpc-url") options.rpcUrl = value;
    else if (key === "--output") options.output = value;
    else throw new Error(`unknown option ${key}`);
  }
  for (const key of ["manifest", "rpcUrl"])
    if (!options[key]) throw new Error(`--${key === "rpcUrl" ? "rpc-url" : key} is required`);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = isAbsolute(options.manifest) ? options.manifest : resolve(ROOT, options.manifest);
  const outputPath = options.output
    ? (isAbsolute(options.output) ? options.output : resolve(ROOT, options.output))
    : resolve(ROOT, "runtime/arbitrum-sepolia/source-verification.json");
  const result = await executeVerificationPlan({
    manifest: await readJson(manifestPath),
    rpcUrl: options.rpcUrl,
    apiKey: process.env.ARBISCAN_API_KEY,
    outputPath,
  });
  process.stdout.write(`${result.idempotent ? "UNCHANGED" : "VERIFIED"} ${outputPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
