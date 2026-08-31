#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { arch, platform, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStackConfiguration } from "./config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GIB = 1024 ** 3;

export function parsePreflightArgs(argv) {
  const output = { phase: "host", network: false, sponsorship: false };
  let explicitPhase = false;
  for (const value of argv) {
    if (["host", "runtime"].includes(value)) {
      if (explicitPhase)
        throw new Error("only one preflight phase may be selected");
      output.phase = value;
      explicitPhase = true;
    } else if (value === "--network") output.network = true;
    else if (value === "--sponsorship") output.sponsorship = true;
    else throw new Error(`unknown option ${value}`);
  }
  if (output.network && output.phase !== "runtime")
    throw new Error("--network requires the runtime phase");
  return output;
}

export function parseMeminfo(text) {
  const value = /^SwapTotal:\s+([0-9]+)\s+kB$/m.exec(text)?.[1];
  return value === undefined ? 0 : Number(value) * 1024;
}

export function evaluateHostFacts(facts) {
  const checks = [];
  const add = (status, name, detail) => checks.push({ status, name, detail });
  add(
    facts.platform === "linux" ? "PASS" : "FAIL",
    "operating system",
    facts.platform,
  );
  add(facts.arch === "x64" ? "PASS" : "FAIL", "architecture", facts.arch);
  add(
    facts.nodeVersion === "v22.22.2" ? "PASS" : "FAIL",
    "Node.js",
    `${facts.nodeVersion}; required v22.22.2`,
  );
  add(
    facts.uid !== 0 ? "PASS" : "FAIL",
    "unprivileged operator",
    facts.uid === 0 ? "running as root" : `uid ${facts.uid}`,
  );
  add(
    facts.totalMemoryBytes >= 3.5 * GIB ? "PASS" : "FAIL",
    "memory",
    formatGiB(facts.totalMemoryBytes),
  );
  add(
    facts.freeDiskBytes >= 20 * GIB
      ? facts.freeDiskBytes >= 50 * GIB
        ? "PASS"
        : "WARN"
      : "FAIL",
    "free disk",
    `${formatGiB(facts.freeDiskBytes)} free; 50 GiB recommended`,
  );
  add(
    facts.swapBytes >= GIB ? "PASS" : "WARN",
    "swap",
    `${formatGiB(facts.swapBytes)} configured; at least 1 GiB recommended`,
  );
  for (const [name, value] of [
    ["Docker CLI", facts.dockerCli],
    ["Docker daemon", facts.dockerDaemon],
    ["Docker Compose", facts.compose],
    ["Compose --wait", facts.composeWait],
    ["Docker Buildx", facts.buildx],
    ["Compose static config", facts.composeConfig],
    ["NTP synchronization", facts.timeSync],
    ["clean Git worktree", facts.gitClean],
    ["Docker context policy", facts.dockerignore],
  ])
    add(value.ok ? "PASS" : "FAIL", name, value.detail);
  return checks;
}

export async function collectHostFacts({ root = ROOT, run = runCommand } = {}) {
  const disk = await statfs(root);
  const memoryInfo = await readFile("/proc/meminfo", "utf8").catch(() => "");
  const dockerignore = await readFile(
    resolve(root, ".dockerignore"),
    "utf8",
  ).catch(() => "");
  const requiredIgnore = [
    ".git",
    ".env.*",
    ".tools",
    "node_modules",
    "runtime",
  ];
  const docker = run("docker", ["--version"], root);
  const daemon = run(
    "docker",
    ["info", "--format", "{{.ServerVersion}}"],
    root,
  );
  const compose = run("docker", ["compose", "version", "--short"], root);
  const composeHelp = run("docker", ["compose", "up", "--help"], root);
  const buildx = run("docker", ["buildx", "version"], root);
  const composeConfig = run(
    "docker",
    [
      "compose",
      "-f",
      resolve(root, "compose.yaml"),
      "config",
      "--no-interpolate",
      "--quiet",
    ],
    root,
  );
  const timeSync = run(
    "timedatectl",
    ["show", "--property=NTPSynchronized", "--value"],
    root,
  );
  const git = run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    root,
  );
  return {
    platform: platform(),
    arch: arch(),
    nodeVersion: process.version,
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    totalMemoryBytes: totalmem(),
    freeDiskBytes: Number(disk.bavail) * Number(disk.bsize),
    swapBytes: parseMeminfo(memoryInfo),
    dockerCli: commandFact(docker),
    dockerDaemon: commandFact(daemon),
    compose: commandFact(compose),
    composeWait: {
      ok: composeHelp.code === 0 && /--wait\b/.test(composeHelp.stdout),
      detail:
        composeHelp.code === 0
          ? "docker compose up supports --wait"
          : safeError(composeHelp),
    },
    buildx: commandFact(buildx),
    composeConfig: commandFact(composeConfig),
    timeSync: {
      ok: timeSync.code === 0 && timeSync.stdout.trim() === "yes",
      detail:
        timeSync.code === 0
          ? `NTPSynchronized=${timeSync.stdout.trim()}`
          : safeError(timeSync),
    },
    gitClean: {
      ok: git.code === 0 && git.stdout.trim().length === 0,
      detail:
        git.code === 0
          ? git.stdout.trim().length === 0
            ? "clean"
            : "tracked or untracked changes present"
          : safeError(git),
    },
    dockerignore: {
      ok: requiredIgnore.every((entry) =>
        dockerignore.split(/\r?\n/).includes(entry),
      ),
      detail:
        dockerignore.length === 0
          ? "missing .dockerignore"
          : "required exclusions present",
    },
  };
}

export async function runtimeChecks({
  network = false,
  sponsorship = false,
  root = ROOT,
  run = runCommand,
} = {}) {
  const checks = [];
  let configuration;
  try {
    configuration = await loadStackConfiguration({ sponsorship });
    checks.push({
      status: "PASS",
      name: "runtime configuration",
      detail: "secret/public inputs validated",
    });
  } catch (error) {
    return [
      { status: "FAIL", name: "runtime configuration", detail: error.message },
    ];
  }
  const base = [
    "compose",
    "--project-directory",
    root,
    "--env-file",
    configuration.secretPath,
    "--env-file",
    configuration.publicPath,
    "-f",
    resolve(root, "compose.yaml"),
  ];
  if (sponsorship) base.push("--profile", "sponsorship");
  const rendered = run(
    "docker",
    [...base, "config", "--quiet"],
    root,
    configuration.environment,
  );
  checks.push({
    status: rendered.code === 0 ? "PASS" : "FAIL",
    name: "rendered Compose config",
    detail:
      rendered.code === 0
        ? "valid"
        : "docker compose config failed without rendering secrets",
  });
  if (network) {
    try {
      const response = await fetch(
        configuration.secret.ARBITRUM_SEPOLIA_RPC_URL,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "eth_chainId",
            params: [],
          }),
          signal: AbortSignal.timeout(5_000),
          redirect: "error",
        },
      );
      const body = await response.json();
      const chainId =
        typeof body.result === "string" ? Number(BigInt(body.result)) : 0;
      checks.push({
        status: response.ok && chainId === 421614 ? "PASS" : "FAIL",
        name: "RPC chain",
        detail: response.ok ? `chainId ${chainId}` : `HTTP ${response.status}`,
      });
    } catch {
      checks.push({
        status: "FAIL",
        name: "RPC chain",
        detail: "HTTPS RPC request failed",
      });
    }
  }
  return checks;
}

function runCommand(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function commandFact(result) {
  return {
    ok: result.code === 0,
    detail:
      result.code === 0
        ? result.stdout.trim().slice(0, 160) || "available"
        : safeError(result),
  };
}

function safeError(result) {
  const value =
    `${result.stderr || result.stdout}`.trim().split(/\r?\n/)[0] ??
    "command failed";
  return value.slice(0, 160) || `command failed (${result.code})`;
}

function formatGiB(bytes) {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

function printChecks(checks) {
  for (const check of checks)
    process.stdout.write(
      `${check.status.padEnd(4)} ${check.name}: ${check.detail}\n`,
    );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  Promise.resolve()
    .then(async () => {
      const options = parsePreflightArgs(process.argv.slice(2));
      const checks = evaluateHostFacts(await collectHostFacts());
      if (options.phase === "runtime")
        checks.push(...(await runtimeChecks(options)));
      printChecks(checks);
      const failures = checks.filter((check) => check.status === "FAIL");
      if (failures.length > 0)
        throw new Error(`HOST PREFLIGHT FAILED (${failures.length})`);
      process.stdout.write("HOST PREFLIGHT PASS\n");
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
