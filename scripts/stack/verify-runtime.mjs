#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadStackConfiguration } from "./config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REQUIRED_HEADERS = [
  "content-security-policy",
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
];

export function parseComposePs(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const value = trimmed.startsWith("[")
    ? JSON.parse(trimmed)
    : trimmed
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
  if (!Array.isArray(value))
    throw new Error("docker compose ps JSON must be an array or JSON lines");
  return value;
}

export function verifyComposeState(rows, { sponsorship = false } = {}) {
  const checks = [];
  const byService = new Map(rows.map((row) => [row.Service, row]));
  const running = [
    "postgres",
    "indexer",
    "web-demo",
    ...(sponsorship ? ["paymaster"] : []),
  ];
  for (const service of running) {
    const row = byService.get(service);
    checks.push({
      status:
        row?.State === "running" && `${row.Health}`.toLowerCase() === "healthy"
          ? "PASS"
          : "FAIL",
      name: `${service} container`,
      detail:
        row === undefined
          ? "missing"
          : `state=${row.State} health=${row.Health || "none"}`,
    });
  }
  for (const service of [
    "migrate-indexer",
    ...(sponsorship ? ["migrate-paymaster"] : []),
  ]) {
    const row = byService.get(service);
    checks.push({
      status:
        row?.State === "exited" && Number(row.ExitCode) === 0 ? "PASS" : "FAIL",
      name: `${service} migration`,
      detail:
        row === undefined
          ? "missing"
          : `state=${row.State} exit=${row.ExitCode}`,
    });
  }
  for (const service of [
    "indexer",
    "web-demo",
    ...(sponsorship ? ["paymaster"] : []),
  ]) {
    const row = byService.get(service);
    const publishers = Array.isArray(row?.Publishers) ? row.Publishers : [];
    const unsafe = publishers.filter((publisher) => {
      const host = publisher.URL ?? publisher.IP ?? "";
      return host !== "127.0.0.1" && host !== "::1";
    });
    checks.push({
      status:
        row !== undefined && publishers.length > 0 && unsafe.length === 0
          ? "PASS"
          : "FAIL",
      name: `${service} host binding`,
      detail:
        row === undefined
          ? "missing"
          : unsafe.length === 0
            ? "loopback only"
            : "non-loopback publisher detected",
    });
  }
  const postgresPublishers = byService.get("postgres")?.Publishers ?? [];
  checks.push({
    status: postgresPublishers.length === 0 ? "PASS" : "FAIL",
    name: "PostgreSQL host binding",
    detail:
      postgresPublishers.length === 0 ? "not published" : "host port published",
  });
  return checks;
}

export function verifyHostConfig(service, hostConfig) {
  const checks = [];
  const add = (ok, name, detail) =>
    checks.push({
      status: ok ? "PASS" : "FAIL",
      name: `${service} ${name}`,
      detail,
    });
  add(
    Number(hostConfig.Memory) > 0,
    "memory limit",
    `${hostConfig.Memory ?? 0} bytes`,
  );
  add(
    Number(hostConfig.NanoCpus) > 0,
    "CPU limit",
    `${hostConfig.NanoCpus ?? 0} NanoCPUs`,
  );
  add(
    hostConfig.ReadonlyRootfs === true,
    "read-only root",
    `${hostConfig.ReadonlyRootfs}`,
  );
  add(
    hostConfig.Privileged === false,
    "unprivileged mode",
    `${hostConfig.Privileged}`,
  );
  add(
    hostConfig.RestartPolicy?.Name === "unless-stopped",
    "restart policy",
    hostConfig.RestartPolicy?.Name ?? "none",
  );
  add(
    hostConfig.SecurityOpt?.includes("no-new-privileges:true") === true,
    "no-new-privileges",
    (hostConfig.SecurityOpt ?? []).join(","),
  );
  add(
    hostConfig.CapDrop?.includes("ALL") === true,
    "capability drop",
    (hostConfig.CapDrop ?? []).join(","),
  );
  return checks;
}

export async function verifyHttpRuntime({ baseUrl, fetchFn = fetch }) {
  const checks = [];
  const request = async (path, options = {}) => {
    try {
      return await fetchFn(`${baseUrl}${path}`, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return null;
    }
  };
  const ready = await request("/readyz");
  checks.push({
    status: ready?.ok ? "PASS" : "FAIL",
    name: "Demo readiness",
    detail: ready === null ? "request failed" : `HTTP ${ready.status}`,
  });
  const indexer = await request("/indexer/readyz");
  checks.push({
    status: indexer?.ok ? "PASS" : "FAIL",
    name: "Indexer readiness",
    detail: indexer === null ? "request failed" : `HTTP ${indexer.status}`,
  });
  const shell = await request("/");
  const missingHeaders =
    shell === null
      ? REQUIRED_HEADERS
      : REQUIRED_HEADERS.filter((header) => !shell.headers.get(header));
  checks.push({
    status: shell?.ok && missingHeaders.length === 0 ? "PASS" : "FAIL",
    name: "Web security headers",
    detail:
      shell === null
        ? "request failed"
        : missingHeaders.length === 0
          ? "required headers present"
          : `missing ${missingHeaders.join(",")}`,
  });
  const runtime = await request("/runtime-config.json");
  let runtimeOk = false;
  try {
    const body = await runtime?.json();
    runtimeOk =
      runtime?.ok === true &&
      body.chain?.id === 421614 &&
      body.chain?.rpcPath === "/rpc" &&
      body.indexer?.basePath === "/indexer";
  } catch {
    runtimeOk = false;
  }
  checks.push({
    status: runtimeOk ? "PASS" : "FAIL",
    name: "browser runtime config",
    detail: runtimeOk
      ? "chain and same-origin paths valid"
      : "invalid or unavailable",
  });
  const rpc = await request("/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_chainId",
      params: [],
    }),
  });
  let chainId = 0;
  try {
    const body = await rpc?.json();
    chainId = typeof body.result === "string" ? Number(BigInt(body.result)) : 0;
  } catch {
    chainId = 0;
  }
  checks.push({
    status: rpc?.ok && chainId === 421614 ? "PASS" : "FAIL",
    name: "same-origin RPC",
    detail: rpc === null ? "request failed" : `chainId ${chainId}`,
  });
  const getRpc = await request("/rpc");
  checks.push({
    status: getRpc?.status === 403 || getRpc?.status === 405 ? "PASS" : "FAIL",
    name: "RPC method restriction",
    detail: getRpc === null ? "request failed" : `HTTP ${getRpc.status}`,
  });
  return checks;
}

export async function verifyRuntime({
  configuration,
  sponsorship = false,
  run = runCommand,
  fetchFn = fetch,
  root = ROOT,
}) {
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
  const ps = run(
    "docker",
    [...base, "ps", "--all", "--format", "json"],
    root,
    configuration.environment,
  );
  if (ps.code !== 0)
    return [
      {
        status: "FAIL",
        name: "Compose process inventory",
        detail: "docker compose ps failed",
      },
    ];
  const rows = parseComposePs(ps.stdout);
  const checks = verifyComposeState(rows, { sponsorship });
  for (const service of [
    "postgres",
    "indexer",
    "web-demo",
    ...(sponsorship ? ["paymaster"] : []),
  ]) {
    const row = rows.find((candidate) => candidate.Service === service);
    if (!row?.ID) continue;
    const inspect = run(
      "docker",
      ["inspect", "--format", "{{json .HostConfig}}", row.ID],
      root,
    );
    if (inspect.code !== 0) {
      checks.push({
        status: "FAIL",
        name: `${service} host configuration`,
        detail: "docker inspect failed",
      });
      continue;
    }
    try {
      checks.push(...verifyHostConfig(service, JSON.parse(inspect.stdout)));
    } catch {
      checks.push({
        status: "FAIL",
        name: `${service} host configuration`,
        detail: "invalid docker inspect JSON",
      });
    }
  }
  checks.push(
    ...(await verifyHttpRuntime({
      baseUrl: `http://127.0.0.1:${configuration.secret.CPREDICT_STACK_DEMO_PORT ?? "4177"}`,
      fetchFn,
    })),
  );
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
    stderr: result.stderr ?? "",
  };
}

async function writeReport(checks) {
  const directory = resolve(ROOT, "runtime/arbitrum-sepolia/verification");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const generatedAt = new Date().toISOString();
  const report = {
    schemaVersion: "cpredict.stack-runtime-verification.v1",
    evidenceClass: "LOCAL_COMPOSE_RUNTIME",
    generatedAt,
    status: checks.some((check) => check.status === "FAIL") ? "FAIL" : "PASS",
    checks,
  };
  const path = resolve(
    directory,
    `${generatedAt.replaceAll(/[:.]/g, "-")}.json`,
  );
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
  return { path, report };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  Promise.resolve()
    .then(async () => {
      const sponsorship = process.argv.slice(2).includes("--sponsorship");
      const unknown = process.argv
        .slice(2)
        .filter((value) => value !== "--sponsorship");
      if (unknown.length > 0) throw new Error(`unknown option ${unknown[0]}`);
      const configuration = await loadStackConfiguration({ sponsorship });
      const checks = await verifyRuntime({ configuration, sponsorship });
      for (const check of checks)
        process.stdout.write(
          `${check.status.padEnd(4)} ${check.name}: ${check.detail}\n`,
        );
      const { path, report } = await writeReport(checks);
      process.stdout.write(`${report.status} report ${path}\n`);
      if (report.status !== "PASS") process.exitCode = 1;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
