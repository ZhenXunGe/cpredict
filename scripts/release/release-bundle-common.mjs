import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  RELEASE_GATES_CONFIG_PATH,
  RELEASE_GATES_PATH,
  checkReleaseGates,
  validateReleaseGatesDocument,
} from "./release-gates-common.mjs";

export const RELEASE_MANIFEST_FILE = "RELEASE-BUNDLE.json";
export const RELEASE_CHECKSUM_FILE = "SHA256SUMS";
export const RELEASE_NODE_VERSION = "22.22.2";
export const FIXED_ARCHIVE = Object.freeze({
  format: "ustar+gzip",
  mode: "0644",
  uid: 0,
  gid: 0,
  uname: "root",
  gname: "root",
  mtime: 0,
  checksumFile: RELEASE_CHECKSUM_FILE,
  manifestFile: RELEASE_MANIFEST_FILE,
});

const REQUIRED_PREFIXES = [
  "generated",
  "docs",
  "reports",
  "deployments",
  "manifests",
];
const RELEASE_MANIFEST_KEYS = [
  "archive",
  "commit",
  "files",
  "project",
  "requirementsManifestSha256",
  "releaseGatesSha256",
  "schemaVersion",
  "sbomSha256",
  "sourceDateEpoch",
  "sourceManifestSha256",
  "tag",
  "tagObject",
];
const ARCHIVE_KEYS = [
  "checksumFile",
  "format",
  "gid",
  "gname",
  "manifestFile",
  "mode",
  "mtime",
  "uid",
  "uname",
];
const FILE_KEYS = ["bytes", "path", "sha256"];
const TAG_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_BLOCK = Buffer.alloc(512);
const MAX_COMPRESSED_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_UNCOMPRESSED_TAR_BYTES = 512 * 1024 * 1024;

export class ReleaseBundleError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseBundleError";
  }
}

export async function assertReleaseGitState(root, tag) {
  assert(
    TAG_PATTERN.test(tag),
    "release tag must be an exact vMAJOR.MINOR.PATCH annotated tag name",
  );
  const actualRoot = await realpath(root);
  const gitRoot = await realpath(
    runText("git", ["rev-parse", "--show-toplevel"], root),
  );
  assert(actualRoot === gitRoot, "release root is not the Git toplevel");
  const head = runText("git", ["rev-parse", "--verify", "HEAD^{commit}"], root);
  const dirty = runText(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    root,
  );
  const tagType = runText("git", ["cat-file", "-t", `refs/tags/${tag}`], root);
  const tagObject = runText(
    "git",
    ["rev-parse", "--verify", `refs/tags/${tag}^{tag}`],
    root,
  );
  const tagCommit = runText(
    "git",
    ["rev-list", "-n", "1", `refs/tags/${tag}`],
    root,
  );
  let signatureVerified = false;
  try {
    runText(
      "git",
      [
        "-c",
        "gpg.format=openpgp",
        "-c",
        "gpg.program=gpg",
        "verify-tag",
        "--raw",
        tag,
      ],
      root,
    );
    signatureVerified = true;
  } catch {
    signatureVerified = false;
  }
  validateReleaseGitState({
    dirty,
    head,
    tag,
    tagType,
    tagObject,
    tagCommit,
    signatureVerified,
  });
  return { head, tag, tagObject };
}

export function validateReleaseGitState(state) {
  assert(TAG_PATTERN.test(state.tag), "invalid release tag name");
  assert(
    state.dirty === "",
    "release checkout must be clean, including untracked files",
  );
  assert(OBJECT_ID_PATTERN.test(state.head), "invalid HEAD object ID");
  assert(
    state.tagType === "tag",
    "release tag must be annotated, not lightweight",
  );
  assert(
    OBJECT_ID_PATTERN.test(state.tagObject),
    "invalid annotated tag object ID",
  );
  assert(state.tagCommit === state.head, "release tag does not point at HEAD");
  assert(
    state.signatureVerified === true,
    "release tag signature verification failed",
  );
}

export async function runReleasePreflights(
  root,
  requirementsSource,
  attestedGatesRoot,
) {
  assert(
    typeof requirementsSource === "string" && requirementsSource.length > 0,
    "requirements source is required",
  );
  runText(
    process.execPath,
    [
      resolve(root, "scripts/check-requirements.mjs"),
      "--source",
      resolve(root, requirementsSource),
    ],
    root,
  );
  runText("npm", ["run", "check:artifacts"], root);
  runText("npm", ["run", "check:sbom"], root);
  runText("npm", ["run", "scan:secrets"], root);
  assert(
    typeof attestedGatesRoot === "string" && attestedGatesRoot.length > 0,
    "attested gates root is required",
  );
  await checkReleaseGates(root, attestedGatesRoot);
}

export async function collectReleasePayload(root, attestedGatesRoot) {
  const sourceManifestPath = resolve(root, "manifests/source-manifest.json");
  const sourceManifestBytes = await readFileRequired(
    sourceManifestPath,
    "source manifest",
  );
  let sourceManifest;
  try {
    sourceManifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  } catch (error) {
    throw new ReleaseBundleError(
      `source manifest is invalid JSON: ${error.message}`,
    );
  }
  assert(
    sourceManifest.schemaVersion === 1,
    "unsupported source manifest schema",
  );
  assert(
    Array.isArray(sourceManifest.files) && sourceManifest.files.length > 0,
    "source manifest files are empty",
  );

  const tracked = gitTrackedPaths(root);
  const selected = new Set([
    "README.md",
    "LICENSE",
    "manifests/source-manifest.json",
    "manifests/sbom.spdx.json",
    "manifests/licenses.json",
    "manifests/third-party-notices.md",
    RELEASE_GATES_CONFIG_PATH,
  ]);
  for (const entry of sourceManifest.files) {
    assertPlainObject(entry, "source manifest file");
    validateBundlePath(entry.path);
    assert(
      /^[0-9a-f]{64}$/.test(entry.sha256),
      `invalid source manifest hash for ${entry.path}`,
    );
    selected.add(entry.path);
  }
  for (const prefix of REQUIRED_PREFIXES) {
    const matches = [...tracked].filter((path) =>
      path.startsWith(`${prefix}/`),
    );
    assert(
      matches.length > 0,
      `release bundle has no tracked ${prefix}/ files`,
    );
    for (const path of matches) selected.add(path);
  }

  const gateDocument = await checkReleaseGates(root, attestedGatesRoot);
  const externalFiles = await collectExternalGateFiles(
    attestedGatesRoot,
    gateDocument,
  );
  for (const path of externalFiles.keys()) selected.add(path);

  assert(
    !selected.has(RELEASE_MANIFEST_FILE),
    `${RELEASE_MANIFEST_FILE} collides with repository payload`,
  );
  assert(
    !selected.has(RELEASE_CHECKSUM_FILE),
    `${RELEASE_CHECKSUM_FILE} collides with repository payload`,
  );
  const sourceHashes = new Map(
    sourceManifest.files.map((entry) => [entry.path, entry.sha256]),
  );
  const actualRoot = await realpath(root);
  const payload = [];
  for (const path of sortPaths([...selected])) {
    validateBundlePath(path);
    const external = externalFiles.get(path);
    assert(
      external !== undefined || tracked.has(path),
      `release payload is neither committed nor attested evidence: ${path}`,
    );
    if (external !== undefined) {
      const sourceHash = sourceHashes.get(path);
      if (sourceHash !== undefined)
        assert(
          external.sha256 === sourceHash,
          `attested evidence conflicts with source manifest: ${path}`,
        );
      payload.push({
        path,
        data: external.data,
        bytes: external.data.length,
        sha256: external.sha256,
      });
      continue;
    }
    const absolute = resolve(root, path);
    const metadata = await lstatRequired(absolute, path);
    assert(
      !metadata.isSymbolicLink(),
      `release payload symlink is forbidden: ${path}`,
    );
    assert(
      metadata.isFile(),
      `release payload must be a regular file: ${path}`,
    );
    const actual = await realpath(absolute);
    assertWithin(
      actualRoot,
      actual,
      `release payload escapes checkout: ${path}`,
    );
    const bytes = await readFileRequired(actual, path);
    const hash = sha256(bytes);
    const sourceHash = sourceHashes.get(path);
    if (sourceHash !== undefined) {
      assert(hash === sourceHash, `stale source manifest hash for ${path}`);
    }
    payload.push({ path, data: bytes, bytes: bytes.length, sha256: hash });
  }
  return payload;
}

async function collectExternalGateFiles(evidenceRoot, document) {
  assert(
    typeof evidenceRoot === "string" && evidenceRoot.length > 0,
    "attested gates root is required",
  );
  const root = await realpath(resolve(evidenceRoot));
  const required = new Set([RELEASE_GATES_PATH]);
  for (const gate of document.gates) {
    required.add(gate.resultPath);
    const resultBytes = await readExternalEvidence(root, gate.resultPath);
    let result;
    try {
      result = JSON.parse(resultBytes.toString("utf8"));
    } catch (error) {
      throw new ReleaseBundleError(
        `attested gate result is invalid JSON: ${gate.resultPath}: ${error.message}`,
      );
    }
    for (const item of result.rawEvidence ?? []) {
      required.add(item.path);
      if (item.role === "security-evidence") {
        const securityBytes = await readExternalEvidence(root, item.path);
        let security;
        try {
          security = JSON.parse(securityBytes.toString("utf8"));
        } catch (error) {
          throw new ReleaseBundleError(
            `security evidence is invalid JSON: ${item.path}: ${error.message}`,
          );
        }
        for (const nested of [
          ...(security.inputs ?? []),
          ...(security.evidence ?? []),
        ])
          required.add(nested.path);
      }
      if (item.role === "checksums") {
        const checksumBytes = await readExternalEvidence(root, item.path);
        for (const row of checksumBytes
          .toString("utf8")
          .trimEnd()
          .split("\n")) {
          const match = row.match(
            /^[0-9a-f]{64}  (reports\/coverage\/[A-Za-z0-9._-]+)$/,
          );
          if (match === null)
            throw new ReleaseBundleError(
              `invalid attested coverage checksum row: ${row}`,
            );
          required.add(match[1]);
        }
      }
      if (
        item.role.endsWith("-role-evidence") &&
        item.path.startsWith("reports/release/raw/commercial-load/roles/")
      ) {
        const roleBytes = await readExternalEvidence(root, item.path);
        let roleEvidence;
        try {
          roleEvidence = JSON.parse(roleBytes.toString("utf8"));
        } catch (error) {
          throw new ReleaseBundleError(
            `commercial-load role evidence is invalid JSON: ${item.path}: ${error.message}`,
          );
        }
        for (const artifact of roleEvidence.artifacts ?? []) {
          required.add(`${dirname(item.path)}/${artifact.name}`);
        }
      }
    }
  }
  const output = new Map();
  for (const path of required) {
    const absolute = resolve(root, path);
    try {
      const data = await readExternalEvidence(root, path);
      output.set(path, { data, sha256: sha256(data) });
    } catch (error) {
      if (
        path === RELEASE_GATES_PATH ||
        path.startsWith("reports/release/gates/")
      )
        throw error;
      // Static raw evidence may be supplied by the clean source checkout.
    }
  }
  return output;
}

async function readExternalEvidence(root, path) {
  validateBundlePath(path);
  const absolute = resolve(root, path);
  const metadata = await lstatRequired(absolute, `attested evidence ${path}`);
  assert(
    !metadata.isSymbolicLink() && metadata.isFile(),
    `attested evidence must be a regular non-symlink file: ${path}`,
  );
  const actual = await realpath(absolute);
  assertWithin(root, actual, `attested evidence escapes its root: ${path}`);
  return readFileRequired(actual, `attested evidence ${path}`);
}

export function createReleaseBundleBytes({ tag, tagObject, commit, files }) {
  assert(TAG_PATTERN.test(tag), "invalid release tag name");
  assert(OBJECT_ID_PATTERN.test(tagObject), "invalid annotated tag object ID");
  assert(OBJECT_ID_PATTERN.test(commit), "invalid commit object ID");
  const payload = normalizePayload(files);
  const byPath = new Map(payload.map((file) => [file.path, file]));
  const sourceManifest = byPath.get("manifests/source-manifest.json");
  const requirementsManifest = byPath.get(
    "manifests/requirements-traceability.json",
  );
  const releaseGates = byPath.get(RELEASE_GATES_PATH);
  const releaseGatesConfig = byPath.get(RELEASE_GATES_CONFIG_PATH);
  const sbom = byPath.get("manifests/sbom.spdx.json");
  assert(
    sourceManifest !== undefined,
    "release payload is missing source manifest",
  );
  assert(
    requirementsManifest !== undefined,
    "release payload is missing requirements manifest",
  );
  assert(
    releaseGates !== undefined,
    "release payload is missing release gates evidence index",
  );
  assert(
    releaseGatesConfig !== undefined,
    "release payload is missing release gates config",
  );
  assert(sbom !== undefined, "release payload is missing SPDX SBOM");
  assert(byPath.has("README.md"), "release payload is missing README.md");
  assert(byPath.has("LICENSE"), "release payload is missing LICENSE");
  assert(
    byPath.has("manifests/licenses.json"),
    "release payload is missing license inventory",
  );
  assert(
    byPath.has("manifests/third-party-notices.md"),
    "release payload is missing third-party notices",
  );
  validateReleaseGatesInPayload(
    releaseGates,
    releaseGatesConfig,
    sourceManifest.sha256,
    byPath,
  );

  const manifest = {
    schemaVersion: 2,
    project: "cpredict-protocol",
    tag,
    tagObject,
    commit,
    sourceDateEpoch: 0,
    archive: { ...FIXED_ARCHIVE },
    sourceManifestSha256: sourceManifest.sha256,
    requirementsManifestSha256: requirementsManifest.sha256,
    releaseGatesSha256: releaseGates.sha256,
    sbomSha256: sbom.sha256,
    files: payload.map(({ path, bytes, sha256: hash }) => ({
      path,
      bytes,
      sha256: hash,
    })),
  };
  const manifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const checksumEntries = [
    ...payload.map(({ path, sha256: hash }) => ({ path, sha256: hash })),
    { path: RELEASE_MANIFEST_FILE, sha256: sha256(manifestBytes) },
  ].sort((left, right) => comparePaths(left.path, right.path));
  const checksumBytes = Buffer.from(
    checksumEntries.map((entry) => `${entry.sha256}  ${entry.path}\n`).join(""),
    "utf8",
  );
  const archiveFiles = [
    ...payload.map(({ path, data }) => ({ path, data })),
    { path: RELEASE_MANIFEST_FILE, data: manifestBytes },
    { path: RELEASE_CHECKSUM_FILE, data: checksumBytes },
  ].sort((left, right) => comparePaths(left.path, right.path));
  const tar = createUstar(archiveFiles);
  const compressed = gzipSync(tar, { level: 9, mtime: 0 });
  compressed.writeUInt32LE(0, 4);
  compressed[9] = 255;
  return compressed;
}

export function verifyReleaseBundleBytes(bytes, expected = {}) {
  assert(
    Buffer.isBuffer(bytes) && bytes.length > 18,
    "release bundle is empty",
  );
  assert(
    bytes.length <= MAX_COMPRESSED_BUNDLE_BYTES,
    "release bundle exceeds the compressed-size limit",
  );
  assert(
    bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 8,
    "release bundle is not gzip",
  );
  assert(bytes[3] === 0, "gzip flags must be zero");
  assert(bytes.readUInt32LE(4) === 0, "gzip mtime must be zero");
  assert(bytes[8] === 2, "gzip compression marker must be fixed for level 9");
  assert(bytes[9] === 255, "gzip OS byte must be deterministic 255");
  let tar;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: MAX_UNCOMPRESSED_TAR_BYTES });
  } catch (error) {
    throw new ReleaseBundleError(
      `release bundle gzip is invalid: ${error.message}`,
    );
  }
  const entries = parseUstar(tar);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const manifestEntry = byPath.get(RELEASE_MANIFEST_FILE);
  const checksumEntry = byPath.get(RELEASE_CHECKSUM_FILE);
  assert(
    manifestEntry !== undefined,
    `release bundle is missing ${RELEASE_MANIFEST_FILE}`,
  );
  assert(
    checksumEntry !== undefined,
    `release bundle is missing ${RELEASE_CHECKSUM_FILE}`,
  );
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  } catch (error) {
    throw new ReleaseBundleError(
      `release manifest is invalid JSON: ${error.message}`,
    );
  }
  validateReleaseManifest(manifest);
  if (expected.tag !== undefined)
    assert(manifest.tag === expected.tag, "release bundle tag mismatch");
  if (expected.tagObject !== undefined) {
    assert(
      manifest.tagObject === expected.tagObject,
      "release bundle annotated tag object mismatch",
    );
  }
  if (expected.commit !== undefined)
    assert(
      manifest.commit === expected.commit,
      "release bundle commit mismatch",
    );

  const payloadEntries = entries.filter(
    (entry) =>
      entry.path !== RELEASE_MANIFEST_FILE &&
      entry.path !== RELEASE_CHECKSUM_FILE,
  );
  assert(
    payloadEntries.length === manifest.files.length,
    "release bundle payload count does not match manifest",
  );
  for (let index = 0; index < manifest.files.length; index += 1) {
    const declared = manifest.files[index];
    const actual = payloadEntries[index];
    assert(
      actual.path === declared.path,
      `release payload ordering/path mismatch at ${declared.path}`,
    );
    assert(
      actual.data.length === declared.bytes,
      `release payload byte size mismatch for ${declared.path}`,
    );
    assert(
      sha256(actual.data) === declared.sha256,
      `release payload SHA-256 mismatch for ${declared.path}`,
    );
  }
  const source = byPath.get("manifests/source-manifest.json");
  const requirements = byPath.get("manifests/requirements-traceability.json");
  const releaseGates = byPath.get(RELEASE_GATES_PATH);
  const releaseGatesConfig = byPath.get(RELEASE_GATES_CONFIG_PATH);
  const sbom = byPath.get("manifests/sbom.spdx.json");
  assert(source !== undefined, "release bundle source manifest is missing");
  assert(
    requirements !== undefined,
    "release bundle requirements manifest is missing",
  );
  assert(
    releaseGates !== undefined,
    "release bundle gates evidence index is missing",
  );
  assert(
    releaseGatesConfig !== undefined,
    "release bundle gates config is missing",
  );
  assert(sbom !== undefined, "release bundle SPDX SBOM is missing");
  assert(byPath.has("README.md"), "release bundle README.md is missing");
  assert(byPath.has("LICENSE"), "release bundle LICENSE is missing");
  assert(
    byPath.has("manifests/licenses.json"),
    "release bundle license inventory is missing",
  );
  assert(
    byPath.has("manifests/third-party-notices.md"),
    "release bundle third-party notices are missing",
  );
  assert(
    sha256(source.data) === manifest.sourceManifestSha256,
    "source manifest provenance hash mismatch",
  );
  assert(
    sha256(requirements.data) === manifest.requirementsManifestSha256,
    "requirements manifest provenance hash mismatch",
  );
  assert(
    sha256(releaseGates.data) === manifest.releaseGatesSha256,
    "release gates provenance hash mismatch",
  );
  assert(
    sha256(sbom.data) === manifest.sbomSha256,
    "SBOM provenance hash mismatch",
  );
  validateReleaseGatesInPayload(
    releaseGates,
    releaseGatesConfig,
    manifest.sourceManifestSha256,
    byPath,
  );
  validateChecksums(checksumEntry.data.toString("utf8"), entries);

  if (expected.files !== undefined) {
    const wanted = normalizePayload(expected.files).map(
      ({ path, bytes: size, sha256: hash }) => ({
        path,
        bytes: size,
        sha256: hash,
      }),
    );
    assert(
      JSON.stringify(manifest.files) === JSON.stringify(wanted),
      "release bundle differs from checkout payload",
    );
  }
  return {
    manifest,
    entries: entries.length,
    payloadFiles: payloadEntries.length,
  };
}

export async function buildReleaseBundle({
  root,
  tag,
  output,
  requirementsSource,
  attestedGatesRoot,
}) {
  validateReleaseRuntime();
  const checkout = resolve(root ?? process.cwd());
  assert(
    typeof output === "string" && output.length > 0,
    "--output is required",
  );
  const git = await assertReleaseGitState(checkout, tag);
  const outputPath = await resolveReleaseOutputPath(checkout, output);
  await runReleasePreflights(checkout, requirementsSource, attestedGatesRoot);
  assertSameGitIdentity(git, await assertReleaseGitState(checkout, tag));
  const files = await collectReleasePayload(checkout, attestedGatesRoot);
  assertSameGitIdentity(git, await assertReleaseGitState(checkout, tag));
  const bytes = createReleaseBundleBytes({
    tag,
    tagObject: git.tagObject,
    commit: git.head,
    files,
  });
  verifyReleaseBundleBytes(bytes, {
    tag,
    tagObject: git.tagObject,
    commit: git.head,
    files,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  const handle = await open(outputPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  await chmod(outputPath, 0o644);
  return {
    output: outputPath,
    bytes: bytes.length,
    sha256: sha256(bytes),
    files: files.length,
    ...git,
  };
}

export async function checkReleaseBundle({
  root,
  tag,
  bundle,
  requirementsSource,
  attestedGatesRoot,
}) {
  validateReleaseRuntime();
  const checkout = resolve(root ?? process.cwd());
  assert(
    typeof bundle === "string" && bundle.length > 0,
    "--bundle is required",
  );
  const git = await assertReleaseGitState(checkout, tag);
  await runReleasePreflights(checkout, requirementsSource, attestedGatesRoot);
  assertSameGitIdentity(git, await assertReleaseGitState(checkout, tag));
  const files = await collectReleasePayload(checkout, attestedGatesRoot);
  assertSameGitIdentity(git, await assertReleaseGitState(checkout, tag));
  const bundlePath = resolve(bundle);
  const bundleMetadata = await lstatRequired(bundlePath, "release bundle");
  assert(
    !bundleMetadata.isSymbolicLink(),
    "release bundle input symlink is forbidden",
  );
  assert(
    bundleMetadata.isFile(),
    "release bundle input must be a regular file",
  );
  assert(
    bundleMetadata.size <= MAX_COMPRESSED_BUNDLE_BYTES,
    "release bundle exceeds the compressed-size limit",
  );
  const bytes = await readFileRequired(bundlePath, "release bundle");
  const result = verifyReleaseBundleBytes(bytes, {
    tag,
    tagObject: git.tagObject,
    commit: git.head,
    files,
  });
  const canonicalBytes = createReleaseBundleBytes({
    tag,
    tagObject: git.tagObject,
    commit: git.head,
    files,
  });
  assert(
    bytes.equals(canonicalBytes),
    "release bundle is not byte-identical to the canonical checkout build",
  );
  return { ...result, bytes: bytes.length, sha256: sha256(bytes), ...git };
}

export async function resolveReleaseOutputPath(root, output) {
  const actualRoot = await realpath(root);
  const requested = resolve(output);
  assertOutsideCheckout(actualRoot, requested);
  await mkdir(dirname(requested), { recursive: true });
  const actualParent = await realpath(dirname(requested));
  const actualOutput = resolve(actualParent, basename(requested));
  assertOutsideCheckout(actualRoot, actualOutput);
  await assertMissing(
    actualOutput,
    "release output already exists; refusing overwrite",
  );
  return actualOutput;
}

export function validateReleaseRuntime(version = process.versions.node) {
  assert(
    version === RELEASE_NODE_VERSION,
    `release tooling requires Node ${RELEASE_NODE_VERSION}, got ${version}`,
  );
}

export function validateBundlePath(path) {
  assert(
    typeof path === "string" && path.length > 0,
    "release bundle path is empty",
  );
  assert(
    !isAbsolute(path),
    `absolute release bundle path is forbidden: ${path}`,
  );
  assert(
    !path.includes("\\"),
    `backslash in release bundle path is forbidden: ${path}`,
  );
  assert(
    /^[\x20-\x7e]+$/.test(path),
    `non-printable or non-ASCII release bundle path is forbidden: ${path}`,
  );
  assert(
    !/[\u0000-\u001f\u007f]/.test(path),
    `control character in release bundle path is forbidden: ${path}`,
  );
  const components = path.split("/");
  assert(
    components.every(
      (component) =>
        component.length > 0 && component !== "." && component !== "..",
    ),
    `unsafe release bundle path: ${path}`,
  );
  assert(
    Buffer.byteLength(path, "utf8") <= 255,
    `release bundle path exceeds USTAR capacity: ${path}`,
  );
}

function normalizePayload(files) {
  assert(
    Array.isArray(files) && files.length > 0,
    "release payload must not be empty",
  );
  const normalized = files.map((file) => {
    assertPlainObject(file, "release payload file");
    validateBundlePath(file.path);
    assert(
      Buffer.isBuffer(file.data),
      `release payload data must be a Buffer: ${file.path}`,
    );
    return {
      path: file.path,
      data: file.data,
      bytes: file.data.length,
      sha256: sha256(file.data),
    };
  });
  normalized.sort((left, right) => comparePaths(left.path, right.path));
  assert(
    new Set(normalized.map((file) => file.path)).size === normalized.length,
    "duplicate release payload path",
  );
  return normalized;
}

function validateReleaseManifest(manifest) {
  assertPlainObject(manifest, "release manifest");
  assertExactKeys(manifest, RELEASE_MANIFEST_KEYS, "release manifest");
  assert(
    manifest.schemaVersion === 2,
    "unsupported release manifest schemaVersion",
  );
  assert(
    manifest.project === "cpredict-protocol",
    "unexpected release project",
  );
  assert(TAG_PATTERN.test(manifest.tag), "invalid release manifest tag");
  assert(
    OBJECT_ID_PATTERN.test(manifest.tagObject),
    "invalid release manifest tagObject",
  );
  assert(
    OBJECT_ID_PATTERN.test(manifest.commit),
    "invalid release manifest commit",
  );
  assert(
    manifest.sourceDateEpoch === 0,
    "release sourceDateEpoch must be zero",
  );
  assertExactKeys(manifest.archive, ARCHIVE_KEYS, "release archive metadata");
  assert(
    JSON.stringify(manifest.archive) === JSON.stringify(FIXED_ARCHIVE),
    "release archive metadata drift",
  );
  assert(
    /^[0-9a-f]{64}$/.test(manifest.sourceManifestSha256),
    "invalid sourceManifestSha256",
  );
  assert(
    /^[0-9a-f]{64}$/.test(manifest.requirementsManifestSha256),
    "invalid requirementsManifestSha256",
  );
  assert(
    /^[0-9a-f]{64}$/.test(manifest.releaseGatesSha256),
    "invalid releaseGatesSha256",
  );
  assert(/^[0-9a-f]{64}$/.test(manifest.sbomSha256), "invalid sbomSha256");
  assert(
    Array.isArray(manifest.files) && manifest.files.length > 0,
    "release manifest files are empty",
  );
  let previous;
  const seen = new Set();
  for (const file of manifest.files) {
    assertPlainObject(file, "release manifest file");
    assertExactKeys(
      file,
      FILE_KEYS,
      `release manifest file ${file.path ?? "<unknown>"}`,
    );
    validateBundlePath(file.path);
    assert(
      Number.isSafeInteger(file.bytes) && file.bytes >= 0,
      `invalid byte size for ${file.path}`,
    );
    assert(
      /^[0-9a-f]{64}$/.test(file.sha256),
      `invalid SHA-256 for ${file.path}`,
    );
    assert(
      !seen.has(file.path),
      `duplicate release manifest path ${file.path}`,
    );
    if (previous !== undefined)
      assert(
        comparePaths(previous, file.path) < 0,
        "release manifest paths are not sorted",
      );
    seen.add(file.path);
    previous = file.path;
  }
}

function validateReleaseGatesInPayload(
  gatesFile,
  configFile,
  sourceManifestSha256,
  byPath,
) {
  let document;
  let config;
  try {
    document = JSON.parse(gatesFile.data.toString("utf8"));
    config = JSON.parse(configFile.data.toString("utf8"));
  } catch (error) {
    throw new ReleaseBundleError(
      `release gates JSON is invalid: ${error.message}`,
    );
  }
  try {
    validateReleaseGatesDocument(document, config, {
      sourceManifestSha256,
      readEvidence: (path) => {
        const file = byPath.get(path);
        if (file === undefined) throw new Error("not present");
        return file.data;
      },
    });
  } catch (error) {
    throw new ReleaseBundleError(
      `release gates validation failed: ${error.message}`,
    );
  }
}

function validateChecksums(text, entries) {
  const expected = entries
    .filter((entry) => entry.path !== RELEASE_CHECKSUM_FILE)
    .map((entry) => ({ path: entry.path, sha256: sha256(entry.data) }))
    .sort((left, right) => comparePaths(left.path, right.path));
  const lines = text.split("\n");
  assert(lines.pop() === "", "SHA256SUMS must end with one newline");
  const actual = lines.map((line) => {
    const match = line.match(/^([0-9a-f]{64})  ([^\r\n]+)$/);
    assert(match, "invalid SHA256SUMS row");
    validateBundlePath(match[2]);
    return { path: match[2], sha256: match[1] };
  });
  actual.sort((left, right) => comparePaths(left.path, right.path));
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    "SHA256SUMS does not match release entries",
  );
}

function createUstar(files) {
  const chunks = [];
  for (const file of files) {
    validateBundlePath(file.path);
    const header = createTarHeader(file.path, file.data.length);
    chunks.push(header, file.data);
    const remainder = file.data.length % 512;
    if (remainder !== 0) chunks.push(Buffer.alloc(512 - remainder));
  }
  chunks.push(ZERO_BLOCK, ZERO_BLOCK);
  return Buffer.concat(chunks);
}

function createTarHeader(path, size) {
  const { name, prefix } = splitUstarPath(path);
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 265, 32, "root");
  writeString(header, 297, 32, "root");
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  writeString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encoded = `${checksum.toString(8).padStart(6, "0")}\0 `;
  writeString(header, 148, 8, encoded);
  return header;
}

function parseUstar(tar) {
  assert(
    tar.length >= 1024 && tar.length % 512 === 0,
    "invalid USTAR byte length",
  );
  const entries = [];
  let offset = 0;
  let zeroBlocks = 0;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.equals(ZERO_BLOCK)) {
      zeroBlocks += 1;
      offset += 512;
      if (zeroBlocks === 2) break;
      continue;
    }
    assert(zeroBlocks === 0, "non-zero USTAR entry after zero terminator");
    validateTarHeaderChecksum(header);
    assert(readString(header, 257, 6) === "ustar", "USTAR magic is missing");
    assert(readString(header, 263, 2) === "00", "USTAR version is invalid");
    const type = header[156];
    assert(
      type === 0 || type === 48,
      "release archive contains non-regular entry or symlink",
    );
    assert(
      readOctal(header, 100, 8) === 0o644,
      "release archive mode is not fixed 0644",
    );
    assert(readOctal(header, 108, 8) === 0, "release archive uid is not zero");
    assert(readOctal(header, 116, 8) === 0, "release archive gid is not zero");
    assert(
      readOctal(header, 136, 12) === 0,
      "release archive mtime is not zero",
    );
    assert(
      readString(header, 265, 32) === "root",
      "release archive uname is not root",
    );
    assert(
      readString(header, 297, 32) === "root",
      "release archive gname is not root",
    );
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    validateBundlePath(path);
    const size = readOctal(header, 124, 12);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    assert(dataEnd <= tar.length, `truncated release archive entry ${path}`);
    entries.push({ path, data: Buffer.from(tar.subarray(dataStart, dataEnd)) });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  assert(
    zeroBlocks === 2,
    "release archive is missing two zero terminator blocks",
  );
  assert(
    tar.subarray(offset).every((byte) => byte === 0),
    "non-zero data after USTAR terminator",
  );
  assert(entries.length > 2, "release archive payload is empty");
  assert(
    new Set(entries.map((entry) => entry.path)).size === entries.length,
    "duplicate release archive path",
  );
  const sorted = [...entries].sort((left, right) =>
    comparePaths(left.path, right.path),
  );
  assert(
    entries.every((entry, index) => entry.path === sorted[index].path),
    "release archive paths are not deterministically sorted",
  );
  return entries;
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path, "utf8") <= 100) return { name: path, prefix: "" };
  for (
    let index = path.lastIndexOf("/");
    index > 0;
    index = path.lastIndexOf("/", index - 1)
  ) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (
      Buffer.byteLength(prefix, "utf8") <= 155 &&
      Buffer.byteLength(name, "utf8") <= 100
    ) {
      return { name, prefix };
    }
  }
  throw new ReleaseBundleError(`path cannot be represented in USTAR: ${path}`);
}

function validateTarHeaderChecksum(header) {
  const declared = readOctal(header, 148, 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  assert(actual === declared, "USTAR header checksum mismatch");
}

function writeString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  assert(bytes.length <= length, `USTAR field is too long: ${value}`);
  bytes.copy(buffer, offset);
}

function readString(buffer, offset, length) {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field
    .subarray(0, end === -1 ? field.length : end)
    .toString("utf8")
    .trimEnd();
}

function writeOctal(buffer, offset, length, value) {
  assert(
    Number.isSafeInteger(value) && value >= 0,
    "invalid USTAR numeric field",
  );
  const encoded = `${value.toString(8).padStart(length - 1, "0")}\0`;
  assert(encoded.length === length, "USTAR numeric field overflow");
  writeString(buffer, offset, length, encoded);
}

function readOctal(buffer, offset, length) {
  const value = buffer
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/[\0 ]+$/g, "");
  assert(/^[0-7]+$/.test(value), "invalid USTAR octal field");
  const parsed = Number.parseInt(value, 8);
  assert(Number.isSafeInteger(parsed), "USTAR octal field overflow");
  return parsed;
}

function gitTrackedPaths(root) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  assertCommand(result, "git ls-files");
  const paths = result.stdout.toString("utf8").split("\0").filter(Boolean);
  assert(paths.length > 0, "Git tracked-file inventory is empty");
  for (const path of paths) validateBundlePath(path);
  return new Set(paths);
}

function runText(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  assertCommand(result, `${command} ${args.join(" ")}`);
  return result.stdout.trim();
}

function assertCommand(result, label) {
  if (result.error !== undefined)
    throw new ReleaseBundleError(
      `${label} could not start: ${result.error.message}`,
    );
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "")
      .trim()
      .slice(0, 4_000);
    throw new ReleaseBundleError(
      `${label} failed with exit ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }
}

function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sortPaths(paths) {
  return paths.sort(comparePaths);
}

function assertSameGitIdentity(expected, actual) {
  assert(
    actual.head === expected.head,
    "release HEAD changed during bundle operation",
  );
  assert(
    actual.tag === expected.tag,
    "release tag changed during bundle operation",
  );
  assert(
    actual.tagObject === expected.tagObject,
    "release tag object changed during bundle operation",
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function assertMissing(path, message) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new ReleaseBundleError(message);
}

function assertOutsideCheckout(root, output) {
  const child = relative(resolve(root), output);
  assert(
    child.startsWith(`..${sep}`) || child === ".." || isAbsolute(child),
    "release output must be outside checkout",
  );
}

function assertWithin(root, child, message) {
  const path = relative(root, child);
  assert(path === "" || (!path.startsWith("..") && !isAbsolute(path)), message);
}

async function readFileRequired(path, label) {
  try {
    return await readFile(path);
  } catch (error) {
    throw new ReleaseBundleError(`cannot read ${label}: ${error.message}`);
  }
}

async function lstatRequired(path, label) {
  try {
    return await lstat(path);
  } catch (error) {
    throw new ReleaseBundleError(`cannot inspect ${label}: ${error.message}`);
  }
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(wanted),
    `${label} has unknown or missing keys`,
  );
}

function assertPlainObject(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function assert(condition, message) {
  if (!condition) throw new ReleaseBundleError(message);
}
