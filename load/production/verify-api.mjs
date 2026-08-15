import { rename, writeFile } from "node:fs/promises";
import WebSocket from "ws";

const baseUrl = new URL(required("TARGET_URL"));
const reportPath = required("REPORT_PATH");
const runId = required("RUN_ID");
const chainId = integer("LOAD_CHAIN_ID", 31_337, 1, Number.MAX_SAFE_INTEGER);
if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(baseUrl.hostname)) {
  throw new Error("production API smoke target must be loopback-only");
}

const market = address(1);
const checks = {
  health: await getJson("/healthz"),
  readiness: await getJson("/readyz"),
  markets: await getJson(`/v1/markets?chainId=${chainId}&limit=20`),
  market: await getJson(`/v1/markets/${market}?chainId=${chainId}`),
  listings: await getJson(
    `/v1/listings?chainId=${chainId}&vault=${market}&active=true&limit=20`,
  ),
};
if (checks.health.body.status !== "ok")
  throw new Error("production API health response is invalid");
if (checks.readiness.body.status !== "ready")
  throw new Error("production API readiness response is invalid");
if (checks.markets.body.items?.length !== 20)
  throw new Error("production API market page is not seeded");
if (checks.market.body.market?.toLowerCase() !== market.toLowerCase()) {
  throw new Error("production API market detail mismatch");
}
if (checks.listings.body.items?.length !== 20)
  throw new Error("production API listing page is not seeded");

const stream = await verifyWebSocket(
  `${baseUrl.protocol === "https:" ? "wss:" : "ws:"}//${baseUrl.host}/v1/stream?chainId=${chainId}&market=${market}`,
  chainId,
);
const metricsResponse = await fetch(new URL("/metrics", baseUrl), {
  signal: AbortSignal.timeout(5_000),
});
if (!metricsResponse.ok)
  throw new Error("production API metrics endpoint failed");
const metrics = await metricsResponse.text();
for (const metric of [
  "cpredict_indexer_ws_accepted_total",
  "cpredict_indexer_ws_connections",
  "cpredict_indexer_ws_peak_connections",
  "cpredict_indexer_batches_total",
]) {
  if (!metrics.includes(metric))
    throw new Error(`production metrics are missing ${metric}`);
}

const report = {
  schemaVersion: 1,
  lane: "production-indexer-Fastify-PostgreSQL-smoke",
  runId,
  observedAt: new Date().toISOString(),
  target: baseUrl.origin,
  chainId,
  datasetChecks: {
    marketsReturned: checks.markets.body.items.length,
    listingsReturned: checks.listings.body.items.length,
    market,
  },
  websocket: stream,
  observability: {
    requiredMetricsPresent: true,
  },
  thresholds: {
    liveness: true,
    readiness: true,
    seededReads: true,
    websocketProtocolReady: true,
    metricsPresent: true,
  },
  proofBoundary:
    "Real production Fastify API and WebSocket composition over fresh local PostgreSQL and Anvil; focused smoke, not the commercial-duration k6 gate.",
};
await writeJsonAtomically(reportPath, report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

async function getJson(path) {
  const started = performance.now();
  const response = await fetch(new URL(path, baseUrl), {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`production API ${path} returned ${response.status}`);
  return {
    status: response.status,
    latencyMs: round(performance.now() - started),
    body: await response.json(),
  };
}

function verifyWebSocket(url, expectedChainId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      perMessageDeflate: false,
      handshakeTimeout: 5_000,
    });
    const started = performance.now();
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("production WebSocket protocol-ready timeout"));
    }, 5_000);
    socket.once("message", (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (
          message.type !== "ready" ||
          message.protocolVersion !== 1 ||
          message.chainId !== expectedChainId
        ) {
          throw new Error("production WebSocket ready message is invalid");
        }
        clearTimeout(timeout);
        const latencyMs = round(performance.now() - started);
        socket.close(1000, "smoke complete");
        resolve({ upgradeAndReadyLatencyMs: latencyMs, message });
      } catch (error) {
        clearTimeout(timeout);
        socket.terminate();
        reject(error);
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function writeJsonAtomically(path, value) {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
}

function integer(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer within [${minimum}, ${maximum}]`,
    );
  }
  return value;
}

function address(value) {
  return `0x${String(value).padStart(40, "0")}`;
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
