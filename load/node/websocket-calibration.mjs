import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { performance } from "node:perf_hooks";

const host = process.env.LOAD_API_HOST ?? "127.0.0.1";
const port = integer("LOAD_API_PORT", 18080, 1, 65535);
const connectionCount = integer("WS_CONNECTIONS", 50, 1, 10_000);
const holdSeconds = integer("WS_HOLD_SECONDS", 10, 1, 120);
if (
  (connectionCount > 500 || holdSeconds > 30) &&
  process.env.CPREDICT_LOAD_CONFIRM !== "I_UNDERSTAND_RESOURCE_USAGE"
) {
  throw new Error(
    "large connection calibration requires explicit resource acknowledgement",
  );
}

const sockets = [];
const latencies = [];
let failures = 0;
const startedAt = performance.now();
const batchSize = Math.min(100, connectionCount);
for (let offset = 0; offset < connectionCount; offset += batchSize) {
  const batch = Array.from(
    { length: Math.min(batchSize, connectionCount - offset) },
    (_, index) => connect(offset + index),
  );
  const connected = await Promise.allSettled(batch);
  for (const outcome of connected) {
    if (outcome.status === "fulfilled") {
      sockets.push(outcome.value.socket);
      latencies.push(outcome.value.latencyMs);
    } else {
      failures += 1;
    }
  }
  await delay(10);
}

await delay(holdSeconds * 1_000);
for (const socket of sockets) socket.destroy();
latencies.sort((a, b) => a - b);
const result = {
  lane: "deterministic-read-websocket-harness",
  requestedConnections: connectionCount,
  successfulConnections: sockets.length,
  failures,
  successRate: round(sockets.length / connectionCount),
  holdSeconds,
  establishmentSeconds: round(
    (performance.now() - startedAt) / 1_000 - holdSeconds,
  ),
  connectLatencyMs: {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    max: latencies.at(-1) ?? null,
  },
  thresholds: {
    upgradeSuccessAtLeast99_5Percent: sockets.length / connectionCount >= 0.995,
  },
  proofBoundary:
    "Local raw-WebSocket reference harness only; 10,000 production client connections require the full opt-in k6 run against deployed infrastructure.",
};
const encoded = `${JSON.stringify(result, null, 2)}\n`;
process.stdout.write(encoded);
if (process.env.REPORT_PATH !== undefined)
  fs.writeFileSync(process.env.REPORT_PATH, encoded);
if (!result.thresholds.upgradeSuccessAtLeast99_5Percent) process.exitCode = 2;

function connect(id) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.createConnection({ host, port });
    const started = performance.now();
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("upgrade timeout"));
    }, 5_000);
    let headers = "";
    socket.setNoDelay(true);
    socket.once("connect", () => {
      socket.write(
        [
          `GET /v1/stream?marketId=${id % 100} HTTP/1.1`,
          `Host: ${host}:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    const onData = (chunk) => {
      headers += chunk.toString("latin1");
      if (!headers.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      clearTimeout(timeout);
      if (!headers.startsWith("HTTP/1.1 101")) {
        socket.destroy();
        reject(new Error("upgrade rejected"));
        return;
      }
      resolve({ socket, latencyMs: round(performance.now() - started) });
    };
    socket.on("data", onData);
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
