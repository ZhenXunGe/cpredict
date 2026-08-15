#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DOCUMENTS = [
  "deployments/base-sepolia/README.md",
  "docs/zh/08-deployment-operations-incident.md",
  "monitoring/README.md",
  "reports/deployment/base-sepolia-readiness.md",
];
const REQUIRED_TARGETS = [
  "script/DeployBaseSepolia.s.sol",
  "script/FinalizeBootstrap.s.sol",
  "deployments/base-sepolia/final-manifest.schema.json",
  "deployments/base-sepolia/templates/final-manifest.template.json",
  "deployments/base-sepolia/templates/canary-evidence.template.json",
  "deployments/base-sepolia/templates/ops-drill-evidence.template.json",
  "scripts/deployment/validate-final-manifest.mjs",
  "scripts/deployment/verify-live-rpc.mjs",
  "scripts/deployment/validate-canary-evidence.mjs",
  "scripts/deployment/validate-ops-evidence.mjs",
  "scripts/deployment/validate-monitoring-config.mjs",
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
