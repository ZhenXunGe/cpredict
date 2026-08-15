import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";

const host = process.env.LOAD_API_HOST ?? "127.0.0.1";
const port = boundedInteger(process.env.LOAD_API_PORT, 18080, 1, 65535);
const marketCount = 100;
const listingsPerMarket = 1_000;
const totalListings = marketCount * listingsPerMarket;
const startedAt = Date.now();
let requests = 0;
let activeStreams = 0;
let totalStreamUpgrades = 0;

const server = http.createServer((request, response) => {
  requests += 1;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? `${host}:${port}`}`,
  );

  if (request.method !== "GET")
    return send(response, 405, { error: "method_not_allowed" });
  if (url.pathname === "/healthz") return send(response, 200, { status: "ok" });
  if (url.pathname === "/v1/dataset") {
    return send(response, 200, {
      markets: marketCount,
      listings: totalListings,
    });
  }
  if (url.pathname === "/v1/markets") {
    const offset = boundedInteger(
      url.searchParams.get("offset"),
      0,
      0,
      marketCount - 1,
    );
    const limit = boundedInteger(url.searchParams.get("limit"), 20, 1, 100);
    const end = Math.min(marketCount, offset + limit);
    return send(response, 200, {
      items: Array.from({ length: end - offset }, (_, index) =>
        market(offset + index),
      ),
      offset,
      limit,
      total: marketCount,
    });
  }

  const listingMatch = /^\/v1\/markets\/(\d+)\/listings$/.exec(url.pathname);
  if (listingMatch !== null) {
    const marketId = Number(listingMatch[1]);
    if (
      !Number.isInteger(marketId) ||
      marketId < 0 ||
      marketId >= marketCount
    ) {
      return send(response, 404, { error: "market_not_found" });
    }
    const offset = boundedInteger(
      url.searchParams.get("offset"),
      0,
      0,
      listingsPerMarket - 1,
    );
    const limit = boundedInteger(url.searchParams.get("limit"), 20, 1, 100);
    const end = Math.min(listingsPerMarket, offset + limit);
    return send(response, 200, {
      items: Array.from({ length: end - offset }, (_, index) =>
        listing(marketId, offset + index),
      ),
      offset,
      limit,
      total: listingsPerMarket,
    });
  }

  if (url.pathname === "/metrics") {
    response.setHeader("content-type", "text/plain; version=0.0.4");
    response.end(
      [
        `cpredict_load_harness_requests_total ${requests}`,
        `cpredict_load_harness_active_streams ${activeStreams}`,
        `cpredict_load_harness_stream_upgrades_total ${totalStreamUpgrades}`,
        `cpredict_load_harness_uptime_seconds ${(Date.now() - startedAt) / 1000}`,
        "",
      ].join("\n"),
    );
    return;
  }
  return send(response, 404, { error: "not_found" });
});

server.on("upgrade", (request, socket) => {
  const url = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? `${host}:${port}`}`,
  );
  const key = request.headers["sec-websocket-key"];
  if (
    url.pathname !== "/v1/stream" ||
    typeof key !== "string" ||
    request.headers.upgrade?.toLowerCase() !== "websocket"
  ) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"),
  );
  activeStreams += 1;
  totalStreamUpgrades += 1;
  socket.write(textFrame(JSON.stringify({ type: "ready", sequence: 0 })));
  const timer = setInterval(() => {
    if (!socket.destroyed) {
      socket.write(
        textFrame(JSON.stringify({ type: "heartbeat", at: Date.now() })),
      );
    }
  }, 1_000);
  timer.unref();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    activeStreams -= 1;
  };
  socket.on("close", close);
  socket.on("error", close);
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 10_000;

server.listen(port, host, () => {
  process.stdout.write(
    `${JSON.stringify({ status: "ready", host, port, marketCount, totalListings })}\n`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function market(id) {
  return {
    id,
    vault: address(id + 1),
    state: "OPEN",
    totalPrincipal: String((id + 1) * 1_000_000),
    listingCount: listingsPerMarket,
  };
}

function listing(marketId, listingIndex) {
  const globalId = marketId * listingsPerMarket + listingIndex;
  return {
    id: `0x${globalId.toString(16).padStart(64, "0")}`,
    marketId,
    outcomeId: globalId % 2,
    seller: address(globalId + 10_001),
    remainingUnits: String(10_000 + (globalId % 100) * 1_000),
    unitPrice: String(500_000 + (globalId % 500_000)),
    active: true,
  };
}

function address(value) {
  return `0x${value.toString(16).padStart(40, "0")}`;
}

function boundedInteger(raw, fallback, minimum, maximum) {
  const parsed = raw === null || raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    return fallback;
  return parsed;
}

function send(response, statusCode, body) {
  response.statusCode = statusCode;
  response.end(JSON.stringify(body));
}

function textFrame(payload) {
  const body = Buffer.from(payload);
  if (body.length < 126)
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  const header = Buffer.allocUnsafe(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}
