import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const recursiveInventory = [
  ["src", [".sol"]],
  ["test", [".sol"]],
  ["script", [".sol"]],
  ["offchain", [".ts", ".tsx", ".sql", ".md", ".json"]],
  [
    "examples",
    [".ts", ".tsx", ".js", ".md", ".conf", ".css", ".html", ".json"],
  ],
  ["scripts", [".py", ".sh", ".mjs", ".yaml"]],
  ["load", [".js", ".json", ".mjs", ".sh", ".md"]],
  ["monitoring", [".yml", ".yaml", ".json", ".md"]],
  ["deploy", [".sh", ".mjs", ".conf", ".json", ".md", ".template", ".timer"]],
  ["deployments", [".md", ".json", ".example"]],
  [".github/workflows", [".yml", ".yaml"]],
];

const explicitInventory = [
  "README.md",
  "LICENSE",
  ".gitignore",
  ".dockerignore",
  ".github/dependabot.yml",
  ".env.example",
  ".env.compose.example",
  "compose.yaml",
  "deploy/compose/Dockerfile.offchain",
  "deploy/compose/Dockerfile.demo",
  "foundry.toml",
  "remappings.txt",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vitest.config.ts",
  "scripts/security/medusa.json",
  "manifests/dependencies.lock",
  "manifests/binary-evidence.lock",
  "manifests/halmos-wheels.lock",
  "manifests/load-tools.lock",
  "manifests/postgresql-tools.lock",
  "manifests/history-secret-scan.lock",
  "manifests/requirements.lock",
  "manifests/security-tools.lock",
  "manifests/solidity-skills.lock",
  "manifests/release-bundle.schema.json",
  "manifests/release-gates.schema.json",
  "manifests/release-gate-result.schema.json",
  "manifests/release-gates.config.json",
  "manifests/release-ci-attestation.config.json",
  "manifests/release-ci-attestation.schema.json",
  "manifests/economics-commercial-input.schema.json",
  "manifests/economics-commercial-policy.schema.json",
  "manifests/economics-commercial-result.schema.json",
  "manifests/runtime-package.schema.json",
  "manifests/source-verification.schema.json",
  "manifests/canary-state.schema.json",
  "manifests/backup-manifest.schema.json",
  "manifests/local-ops-drill.schema.json",
  "manifests/container-images.lock.json",
  "manifests/sbom.spdx.json",
  "manifests/licenses.json",
  "manifests/third-party-notices.md",
  "docs/zh/00-delivery-status.md",
  "docs/zh/13-compose-runtime-operations.md",
  "docs/zh/14-single-host-deployment-runbook.md",
  "docs/zh/15-reverse-tunnel-deployment-runbook.md",
];

const excludedInventoryPaths = new Set([
  "deployments/arbitrum-sepolia/pending.json",
]);
const excludedInventoryPrefixes = ["deployments/arbitrum-sepolia/runtime/"];

/**
 * Return the canonical, sorted source-manifest inventory as repository-relative
 * paths. A path that is selected by more than one rule is a configuration error:
 * silently de-duplicating it could hide an accidental recursive/manual overlap.
 */
export async function sourceManifestPaths(root) {
  const selected = new Map();

  for (const [directory, extensions] of recursiveInventory) {
    const absoluteDirectory = join(root, directory);
    for (const absolutePath of await collect(
      absoluteDirectory,
      new Set(extensions),
    )) {
      const path = relative(root, absolutePath);
      if (isExcluded(path)) continue;
      add(selected, path, `recursive:${directory}`);
    }
  }

  for (const path of explicitInventory) {
    add(selected, path, "explicit");
  }

  return [...selected.keys()].sort();
}

function isExcluded(path) {
  return (
    excludedInventoryPaths.has(path) ||
    excludedInventoryPrefixes.some((prefix) => path.startsWith(prefix))
  );
}

function add(selected, path, source) {
  const previous = selected.get(path);
  if (previous !== undefined) {
    throw new Error(
      `duplicate source-manifest path ${path} from ${previous} and ${source}`,
    );
  }
  selected.set(path, source);
}

async function collect(directory, extensions) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await collect(path, extensions)));
    else if (entry.isFile() && extensions.has(extname(entry.name)))
      output.push(path);
  }
  return output;
}
