#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAddress } from "viem";
import { REQUIRED_CANARY_STEPS, readJson, sha256Json } from "./evidence-lib.mjs";
import { validateCanaryEvidence } from "./validate-canary-evidence.mjs";
import { validateFinalManifest } from "./validate-final-manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ROOT = resolve(ROOT, "runtime/arbitrum-sepolia/canary");
const FINISH_STEP = "timeout.deadlineCreatorVoidRejected";
const START_STEPS = REQUIRED_CANARY_STEPS.filter((id) => id !== FINISH_STEP);

export async function runCanary({
  command,
  manifestPath,
  adapterPath,
  stateRoot = DEFAULT_ROOT,
  winningOutcome,
  adapter: suppliedAdapter,
  now = () => new Date().toISOString(),
}) {
  if (!["start", "status", "finish"].includes(command))
    throw new Error("canary command must be start, status or finish");
  const root = resolve(stateRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const statePath = resolve(root, "state.json");
  const evidencePath = resolve(root, "canary-evidence.json");
  const manifest = await readJson(resolvePath(manifestPath));
  validateFinalManifest(manifest, { allowPendingCanary: true });
  const manifestSha256 = sha256Text(await readFile(resolvePath(manifestPath)));
  const adapter = suppliedAdapter ?? await loadAdapter(adapterPath);
  const inspection = await adapter.inspect({ manifest });
  validateInspection(inspection, manifest);
  let state = await readOptionalJson(statePath);
  if (state !== null) validateResumeIdentity(state, manifest, manifestSha256, inspection);
  if (command === "status") return { state, inspection, evidencePath };
  if (command === "start") {
    if (state?.phase === "COMPLETE" || state?.phase === "STARTED" || state?.phase === "FINISHING")
      throw new Error(`canary already ${state.phase.toLowerCase()}; use status or finish`);
    if (!inspection.paymasterReady) {
      state = baseState({ manifest, manifestSha256, inspection, phase: "BLOCKED", now });
      state.blocker = "PAYMASTER_PROFILE_NOT_READY";
      await atomicJson(statePath, state);
      throw new Error("Paymaster profile is not ready; complete canary cannot be generated");
    }
    const outcome = Number(winningOutcome);
    if (!Number.isInteger(outcome) || outcome < 0 || outcome > 31)
      throw new Error("start requires an explicitly selected --winning-outcome 0..31");
    const operationId = state?.operationId ?? sha256Json({
      manifestSha256,
      accounts: inspection.accounts,
      winningOutcome: outcome,
    });
    if (state === null || state.phase === "BLOCKED") {
      state = {
        ...baseState({ manifest, manifestSha256, inspection, phase: "STARTING", now }),
        operationId,
        winningOutcome: outcome,
        steps: [],
      };
      await atomicJson(statePath, state);
    }
    if (state.phase !== "STARTING") throw new Error(`cannot start from ${state.phase}`);
    const execute = state.startAttemptedAt ? adapter.resumeStart : adapter.start;
    if (typeof execute !== "function")
      throw new Error("adapter must provide resumeStart for receipt-driven recovery");
    state.startAttemptedAt ??= now();
    state.updatedAt = now();
    await atomicJson(statePath, state);
    const result = await execute({ manifest, operationId, winningOutcome: outcome, priorState: state });
    validateStartResult(result);
    state = {
      ...state,
      phase: "STARTED",
      startedAt: now(),
      steps: result.steps,
      timeoutSeed: result.timeoutSeed,
      zeroParticipantTimeoutSeed: result.zeroParticipantTimeoutSeed,
      earliestFinishAt: Math.max(result.timeoutSeed.deadline, result.zeroParticipantTimeoutSeed.deadline),
      updatedAt: now(),
    };
    await atomicJson(statePath, state);
    return { state, inspection, evidencePath };
  }
  if (state === null) throw new Error("canary has not been started");
  if (state.phase === "COMPLETE") return { state, inspection, evidencePath };
  validateFinishReadiness(state, inspection);
  const resumingFinish = state.phase === "FINISHING";
  if (!resumingFinish) {
    state.phase = "FINISHING";
    state.finishAttemptedAt = now();
    state.updatedAt = now();
    await atomicJson(statePath, state);
  }
  const execute = resumingFinish ? adapter.resumeFinish : adapter.finish;
  if (typeof execute !== "function")
    throw new Error("adapter must provide resumeFinish for receipt-driven recovery");
  const result = await execute({ manifest, operationId: state.operationId, priorState: state });
  const evidence = {
    schemaVersion: "cpredict.arbitrum-sepolia.canary.v1",
    evidenceClass: "ARBITRUM_SEPOLIA_RUNTIME",
    status: "COMPLETE",
    chainId: 421614,
    generatedAt: now(),
    deploymentIdentity: expectedDeploymentIdentity(manifest),
    referenceBlock: result.referenceBlock,
    steps: [...state.steps, result.deadlineCreatorVoidRejected],
    timeoutCanary: result.timeoutCanary,
    zeroParticipantTimeoutCanary: result.zeroParticipantTimeoutCanary,
  };
  const validated = validateCanaryEvidence(evidence);
  await atomicJson(evidencePath, evidence);
  state = {
    ...state,
    phase: "COMPLETE",
    completedAt: now(),
    evidenceSha256: validated.sha256,
    evidencePath,
    updatedAt: now(),
  };
  await atomicJson(statePath, state);
  return { state, inspection, evidencePath };
}

function baseState({ manifest, manifestSha256, inspection, phase, now }) {
  return {
    schemaVersion: "cpredict.arbitrum-sepolia.canary-state.v1",
    evidenceClass: "ARBITRUM_SEPOLIA_RUNTIME",
    chainId: 421614,
    phase,
    updatedAt: now(),
    manifestSha256,
    sourceManifestSha256: manifest.source.sourceManifestSha256,
    deploymentIdentity: expectedDeploymentIdentity(manifest),
    accounts: inspection.accounts.map(getAddress),
    adapterSha256: inspection.adapterSha256,
  };
}

export function validateInspection(value, manifest) {
  if (!value || typeof value !== "object") throw new Error("adapter inspect result must be an object");
  if (value.chainId !== 421614) throw new Error("adapter is not connected to Arbitrum Sepolia");
  if (value.environment !== "ARBITRUM_SEPOLIA_RUNTIME")
    throw new Error("local simulation adapters are forbidden for runtime canary evidence");
  if (!Number.isInteger(value.chainTimestamp) || value.chainTimestamp < 1)
    throw new Error("adapter chainTimestamp is invalid");
  if (!Array.isArray(value.accounts) || value.accounts.length !== 3)
    throw new Error("adapter must expose exactly three canary accounts");
  const accounts = value.accounts.map(getAddress);
  if (new Set(accounts.map((item) => item.toLowerCase())).size !== 3)
    throw new Error("canary accounts must be distinct");
  if (
    !Array.isArray(value.balances) ||
    value.balances.length !== 3 ||
    value.balances.some((balance) => !/^[1-9][0-9]*$/.test(balance.nativeWei ?? "") || !/^[1-9][0-9]*$/.test(balance.usdcUnits ?? ""))
  ) throw new Error("all three canary accounts require positive native and USDC balances");
  if (value.externalDependenciesVerified !== true)
    throw new Error("canonical USDC, Permit2 and EntryPoint must be runtime verified before canary");
  if (!/^[0-9a-f]{64}$/.test(value.adapterSha256 ?? ""))
    throw new Error("adapterSha256 must bind the execution adapter");
  if (canonical(value.deploymentIdentity) !== canonical(expectedDeploymentIdentity(manifest)))
    throw new Error("adapter deployment identity does not match manifest");
}

export function validateResumeIdentity(state, manifest, manifestSha256, inspection) {
  if (state.manifestSha256 !== manifestSha256) throw new Error("canary state belongs to another manifest");
  if (state.sourceManifestSha256 !== manifest.source.sourceManifestSha256)
    throw new Error("canary state source manifest mismatch");
  if (state.adapterSha256 !== inspection.adapterSha256) throw new Error("canary adapter changed during run");
  if (canonical(state.accounts) !== canonical(inspection.accounts.map(getAddress)))
    throw new Error("canary accounts changed during run");
  if (canonical(state.deploymentIdentity) !== canonical(expectedDeploymentIdentity(manifest)))
    throw new Error("canary deployment identity changed during run");
}

export function validateFinishReadiness(state, inspection) {
  if (!["STARTED", "FINISHING"].includes(state.phase))
    throw new Error(`cannot finish canary from ${state.phase}`);
  if (inspection.chainTimestamp < state.earliestFinishAt)
    throw new Error(`finish is too early; chain timestamp ${inspection.chainTimestamp} < ${state.earliestFinishAt}`);
}

export function validateStartResult(result) {
  if (!result || !Array.isArray(result.steps)) throw new Error("adapter start result must contain steps[]");
  const ids = result.steps.map((step) => step.id);
  if (ids.length !== START_STEPS.length || START_STEPS.some((id) => !ids.includes(id)))
    throw new Error("adapter start result does not contain the exact pre-timeout canary steps");
  for (const key of ["timeoutSeed", "zeroParticipantTimeoutSeed"]) {
    const seed = result[key];
    if (!seed || !/^0x[0-9a-fA-F]{40}$/.test(seed.market ?? ""))
      throw new Error(`${key}.market is invalid`);
    if (!Number.isInteger(seed.closeAt) || seed.deadline !== seed.closeAt + 86_400)
      throw new Error(`${key}.deadline must equal closeAt + 86400`);
  }
  if (result.timeoutSeed.market.toLowerCase() === result.zeroParticipantTimeoutSeed.market.toLowerCase())
    throw new Error("timeout canary markets must be distinct");
}

function expectedDeploymentIdentity(manifest) {
  return {
    factory: manifest.contracts.factory.address,
    factoryActivationFingerprint: manifest.bootstrap.factoryActivationFingerprint,
    bootstrapFinalizeTx: manifest.transactions.bootstrapFinalize.txHash,
    sourceCommit: manifest.source.commit,
  };
}

async function loadAdapter(path) {
  if (!path) throw new Error("CPREDICT_CANARY_EXECUTOR_MODULE or --adapter is required");
  const absolute = await realpath(resolvePath(path.replace(/^file:\/\//, "")));
  if (!isAbsolute(absolute)) throw new Error("canary adapter path must be absolute");
  await access(absolute);
  const metadata = await stat(absolute);
  if (!metadata.isFile()) throw new Error("canary adapter must be a file");
  const module = await import(`${pathToFileURL(absolute).href}?sha=${await sha256File(absolute)}`);
  return module.default ?? module;
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`${path}: invalid canary state (${error.message})`);
  }
}

function canonical(value) { return JSON.stringify(value); }
function sha256Text(value) { return createHash("sha256").update(value).digest("hex"); }
async function sha256File(path) { return sha256Text(await readFile(path)); }
function resolvePath(path) { return isAbsolute(path) ? path : resolve(ROOT, path); }

function parseArgs(argv) {
  const command = argv[0];
  const output = { command };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    if (value === undefined) throw new Error(`${flag}: missing value`);
    if (flag === "--manifest") output.manifestPath = value;
    else if (flag === "--adapter") output.adapterPath = value;
    else if (flag === "--state-root") output.stateRoot = value;
    else if (flag === "--winning-outcome") output.winningOutcome = value;
    else throw new Error(`unknown option ${flag}`);
  }
  output.manifestPath ??= process.env.CPREDICT_CANARY_MANIFEST;
  output.adapterPath ??= process.env.CPREDICT_CANARY_EXECUTOR_MODULE;
  if (!output.manifestPath) throw new Error("--manifest is required");
  return output;
}

async function main() {
  const result = await runCanary(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${result.state?.phase ?? "NOT_STARTED"} ${result.evidencePath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
