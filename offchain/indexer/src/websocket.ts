import type { IncomingMessage, Server as HttpServer } from "node:http";
import { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { Counter, Gauge, type Registry } from "prom-client";
import { getAddress, isAddress, type Address } from "viem";
import WebSocket, { WebSocketServer } from "ws";

export interface IndexerWebSocketConfig {
  chainId: number;
  maxConnections: number;
  heartbeatIntervalMs: number;
  maxBufferedAmountBytes: number;
  shutdownGraceMs: number;
}

export interface IndexerCheckpointNotification {
  blockNumber: bigint;
  eventCount: number;
}

interface Subscription {
  market: Address | null;
}

type CloseReason =
  | "backpressure"
  | "heartbeat_timeout"
  | "network"
  | "policy"
  | "remote"
  | "shutdown";

/**
 * Bounded read-only WebSocket fan-out attached to the same HTTP server as the production API.
 * It emits checkpoint invalidations; clients fetch canonical state through the HTTP API.
 */
export class IndexerWebSocketHub {
  private readonly server: WebSocketServer;
  private readonly subscriptions = new WeakMap<WebSocket, Subscription>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private readonly closeReasons = new WeakMap<WebSocket, CloseReason>();
  private readonly connections: Gauge;
  private readonly peakConnections: Gauge;
  private readonly accepted: Counter;
  private readonly rejected: Counter<"reason">;
  private readonly closed: Counter<"reason">;
  private readonly outbound: Counter<"kind">;
  private readonly heartbeats: Counter<"kind">;
  private readonly config: IndexerWebSocketConfig;
  private heartbeat: NodeJS.Timeout | undefined;
  private httpServer: HttpServer | undefined;
  private accepting = true;
  private sequence = 0;
  private peakConnectionCount = 0;

  constructor(config: IndexerWebSocketConfig, registry: Registry) {
    this.config = config;
    this.server = new WebSocketServer({
      noServer: true,
      clientTracking: true,
      maxPayload: 1_024,
      perMessageDeflate: false,
      skipUTF8Validation: false,
    });
    this.connections = new Gauge({
      name: "cpredict_indexer_ws_connections",
      help: "Currently open indexer WebSocket connections",
      registers: [registry],
    });
    this.peakConnections = new Gauge({
      name: "cpredict_indexer_ws_peak_connections",
      help: "Peak simultaneously open indexer WebSocket connections since process start",
      registers: [registry],
    });
    this.accepted = new Counter({
      name: "cpredict_indexer_ws_accepted_total",
      help: "Accepted indexer WebSocket connections",
      registers: [registry],
    });
    this.rejected = new Counter({
      name: "cpredict_indexer_ws_rejected_total",
      help: "Rejected indexer WebSocket upgrades",
      labelNames: ["reason"],
      registers: [registry],
    });
    this.closed = new Counter({
      name: "cpredict_indexer_ws_closed_total",
      help: "Closed indexer WebSocket connections",
      labelNames: ["reason"],
      registers: [registry],
    });
    this.outbound = new Counter({
      name: "cpredict_indexer_ws_outbound_total",
      help: "Application messages sent by the indexer WebSocket stream",
      labelNames: ["kind"],
      registers: [registry],
    });
    this.heartbeats = new Counter({
      name: "cpredict_indexer_ws_heartbeat_total",
      help: "WebSocket heartbeat ping and pong observations",
      labelNames: ["kind"],
      registers: [registry],
    });
    for (const reason of ["capacity", "invalid_request", "shutdown"] as const) {
      this.rejected.inc({ reason }, 0);
    }
    for (const reason of [
      "backpressure",
      "heartbeat_timeout",
      "network",
      "policy",
      "remote",
      "shutdown",
    ] as const) {
      this.closed.inc({ reason }, 0);
    }
    for (const kind of ["checkpoint", "ready"] as const)
      this.outbound.inc({ kind }, 0);
    for (const kind of ["ping", "pong"] as const)
      this.heartbeats.inc({ kind }, 0);
    this.server.on("connection", (socket, request) =>
      this.onConnection(socket, request),
    );
  }

  attach(httpServer: HttpServer): void {
    if (this.httpServer !== undefined)
      throw new Error("indexer WebSocket hub is already attached");
    this.httpServer = httpServer;
    httpServer.on("upgrade", this.onUpgrade);
    this.heartbeat = setInterval(
      () => this.heartbeatClients(),
      this.config.heartbeatIntervalMs,
    );
    this.heartbeat.unref();
  }

  publishCheckpoint(notification: IndexerCheckpointNotification): void {
    const message = JSON.stringify({
      type: "checkpoint",
      protocolVersion: 1,
      chainId: this.config.chainId,
      blockNumber: notification.blockNumber.toString(),
      eventCount: notification.eventCount,
      sequence: ++this.sequence,
      observedAt: new Date().toISOString(),
    });
    for (const socket of this.server.clients)
      this.send(socket, message, "checkpoint");
  }

  async close(): Promise<void> {
    if (!this.accepting) return;
    this.accepting = false;
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.httpServer?.off("upgrade", this.onUpgrade);
    this.httpServer = undefined;

    for (const socket of this.server.clients) {
      this.closeReasons.set(socket, "shutdown");
      socket.close(1001, "service shutdown");
    }
    if (this.server.clients.size > 0) {
      await Promise.race([
        new Promise<void>((resolve) => {
          const poll = setInterval(() => {
            if (this.server.clients.size !== 0) return;
            clearInterval(poll);
            resolve();
          }, 10);
          poll.unref();
        }),
        new Promise<void>((resolve) =>
          setTimeout(resolve, this.config.shutdownGraceMs),
        ),
      ]);
    }
    for (const socket of this.server.clients) socket.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private readonly onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    if (!this.accepting) {
      this.rejectUpgrade(socket, 503, "shutdown");
      return;
    }
    const subscription = parseSubscription(request.url, this.config.chainId);
    if (subscription === undefined) {
      this.rejectUpgrade(socket, 400, "invalid_request");
      return;
    }
    if (this.server.clients.size >= this.config.maxConnections) {
      this.rejectUpgrade(socket, 429, "capacity");
      return;
    }
    if (socket instanceof Socket) socket.setNoDelay(true);
    this.server.handleUpgrade(request, socket, head, (webSocket) => {
      this.subscriptions.set(webSocket, subscription);
      this.server.emit("connection", webSocket, request);
    });
  };

  private onConnection(socket: WebSocket, _request: IncomingMessage): void {
    const subscription = this.subscriptions.get(socket);
    if (subscription === undefined) {
      socket.terminate();
      return;
    }
    this.alive.set(socket, true);
    this.accepted.inc();
    this.connections.inc();
    this.peakConnectionCount = Math.max(
      this.peakConnectionCount,
      this.server.clients.size,
    );
    this.peakConnections.set(this.peakConnectionCount);
    socket.on("pong", () => {
      this.alive.set(socket, true);
      this.heartbeats.inc({ kind: "pong" });
    });
    socket.on("message", () => {
      this.closeReasons.set(socket, "policy");
      socket.close(1008, "read-only stream");
    });
    socket.on("error", () => this.closeReasons.set(socket, "network"));
    socket.once("close", () => {
      this.connections.dec();
      this.closed.inc({ reason: this.closeReasons.get(socket) ?? "remote" });
    });
    this.send(
      socket,
      JSON.stringify({
        type: "ready",
        protocolVersion: 1,
        chainId: this.config.chainId,
        market: subscription.market,
      }),
      "ready",
    );
  }

  private heartbeatClients(): void {
    for (const socket of this.server.clients) {
      if (socket.bufferedAmount > this.config.maxBufferedAmountBytes) {
        this.closeReasons.set(socket, "backpressure");
        socket.terminate();
        continue;
      }
      if (this.alive.get(socket) !== true) {
        this.closeReasons.set(socket, "heartbeat_timeout");
        socket.terminate();
        continue;
      }
      this.alive.set(socket, false);
      socket.ping();
      this.heartbeats.inc({ kind: "ping" });
    }
  }

  private send(
    socket: WebSocket,
    message: string,
    kind: "checkpoint" | "ready",
  ): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > this.config.maxBufferedAmountBytes) {
      this.closeReasons.set(socket, "backpressure");
      socket.terminate();
      return;
    }
    socket.send(message, { binary: false, compress: false }, (error) => {
      if (error !== undefined) this.closeReasons.set(socket, "network");
    });
    this.outbound.inc({ kind });
  }

  private rejectUpgrade(
    socket: Duplex,
    status: 400 | 429 | 503,
    reason: "capacity" | "invalid_request" | "shutdown",
  ): void {
    this.rejected.inc({ reason });
    if (socket.destroyed) return;
    const statusText =
      status === 400
        ? "Bad Request"
        : status === 429
          ? "Too Many Requests"
          : "Service Unavailable";
    socket.end(
      `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }
}

function parseSubscription(
  rawUrl: string | undefined,
  expectedChainId: number,
): Subscription | undefined {
  if (rawUrl === undefined || rawUrl.length > 512) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return undefined;
  }
  if (url.pathname !== "/v1/stream") return undefined;
  const allowed = new Set(["chainId", "market"]);
  for (const key of url.searchParams.keys())
    if (!allowed.has(key)) return undefined;
  if (url.searchParams.getAll("chainId").length !== 1) return undefined;
  if (url.searchParams.get("chainId") !== String(expectedChainId))
    return undefined;
  if (url.searchParams.getAll("market").length > 1) return undefined;
  const marketInput = url.searchParams.get("market");
  if (marketInput === null) return { market: null };
  return isAddress(marketInput)
    ? { market: getAddress(marketInput) }
    : undefined;
}
