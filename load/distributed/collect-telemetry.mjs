import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import postgres from "postgres";
import {
  buildTelemetrySummary,
  parsePrometheus,
} from "./telemetry-evidence.mjs";

const baseUrl = new URL(required("SUT_BASE_URL"));
const rpcUrl = new URL(required("CHAIN_RPC_URL"));
const databaseUrl = required("SUT_DATABASE_URL");
const reportPath = required("TELEMETRY_REPORT_PATH");
const rawPath = required("TELEMETRY_RAW_PATH");
const durationSeconds = integer(
  "SUT_OBSERVE_SECONDS",
  900,
  process.env.NODE_ENV === "test" ? 1 : 600,
  7_200,
);
const intervalMs = integer(
  "TELEMETRY_INTERVAL_MS",
  5_000,
  process.env.NODE_ENV === "test" ? 10 : 1_000,
  60_000,
);
const allowedBlockLag = integer("INDEXER_ALLOWED_BLOCK_LAG", 2, 0, 10_000);
if (baseUrl.protocol !== "https:" && !isLoopback(baseUrl.hostname))
  throw new Error("remote SUT metrics require HTTPS");
if (rpcUrl.protocol !== "https:" && !isLoopback(rpcUrl.hostname))
  throw new Error("remote chain RPC requires HTTPS");

// This connection observes PostgreSQL server statistics only. Application admission and operation
// latency come from the production indexer process metrics, never from this monitoring connection.
const sql = postgres(databaseUrl, {
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: true,
  connection: { application_name: "cpredict-commercial-telemetry-collector" },
  onnotice: () => undefined,
});
const startedAt = new Date();
const deadline = Date.now() + durationSeconds * 1_000;
const samples = [];

try {
  while (Date.now() < deadline || samples.length < 2) {
    const observedAt = new Date();
    const [metricsBody, chainHead, postgresSample] = await Promise.all([
      fetchText(new URL("/metrics", baseUrl)),
      fetchChainHead(rpcUrl),
      samplePostgres(sql),
    ]);
    samples.push({
      observedAt: observedAt.toISOString(),
      metrics: parsePrometheus(metricsBody),
      chainHead,
      postgres: postgresSample,
    });
    const remaining = deadline - Date.now();
    if (remaining > 0)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(intervalMs, remaining)),
      );
  }
} finally {
  await sql.end({ timeout: 5 });
}

const raw = {
  schemaVersion: 1,
  lane: "distributed-commercial-sut-telemetry-raw",
  runId: required("RUN_ID"),
  startedAt: startedAt.toISOString(),
  completedAt: new Date().toISOString(),
  sampleIntervalMs: intervalMs,
  allowedBlockLag,
  samples,
};
const rawEncoded = `${JSON.stringify(raw, null, 2)}\n`;
await atomicWrite(rawPath, rawEncoded);
const report = buildTelemetrySummary(
  raw,
  createHash("sha256").update(rawEncoded).digest("hex"),
);
await atomicWrite(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function samplePostgres(connection) {
  const [activity] = await connection`
    SELECT count(*)::int AS active_connections
    FROM pg_stat_activity
    WHERE datname = current_database()
  `;
  const [database] = await connection`
    SELECT (xact_commit + xact_rollback)::bigint::text AS transactions
    FROM pg_stat_database
    WHERE datname = current_database()
  `;
  let checkpoints;
  try {
    const [row] = await connection`
      SELECT (num_timed + num_requested)::bigint::text AS checkpoints
      FROM pg_stat_checkpointer
    `;
    checkpoints = Number(row?.checkpoints);
  } catch {
    const [row] = await connection`
      SELECT (checkpoints_timed + checkpoints_req)::bigint::text AS checkpoints
      FROM pg_stat_bgwriter
    `;
    checkpoints = Number(row?.checkpoints);
  }
  const result = {
    activeConnections: Number(activity?.active_connections),
    transactions: Number(database?.transactions),
    checkpoints,
  };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`PostgreSQL ${key} statistic is invalid`);
  }
  return result;
}

async function fetchChainHead(url) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_blockNumber",
      params: [],
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`chain RPC returned ${response.status}`);
  const body = await response.json();
  if (body.error !== undefined || typeof body.result !== "string")
    throw new Error("chain RPC response is invalid");
  const value = Number(BigInt(body.result));
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("chain head is invalid");
  return value;
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok)
    throw new Error(`metrics endpoint returned ${response.status}`);
  return response.text();
}

async function atomicWrite(path, body) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, body, "utf8");
  await rename(temporary, path);
}

function integer(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be within [${minimum}, ${maximum}]`);
  }
  return value;
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
}

function isLoopback(host) {
  return new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(host);
}
