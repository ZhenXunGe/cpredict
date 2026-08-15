import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

const baseUrl = new URL(required("TARGET_URL"));
const reportPath = required("REPORT_PATH");
const runId = required("RUN_ID");
const phase = required("SNAPSHOT_PHASE");
if (!new Set(["before", "after"]).has(phase))
  throw new Error("SNAPSHOT_PHASE must be before or after");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId))
  throw new Error("RUN_ID is invalid");
const loopback = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]).has(
  baseUrl.hostname,
);
if (!loopback && baseUrl.protocol !== "https:") {
  throw new Error("remote WebSocket metric snapshot target must use HTTPS");
}

let captured;
for (let attempt = 0; attempt < 51; attempt += 1) {
  const response = await fetch(new URL("/metrics", baseUrl), {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok)
    throw new Error(`metrics endpoint returned ${response.status}`);
  const body = await response.text();
  captured = snapshot(body);
  if (captured.currentConnections === 0) {
    captured.metricsSha256 = createHash("sha256").update(body).digest("hex");
    break;
  }
  if (attempt === 50)
    throw new Error(
      "WebSocket connections did not drain before metric snapshot",
    );
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (captured === undefined || captured.metricsSha256 === undefined) {
  throw new Error("WebSocket metrics were not captured");
}

const report = {
  schemaVersion: 1,
  lane: "production-indexer-websocket-capacity-snapshot",
  runId,
  phase,
  observedAt: new Date().toISOString(),
  target: baseUrl.origin,
  ...captured,
};
const temporary = `${reportPath}.tmp`;
await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await rename(temporary, reportPath);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function snapshot(body) {
  return {
    processStartTimeSeconds: finiteNumber(
      metric(body, "cpredict_indexer_process_start_time_seconds"),
      "process start time",
    ),
    acceptedTotal: scalar(body, "cpredict_indexer_ws_accepted_total"),
    rejectedTotal: labelledTotal(body, "cpredict_indexer_ws_rejected_total"),
    currentConnections: scalar(body, "cpredict_indexer_ws_connections"),
    peakConnections: scalar(body, "cpredict_indexer_ws_peak_connections"),
  };
}

function scalar(body, name) {
  return finiteInteger(metric(body, name), name);
}

function metric(body, name) {
  const match = body.match(
    new RegExp(`^${name}\\s+([0-9]+(?:\\.[0-9]+)?)$`, "m"),
  );
  if (match === null) throw new Error(`metrics endpoint is missing ${name}`);
  return match[1];
}

function labelledTotal(body, name) {
  let total = 0;
  for (const match of body.matchAll(
    new RegExp(`^${name}\\{[^\\n]*\\}\\s+([0-9]+(?:\\.[0-9]+)?)$`, "gm"),
  )) {
    total += finiteInteger(match[1], name);
  }
  return total;
}

function finiteInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`${label} is not a non-negative integer`);
  return parsed;
}

function finiteNumber(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0)
    throw new Error(`${label} is not a positive finite number`);
  return parsed;
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
}
