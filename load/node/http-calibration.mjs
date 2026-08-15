import fs from "node:fs";
import http from "node:http";
import { performance } from "node:perf_hooks";

const target = new URL(process.env.TARGET_URL ?? "http://127.0.0.1:18080");
const rate = integer("HTTP_RPS", 50, 1, 2_000);
const durationSeconds = integer("HTTP_DURATION", 10, 1, 600);
const profile = process.env.LOAD_PROFILE ?? "smoke";
const confirmation = process.env.CPREDICT_LOAD_CONFIRM;
if (
  (rate > 100 || durationSeconds > 30) &&
  confirmation !== "I_UNDERSTAND_RESOURCE_USAGE"
) {
  throw new Error(
    "larger calibration requires CPREDICT_LOAD_CONFIRM=I_UNDERSTAND_RESOURCE_USAGE",
  );
}

const total = rate * durationSeconds;
const intervalMs = 1_000 / rate;
const agent = new http.Agent({
  keepAlive: true,
  maxSockets: Math.max(10, Math.ceil(rate / 2)),
});
const latencies = [];
const statusCounts = new Map();
let transportErrors = 0;
let completed = 0;
const startedAt = performance.now();

await new Promise((resolve) => {
  for (let index = 0; index < total; index += 1) {
    const delay = Math.max(
      0,
      Math.round(index * intervalMs - (performance.now() - startedAt)),
    );
    setTimeout(async () => {
      try {
        const result = await request(pathFor(index), agent);
        latencies.push(result.latencyMs);
        statusCounts.set(
          result.status,
          (statusCounts.get(result.status) ?? 0) + 1,
        );
      } catch {
        transportErrors += 1;
      } finally {
        completed += 1;
        if (completed === total) resolve();
      }
    }, delay);
  }
});

agent.destroy();
latencies.sort((a, b) => a - b);
const elapsedSeconds = (performance.now() - startedAt) / 1_000;
const serverErrors = [...statusCounts.entries()]
  .filter(([status]) => status >= 500)
  .reduce((sum, [, count]) => sum + count, 0);
const result = {
  lane: "deterministic-read-api-harness",
  profile,
  target: target.origin,
  configuredRps: rate,
  durationSeconds,
  plannedRequests: total,
  completedRequests: completed,
  elapsedSeconds: round(elapsedSeconds),
  achievedRps: round(completed / elapsedSeconds),
  statusCounts: Object.fromEntries(
    [...statusCounts.entries()].sort(([a], [b]) => a - b),
  ),
  transportErrors,
  transportErrorRate: round(transportErrors / total),
  serverErrors,
  serverErrorRate: round(serverErrors / total),
  latencyMs: {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    max: latencies.at(-1) ?? null,
  },
  thresholds: {
    p95Under300ms: percentile(latencies, 0.95) < 300,
    p99Under750ms: percentile(latencies, 0.99) < 750,
    serverErrorRateUnder0_5Percent: serverErrors / total < 0.005,
    transportErrorRateUnder0_5Percent: transportErrors / total < 0.005,
  },
  proofBoundary:
    "Local Node reference query harness only; this does not validate the production API, Postgres, RPC, CDN, or Base.",
};

const encoded = `${JSON.stringify(result, null, 2)}\n`;
process.stdout.write(encoded);
if (process.env.REPORT_PATH !== undefined)
  fs.writeFileSync(process.env.REPORT_PATH, encoded);
if (Object.values(result.thresholds).some((passed) => !passed))
  process.exitCode = 2;

function request(pathname, requestAgent) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const request = http.get(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: pathname,
        agent: requestAgent,
        timeout: 5_000,
      },
      (response) => {
        response.resume();
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            latencyMs: round(performance.now() - started),
          }),
        );
      },
    );
    request.once("timeout", () => request.destroy(new Error("timeout")));
    request.once("error", reject);
  });
}

function pathFor(index) {
  const marketId = index % 100;
  if (index % 20 === 0) return "/v1/dataset";
  if (index % 4 === 0) return `/v1/markets?offset=${marketId}&limit=20`;
  return `/v1/markets/${marketId}/listings?offset=${(index * 17) % 980}&limit=20`;
}

function integer(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer within [${minimum}, ${maximum}]`,
    );
  }
  return value;
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  return round(
    values[
      Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)
    ],
  );
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
