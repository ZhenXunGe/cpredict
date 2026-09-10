#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadStackConfiguration } from "./config.mjs";
import { redactStackLogs } from "./redact.mjs";
import { readSourceRevision } from "./source-revision.mjs";
import { loadPublicSiteStack } from "./public-site-config.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const command = process.argv[2] ?? "help";
const sponsorship = process.argv.includes("--sponsorship");
const relay = process.argv.includes("--relay");
const publicSite = process.argv.includes("--public-site");
const usdc = process.argv.includes("--usdc");
if (usdc && !publicSite) throw new Error("--usdc requires --public-site");
const allowed = new Set(["up", "status", "logs", "down", "config"]);

if (command === "help" || !allowed.has(command)) {
  process.stdout.write(
    "usage: node scripts/stack/stack.mjs up|status|logs|down|config [--sponsorship] [--relay] [--public-site [--usdc]]\n",
  );
  process.exitCode = command === "help" ? 0 : 2;
} else {
  const configuration = await loadStackConfiguration({ sponsorship, relay });
  if (publicSite) {
    const extra = await loadPublicSiteStack(configuration, { usdc });
    Object.assign(configuration.environment, extra.environment);
    Object.assign(configuration.secret, extra.secretsForRedaction);
    const version = spawnSync("docker", ["compose", "version", "--short"], {
      encoding: "utf8",
    });
    if (version.error) throw version.error;
    const match = /^v?(\d+)\.(\d+)\./.exec(version.stdout.trim());
    if (
      version.status !== 0 ||
      !match ||
      Number(match[1]) < 2 ||
      (Number(match[1]) === 2 && Number(match[2]) < 30)
    )
      throw new Error(
        "Public-site stack requires Docker Compose >= 2.30 for literal provider env values",
      );
  }
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
  if (publicSite) compose.push("-f", resolve(ROOT, "compose.public-site.yaml"));
  if (publicSite && configuration.environment.CPREDICT_STACK_LEGACY_DEMO_DIR)
    compose.push("-f", resolve(ROOT, "compose.public-site.legacy.yaml"));
  if (usdc) compose.push("-f", resolve(ROOT, "compose.usdc.yaml"));
  if (sponsorship) compose.push("--profile", "sponsorship");
  if (relay) compose.push("--profile", "relay");
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
    process.stdout.write(
      redactStackLogs(result.stdout ?? "", configuration.secret),
    );
    process.stderr.write(
      redactStackLogs(result.stderr ?? "", configuration.secret),
    );
  }
  process.exitCode = result.status ?? 1;
}
