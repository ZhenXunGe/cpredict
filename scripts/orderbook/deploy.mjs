#!/usr/bin/env node
// Preserve the existing deployer's preflight, secret redaction and broadcast guards.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const child = spawn(
  process.execPath,
  [
    fileURLToPath(
      new URL("../deployment/deploy-arbitrum-sepolia.mjs", import.meta.url),
    ),
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
    env: { ...process.env, CPREDICT_DEPLOYMENT_VARIANT: "orderbook-v2" },
  },
);
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
child.once("error", () => {
  console.error("orderbook_deployer_start_failed");
  process.exitCode = 1;
});
