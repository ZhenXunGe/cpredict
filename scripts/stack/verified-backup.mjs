#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStackBackup } from "./backup.mjs";
import { runRestoreDrill } from "./restore-drill.mjs";

export async function createVerifiedBackup({
  backup = createStackBackup,
  restore = runRestoreDrill,
  usdc = false,
} = {}) {
  const created = await backup({ usdc });
  const report = await restore({ backupDirectory: created.directory });
  if (report.status !== "PASS")
    throw new Error("backup restore drill did not pass");
  return { directory: created.directory, report };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  createVerifiedBackup({ usdc: process.argv.includes("--usdc") })
    .then(({ directory }) =>
      process.stdout.write(`VERIFIED BACKUP ${directory}\n`),
    )
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
