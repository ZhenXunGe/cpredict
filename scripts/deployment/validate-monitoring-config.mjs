#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const REQUIRED_ALERTS = Object.freeze({
  CpredictIndexerLagHigh: "page",
  CpredictLiabilityCoverageLow: "critical",
  CpredictUnexpectedTerminalTransition: "critical",
  CpredictSponsorDenialSpike: "warning",
  CpredictRpcDivergence: "page",
  CpredictRuntimeCodehashDrift: "critical",
  CpredictTimelockRoleDrift: "critical",
  CpredictExitPathSyntheticFailed: "page",
  CpredictPaymasterDepositLow: "warning",
  CpredictIndexerBackupStale: "warning",
});

export function validateMonitoringConfig(source) {
  if (typeof source !== "string" || source.length === 0)
    throw new Error("monitoring config is empty");
  const seen = new Set();
  for (const [alert, severity] of Object.entries(REQUIRED_ALERTS)) {
    const start = source.indexOf(`- alert: ${alert}`);
    if (start < 0) throw new Error(`missing required alert ${alert}`);
    const next = source.indexOf("- alert:", start + 1);
    const block = source.slice(start, next < 0 ? undefined : next);
    if (!new RegExp(`severity:\\s*${severity}(?:\\s|})`).test(block))
      throw new Error(`${alert}: severity must be ${severity}`);
    if (!/expr:\s*[^\n]+/.test(block) || !/summary:\s*"[^"]+"/.test(block))
      throw new Error(`${alert}: expression and summary are required`);
    seen.add(alert);
  }
  const declared = [...source.matchAll(/- alert:\s*([A-Za-z0-9]+)/g)].map(
    (match) => match[1],
  );
  if (new Set(declared).size !== declared.length)
    throw new Error("duplicate alert names are forbidden");
  return { alerts: [...seen].sort() };
}

async function main() {
  const path = process.argv[2] ?? "monitoring/prometheus/cpredict-alerts.yml";
  const result = validateMonitoringConfig(await readFile(path, "utf8"));
  process.stdout.write(
    `PASS monitoring config ${result.alerts.length} required alerts\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main().catch((error) => {
    process.stderr.write(`FAIL ${error.message}\n`);
    process.exitCode = 1;
  });
