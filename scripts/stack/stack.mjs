#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadStackConfiguration } from "./config.mjs";
import { redactStackLogs } from "./redact.mjs";
import { readSourceRevision } from "./source-revision.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const command = process.argv[2] ?? "help";
const sponsorship = process.argv.includes("--sponsorship");
const allowed = new Set(["up", "status", "logs", "down", "config"]);

if (command === "help" || !allowed.has(command)) {
  process.stdout.write(
    "usage: node scripts/stack/stack.mjs up|status|logs|down|config [--sponsorship]\n",
  );
  process.exitCode = command === "help" ? 0 : 2;
} else {
  const configuration = await loadStackConfiguration({ sponsorship });
  const sourceRevision = readSourceRevision({ root: ROOT });
  const compose = [
    "compose",
    "--project-directory",
    ROOT,
    "--env-file",
    configuration.secretPath,
    "--env-file",
    configuration.publicPath,
    "-f",
    resolve(ROOT, "compose.yaml"),
  ];
  if (sponsorship) compose.push("--profile", "sponsorship");
  const args =
    command === "up"
      ? [...compose, "up", "--build", "--detach", "--wait"]
      : command === "status"
        ? [...compose, "ps"]
        : command === "logs"
          ? [...compose, "logs", "--no-color", "--tail", "200"]
          : command === "down"
            ? [...compose, "down", "--remove-orphans"]
            : [...compose, "config", "--quiet"];
  const captureLogs = command === "logs";
  const result = spawnSync("docker", args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ...configuration.environment,
      CPREDICT_IMAGE_REVISION: sourceRevision,
    },
    ...(captureLogs ? { encoding: "utf8" } : { stdio: "inherit" }),
  });
  if (result.error !== undefined) throw result.error;
  if (captureLogs) {
    process.stdout.write(redactStackLogs(result.stdout ?? "", configuration.secret));
    process.stderr.write(redactStackLogs(result.stderr ?? "", configuration.secret));
  }
  process.exitCode = result.status ?? 1;
}
