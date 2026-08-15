import { createHash, createPublicKey } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validateCommercialBundle } from "../../load/distributed/commercial-evidence.mjs";
import {
  RELEASE_GATE_RUNNER_ID,
  REQUIRED_GATE_POLICY,
} from "./release-gates-common.mjs";

const GATE_ID = "commercial-load";
const RAW_ROOT = "reports/release/raw/commercial-load";

export function parseArguments(args) {
  const result = {};
  const mappings = new Map([
    ["--bundle", "bundle"],
    ["--trusted-public-key", "trustedPublicKey"],
    ["--trusted-public-key-sha256", "trustedPublicKeySha256"],
    ["--evidence-root", "evidenceRoot"],
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = mappings.get(args[index]);
    const value = args[index + 1];
    if (key === undefined || value === undefined)
      throw new Error(
        `unknown or incomplete argument ${args[index] ?? "<missing>"}`,
      );
    result[key] = value;
  }
  for (const key of mappings.values()) {
    if (typeof result[key] !== "string" || result[key].length === 0)
      throw new Error(`${key} is required`);
  }
  if (!/^[0-9a-f]{64}$/.test(result.trustedPublicKeySha256))
    throw new Error("trustedPublicKeySha256 must be a lowercase SHA-256");
  return result;
}

export async function recordCommercialLoad({
  root = process.cwd(),
  bundle,
  trustedPublicKey,
  trustedPublicKeySha256,
  evidenceRoot,
  environment = process.env,
}) {
  const checkout = realpathSync(root);
  const sourceBundle = realpathSync(bundle);
  const output = resolve(evidenceRoot);
  assertOutsideCheckout(checkout, output);
  const auditCommit = environment.GITHUB_SHA;
  if (typeof auditCommit !== "string" || !/^[0-9a-f]{40}$/.test(auditCommit)) {
    throw new Error(
      "GITHUB_SHA must be the exact lowercase audit commit for commercial-load recording",
    );
  }
  const normalizedPublicKey = String(
    createPublicKey(readFileSync(trustedPublicKey, "utf8")).export({
      type: "spki",
      format: "pem",
    }),
  );
  if (sha256(normalizedPublicKey) !== trustedPublicKeySha256)
    throw new Error(
      "trusted commercial-load public key does not match protected SHA-256",
    );

  const manifest = await validateCommercialBundle(
    sourceBundle,
    undefined,
    trustedPublicKey,
  );
  const sourceManifestBytes = readFileSync(
    join(checkout, "manifests/source-manifest.json"),
  );
  const sourceManifestSha256 = sha256(sourceManifestBytes);
  const roleEvidenceByName = {};
  for (const role of ["sut", "load", "chain"]) {
    roleEvidenceByName[role] = readJson(
      join(sourceBundle, manifest.roles[role].evidencePath),
    );
  }
  validateCommercialLoadSameSha({
    roles: roleEvidenceByName,
    sourceManifestSha256,
    auditCommit,
  });

  const rawEvidence = [];
  copyBundleFile(
    sourceBundle,
    output,
    "commercial-evidence-v4.json",
    `${RAW_ROOT}/commercial-evidence-v4.json`,
    rawEvidence,
    "manifest",
  );
  copyBundleFile(
    sourceBundle,
    output,
    "commercial-evidence-v4.sig",
    `${RAW_ROOT}/commercial-evidence-v4.sig`,
    rawEvidence,
    "signature",
  );
  copyExternalFile(
    trustedPublicKey,
    output,
    `${RAW_ROOT}/trusted-public-key.pem`,
  );
  rawEvidence.push({
    role: "trusted-public-key",
    ...descriptor(output, `${RAW_ROOT}/trusted-public-key.pem`),
  });

  for (const role of ["sut", "load", "chain"]) {
    const reference = manifest.roles[role];
    const roleEvidence = readJson(join(sourceBundle, reference.evidencePath));
    copyBundleFile(
      sourceBundle,
      output,
      reference.evidencePath,
      `${RAW_ROOT}/${reference.evidencePath}`,
      rawEvidence,
      `${role}-role-evidence`,
    );
    const expectedNames = new Set(
      roleEvidence.artifacts.map((artifact) => artifact.name),
    );
    const sourceRoleDirectory = resolve(sourceBundle, "roles", role);
    const observedNames = readdirSync(sourceRoleDirectory)
      .filter((name) => name !== "role-evidence.json" && !name.startsWith("."))
      .sort();
    if (
      JSON.stringify(observedNames) !==
      JSON.stringify([...expectedNames].sort())
    ) {
      throw new Error(
        `${role} commercial-load artifact inventory differs from the signed role evidence`,
      );
    }
    for (const artifact of roleEvidence.artifacts) {
      const sourcePath = `roles/${role}/${artifact.name}`;
      const destinationPath = `${RAW_ROOT}/${sourcePath}`;
      copyBundleFile(
        sourceBundle,
        output,
        sourcePath,
        destinationPath,
        rawEvidence,
        `${role}-${slug(artifact.name)}`,
      );
      const copied = descriptor(output, destinationPath);
      if (
        copied.sha256 !== artifact.sha256 ||
        readFileSync(join(output, destinationPath)).length !== artifact.bytes
      ) {
        throw new Error(
          `${role} commercial-load artifact does not match the signed role inventory: ${basename(artifact.name)}`,
        );
      }
    }
  }
  rawEvidence.sort((left, right) =>
    Buffer.compare(Buffer.from(left.role), Buffer.from(right.role)),
  );

  const policy = REQUIRED_GATE_POLICY.find((item) => item.id === GATE_ID);
  if (policy === undefined)
    throw new Error("commercial-load release policy is absent");
  const result = {
    schemaVersion: 1,
    gateId: GATE_ID,
    runnerId: RELEASE_GATE_RUNNER_ID,
    command: policy.command,
    executionProfile: "FULL",
    result: "PASS",
    exitCode: 0,
    sourceManifestSha256,
    rawEvidence,
  };
  writeJsonExclusive(output, policy.resultPath, result);
  return result;
}

export function validateCommercialLoadSameSha({
  roles,
  sourceManifestSha256,
  auditCommit,
}) {
  if (typeof auditCommit !== "string" || !/^[0-9a-f]{40}$/.test(auditCommit)) {
    throw new Error(
      "GITHUB_SHA must be the exact lowercase audit commit for commercial-load recording",
    );
  }
  if (
    typeof sourceManifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sourceManifestSha256)
  ) {
    throw new Error("commercial-load source manifest SHA-256 is invalid");
  }
  for (const role of ["sut", "load", "chain"]) {
    const binding = roles?.[role]?.releaseBinding;
    if (binding?.sourceManifestSha256 !== sourceManifestSha256) {
      throw new Error(
        `${role} commercial-load evidence is not bound to this source manifest`,
      );
    }
    if (binding.gitCommitSha !== auditCommit) {
      throw new Error(
        `${role} commercial-load evidence is not bound to the GitHub audit commit`,
      );
    }
  }
}

function copyBundleFile(
  bundleRoot,
  outputRoot,
  sourcePath,
  destinationPath,
  inventory,
  role,
) {
  const source = resolve(bundleRoot, sourcePath);
  const child = relative(bundleRoot, source);
  if (
    child === "" ||
    child.startsWith("..") ||
    child.includes(`${sep}..${sep}`)
  )
    throw new Error(`commercial-load bundle path escapes root: ${sourcePath}`);
  const metadata = lstatSync(source);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(
      `commercial-load evidence must be a regular file: ${sourcePath}`,
    );
  copyExternalFile(source, outputRoot, destinationPath);
  inventory.push({ role, ...descriptor(outputRoot, destinationPath) });
}

function copyExternalFile(source, outputRoot, destinationPath) {
  const destination = resolve(outputRoot, destinationPath);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination, 0);
}

function writeJsonExclusive(outputRoot, path, value) {
  const destination = resolve(outputRoot, path);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const fd = openSync(destination, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    closeSync(fd);
  }
}

function descriptor(outputRoot, path) {
  return { path, sha256: sha256(readFileSync(join(outputRoot, path))) };
}
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function assertOutsideCheckout(checkout, output) {
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const actualOutput = realpathSync(output);
  const child = relative(checkout, actualOutput);
  if (
    child === "" ||
    (!child.startsWith("..") && !child.includes(`${sep}..${sep}`))
  ) {
    throw new Error(
      "commercial-load release evidence root must be outside the source checkout",
    );
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const result = await recordCommercialLoad(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(`commercial-load release gate: ${result.result}\n`);
  } catch (error) {
    process.stderr.write(
      `commercial-load release gate failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
