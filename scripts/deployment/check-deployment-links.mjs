#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DOCUMENTS = [
  "README.md",
  "deployments/arbitrum-sepolia/README.md",
  "docs/zh/08-deployment-operations-incident.md",
  "docs/zh/13-compose-runtime-operations.md",
  "monitoring/README.md",
  "reports/deployment/arbitrum-sepolia-readiness.md",
  "reports/deployment/deployment-operations-tooling-2026-08-21.md",
];
const REQUIRED_TARGETS = [
  "script/DeployArbitrumSepolia.s.sol",
  "script/FinalizeBootstrap.s.sol",
  "scripts/deployment/deploy-arbitrum-sepolia.sh",
  "scripts/deployment/deploy-arbitrum-sepolia.mjs",
  "deployments/arbitrum-sepolia/deploy.env.example",
  "deployments/arbitrum-sepolia/final-manifest.schema.json",
  "deployments/arbitrum-sepolia/templates/final-manifest.template.json",
  "deployments/arbitrum-sepolia/templates/canary-evidence.template.json",
  "deployments/arbitrum-sepolia/templates/ops-drill-evidence.template.json",
  "scripts/deployment/validate-final-manifest.mjs",
  "scripts/deployment/verify-live-rpc.mjs",
  "scripts/deployment/validate-canary-evidence.mjs",
  "scripts/deployment/validate-ops-evidence.mjs",
  "scripts/deployment/validate-monitoring-config.mjs",
  "scripts/deployment/sync-runtime.mjs",
  "scripts/deployment/verify-source.mjs",
  "scripts/deployment/canary-runner.mjs",
  "scripts/stack/stack.mjs",
  "scripts/stack/backup.mjs",
  "scripts/stack/restore-drill.mjs",
  "scripts/stack/ops-drill.mjs",
  "compose.yaml",
  ".env.compose.example",
  "manifests/runtime-package.schema.json",
  "manifests/source-verification.schema.json",
  "manifests/canary-state.schema.json",
  "manifests/backup-manifest.schema.json",
  "manifests/local-ops-drill.schema.json",
  "monitoring/prometheus/cpredict-alerts.yml",
];

export async function checkDeploymentLinks() {
  const text = (
    await Promise.all(DOCUMENTS.map((path) => readFile(path, "utf8")))
  ).join("\n");
  for (const target of REQUIRED_TARGETS) {
    await access(target);
    if (!text.includes(target.split("/").at(-1)) && !text.includes(target))
      throw new Error(
        `${target}: exists but is not referenced by deployment documentation`,
      );
  }
  for (const document of DOCUMENTS) {
    const source = await readFile(document, "utf8");
    for (const match of source.matchAll(
      /\[[^\]]+\]\((?!https?:|#)([^)]+)\)/g,
    )) {
      const target = new URL(match[1], pathToFileURL(document)).pathname;
      await access(target);
    }
  }
  return { documents: DOCUMENTS.length, targets: REQUIRED_TARGETS.length };
}

async function main() {
  const result = await checkDeploymentLinks();
  process.stdout.write(
    `PASS deployment documentation links ${result.documents} documents ${result.targets} targets\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    process.stderr.write(`FAIL ${error.message}\n`);
    process.exitCode = 1;
  });
