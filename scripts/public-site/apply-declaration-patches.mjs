import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const defaultRoot = fileURLToPath(new URL("../../", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
function requireMatch(condition, message) {
  if (!condition) throw new Error(`SDK declaration patch rejected: ${message}`);
}
function safePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((part) => !part || part === "." || part === "..")
  );
}
export function runtimeDigest(directory) {
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(directory, join(entry.parentPath, entry.name))
        .split(sep)
        .join("/"),
    )
    .filter(
      (path) =>
        !path.split("/").includes("node_modules") &&
        /\.(?:[cm]?js|wasm|node)$/.test(path),
    )
    .sort();
  requireMatch(files.length > 0, "package has no runtime files");
  return hash(
    files
      .map((path) => `${path}\0${hash(readFileSync(join(directory, path)))}\n`)
      .join(""),
  );
}

/** Check exact releases and bytes before patch-package is allowed to write anything. */
export function verifyDeclarationPatches(
  root = defaultRoot,
  { applied = false } = {},
) {
  const manifest = readJson(
    join(root, "manifests/sdk-declaration-patches.json"),
  );
  const lock = readJson(join(root, "package-lock.json"));
  requireMatch(
    manifest.schemaVersion === 1 &&
      Array.isArray(manifest.packages) &&
      manifest.packages.length > 0,
    "invalid manifest",
  );
  const expectedPatches = new Set();
  for (const entry of manifest.packages) {
    requireMatch(
      safePath(entry.path) && entry.path.startsWith("node_modules/"),
      "invalid package path",
    );
    requireMatch(
      safePath(entry.patch) &&
        dirname(entry.patch) === "patches" &&
        entry.patch.endsWith(".patch"),
      "invalid patch path",
    );
    requireMatch(!expectedPatches.has(entry.patch), "duplicate patch");
    expectedPatches.add(entry.patch);
    const directory = join(root, entry.path);
    const pkg = readJson(join(directory, "package.json"));
    const locked = lock.packages[entry.path];
    requireMatch(
      pkg.name === entry.name &&
        pkg.version === entry.version &&
        locked?.version === entry.version &&
        locked.integrity === entry.integrity &&
        locked.resolved === entry.source,
      `version/integrity mismatch: ${entry.name}`,
    );
    requireMatch(
      runtimeDigest(directory) === entry.runtimeSha256,
      `runtime bytes changed: ${entry.name}`,
    );
    requireMatch(
      Array.isArray(entry.files) && entry.files.length > 0,
      "missing declaration inventory",
    );
    const allowed = new Set();
    for (const file of entry.files) {
      requireMatch(
        safePath(file.path) && /\.d\.(?:ts|mts|cts)$/.test(file.path),
        "non-declaration file",
      );
      const digest = hash(readFileSync(join(directory, file.path)));
      requireMatch(
        digest === file.patchedSha256 ||
          (!applied && digest === file.originalSha256),
        `declaration bytes changed: ${entry.name}/${file.path}`,
      );
      allowed.add(`${entry.path}/${file.path}`);
    }
    for (const source of entry.sources) {
      requireMatch(safePath(source.path), "invalid evidence path");
      requireMatch(
        hash(readFileSync(join(directory, source.path))) === source.sha256,
        `source evidence changed: ${entry.name}/${source.path}`,
      );
    }
    const patch = readFileSync(join(root, entry.patch), "utf8");
    requireMatch(
      hash(patch) === entry.patchSha256,
      `patch hash mismatch: ${entry.patch}`,
    );
    const headers = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)];
    requireMatch(headers.length === allowed.size, "incomplete patch inventory");
    for (const [, before, after] of headers)
      requireMatch(
        before === after && allowed.delete(before),
        "patch writes outside its declaration inventory",
      );
    requireMatch(
      !patch
        .split("\n")
        .some(
          (line) =>
            line.startsWith("+") &&
            !line.startsWith("+++") &&
            /\bany\b|@ts-(?:ignore|nocheck)/.test(line),
        ),
      "patch weakens type checking",
    );
  }
  const actual = readdirSync(join(root, "patches"))
    .filter((name) => name.endsWith(".patch"))
    .map((name) => `patches/${name}`);
  requireMatch(
    actual.length === expectedPatches.size &&
      actual.every((name) => expectedPatches.has(name)),
    "unregistered patch",
  );
  return manifest;
}

export function applyDeclarationPatches(root = defaultRoot) {
  const manifest = verifyDeclarationPatches(root);
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/patch-package/index.js"),
      "--error-on-fail",
      "--error-on-warn",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  requireMatch(result.status === 0, "patch-package failed");
  verifyDeclarationPatches(root, { applied: true });
  return manifest.packages.length;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const count = process.argv.includes("--check")
    ? verifyDeclarationPatches().packages.length
    : applyDeclarationPatches();
  process.stdout.write(
    `Verified declaration patches and unchanged runtime bytes for ${count} pinned packages.\n`,
  );
}
