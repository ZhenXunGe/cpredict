#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REQUIRED_DRILLS } from "../deployment/evidence-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ROOT = resolve(ROOT, "runtime/arbitrum-sepolia/ops-drill");

export async function runLocalOpsDrill({ adapterPath, evidenceRoot = DEFAULT_ROOT, adapter: suppliedAdapter }) {
  const root = resolve(evidenceRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const statePath = resolve(root, "state.json");
  const reportPath = resolve(root, "local-ops-drill-report.json");
  const adapter = suppliedAdapter ?? await loadAdapter(adapterPath);
  const inspection = await adapter.inspect();
  validateInspection(inspection);
  let state = await readOptionalJson(statePath) ?? {
    schemaVersion: "cpredict.local-ops-drill-state.v1",
    evidenceClass: "LOCAL_SIMULATION",
    chainId: 421614,
    sourceManifestSha256: inspection.sourceManifestSha256,
    deploymentManifestSha256: inspection.deploymentManifestSha256,
    adapterSha256: inspection.adapterSha256,
    completed: [],
    active: null,
  };
  validateResume(state, inspection);
  for (const id of REQUIRED_DRILLS) {
    if (state.completed.some((item) => item.id === id)) continue;
    const resuming = state.active?.id === id;
    if (!resuming) {
      state.active = { id, status: "STARTING", startedAt: new Date().toISOString() };
      await atomicJson(statePath, state);
    }
    const execute = resuming ? adapter.resumeDrill : adapter.runDrill;
    if (typeof execute !== "function") throw new Error("ops adapter must provide receipt/state-driven resumeDrill");
    const result = await execute({ id, priorState: state, evidenceRoot: root });
    const validated = await validateLocalDrillResult(result, id, root);
    state.completed.push(validated);
    state.active = null;
    await atomicJson(statePath, state);
  }
  const report = {
    schemaVersion: "cpredict.local-ops-drill.v1",
    evidenceClass: "LOCAL_SIMULATION",
    status: "PASS",
    chainId: 421614,
    generatedAt: new Date().toISOString(),
    sourceManifestSha256: state.sourceManifestSha256,
    deploymentManifestSha256: state.deploymentManifestSha256,
    deploymentIdentity: inspection.deploymentIdentity,
    drills: state.completed,
    formalOpsEvidence: "NOT_RUN",
  };
  await atomicJson(reportPath, report);
  return { report, reportPath };
}

export async function validateLocalDrillResult(result, id, root) {
  if (!result || result.id !== id || result.status !== "PASS")
    throw new Error(`${id}: local drill did not pass`);
  if (typeof result.observedOutcome !== "string" || result.observedOutcome.length < 1)
    throw new Error(`${id}: observedOutcome is required`);
  if (!Array.isArray(result.artifacts) || result.artifacts.length === 0)
    throw new Error(`${id}: at least one local artifact is required`);
  const artifacts = [];
  for (const artifact of result.artifacts) {
    if (!isAbsolute(artifact.path)) throw new Error(`${id}: artifact path must be absolute`);
    assertWithin(artifact.path, root, `${id} artifact`);
    const metadata = await stat(artifact.path);
    const sha256 = await sha256File(artifact.path);
    if (metadata.size <= 0 || sha256 !== artifact.sha256)
      throw new Error(`${id}: artifact size or SHA-256 mismatch`);
    artifacts.push({
      kind: artifact.kind,
      path: relative(root, artifact.path),
      bytes: metadata.size,
      sha256,
    });
  }
  return {
    id,
    status: "PASS",
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    observedOutcome: result.observedOutcome,
    artifacts,
  };
}

function validateInspection(value) {
  if (value?.chainId !== 421614) throw new Error("ops adapter chainId must equal 421614");
  if (value.environment !== "LOCAL_COMPOSE")
    throw new Error("local ops runner accepts only LOCAL_COMPOSE adapters");
  for (const key of ["sourceManifestSha256", "deploymentManifestSha256", "adapterSha256"])
    if (!/^[0-9a-f]{64}$/.test(value[key] ?? "")) throw new Error(`${key} is invalid`);
  if (typeof value.deploymentIdentity !== "string" || value.deploymentIdentity.length === 0)
    throw new Error("deploymentIdentity is required");
}

function validateResume(state, inspection) {
  for (const key of ["sourceManifestSha256", "deploymentManifestSha256", "adapterSha256"])
    if (state[key] !== inspection[key]) throw new Error(`ops drill ${key} changed during resume`);
  const ids = state.completed.map((item) => item.id);
  if (ids.some((id) => !REQUIRED_DRILLS.includes(id)) || new Set(ids).size !== ids.length)
    throw new Error("ops drill state inventory is invalid");
}

async function loadAdapter(path) {
  if (!path) throw new Error("--adapter or CPREDICT_LOCAL_OPS_ADAPTER is required");
  const requested = path.startsWith("file://") ? fileURLToPath(path) : path;
  const absolute = await realpath(requested);
  if (!isAbsolute(absolute)) throw new Error("ops adapter path must be absolute");
  await access(absolute);
  const module = await import(`${pathToFileURL(absolute).href}?sha=${await sha256File(absolute)}`);
  return module.default ?? module;
}

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function assertWithin(path, parent, label) {
  const child = relative(parent, path);
  if (child === "" || child === ".") return;
  if (child.startsWith("..") || isAbsolute(child)) throw new Error(`${label} escapes evidence root`);
}

async function sha256File(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }

function parseArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[++index];
    if (value === undefined) throw new Error(`${flag}: missing value`);
    if (flag === "--adapter") output.adapterPath = value;
    else if (flag === "--evidence-root") output.evidenceRoot = value;
    else throw new Error(`unknown option ${flag}`);
  }
  output.adapterPath ??= process.env.CPREDICT_LOCAL_OPS_ADAPTER;
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLocalOpsDrill(parseArgs(process.argv.slice(2))).then(({ reportPath }) => process.stdout.write(`PASS LOCAL_SIMULATION ${reportPath}\n`)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
