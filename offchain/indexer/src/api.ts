import Fastify, { type FastifyInstance } from "fastify";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import type {
  IndexerQueryStore,
  MarketStatus,
  QueryPage,
} from "./store.js";
import {
  evidenceUriFromHash,
  normalizeEvidenceHash,
} from "../../sdk/src/evidence.js";
import { marketStatus, type MarketView } from "./store.js";
import type { IndexerWebSocketHub } from "./websocket.js";

export interface IndexerApiOptions {
  readiness?: (() => Promise<void>) | undefined;
  registry?: Registry | undefined;
  logLevel?:
    | "fatal"
    | "error"
    | "warn"
    | "info"
    | "debug"
    | "trace"
    | "silent"
    | undefined;
  maxConnections?: number | undefined;
  websocket?: IndexerWebSocketHub | undefined;
}

const chainIdSchema = z.coerce.number().int().positive();
const limitSchema = z.coerce.number().int().min(1).max(100).default(50);
const cursorSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine(
    (value) => BigInt(value) <= 100_000n,
    "cursor exceeds the bounded scan window",
  )
  .optional();
const addressSchema = z
  .string()
  .refine(isAddress)
  .transform((value) => getAddress(value));
const bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value as Hex);
const booleanSchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
const opaqueCursorSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,256}$/)
  .optional();
const marketStatusSchema = z
  .enum(["open", "resolved", "voided-creator", "voided-timeout"])
  .transform((value) => value as MarketStatus);

export function createIndexerApi(
  store: IndexerQueryStore,
  options: IndexerApiOptions = {},
): FastifyInstance {
  const registry = options.registry ?? new Registry();
  const app = Fastify({
    logger:
      options.logLevel === undefined ? false : { level: options.logLevel },
    bodyLimit: 1_024,
    requestTimeout: 5_000,
    connectionTimeout: 5_000,
    maxRequestsPerSocket: 1_000,
    trustProxy: false,
  });
  if (options.maxConnections !== undefined)
    app.server.maxConnections = options.maxConnections;
  const connections = new Gauge({
    name: "cpredict_indexer_http_connections",
    help: "Currently open HTTP server connections",
    registers: [registry],
  });
  const queued = new Gauge({
    name: "cpredict_indexer_http_requests_queued",
    help: "Requests admitted by Fastify but not yet executing a route handler",
    registers: [registry],
  });
  const inFlight = new Gauge({
    name: "cpredict_indexer_http_requests_in_flight",
    help: "Requests currently executing a route handler",
    registers: [registry],
  });
  const requests = new Counter({
    name: "cpredict_indexer_http_requests_total",
    help: "Completed HTTP requests",
    registers: [registry],
  });
  const requestDuration = new Histogram({
    name: "cpredict_indexer_http_request_duration_seconds",
    help: "End-to-end HTTP request duration",
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.3, 0.75, 1, 2, 5],
    registers: [registry],
  });
  const requestStarted = new WeakMap<object, bigint>();
  const executing = new WeakSet<object>();
  app.server.on("connection", (socket) => {
    connections.inc();
    socket.once("close", () => connections.dec());
  });
  app.addHook("onRequest", async (request) => {
    requestStarted.set(request, process.hrtime.bigint());
    queued.inc();
  });
  app.addHook("preHandler", async (request) => {
    queued.dec();
    inFlight.inc();
    executing.add(request);
  });
  app.addHook("onResponse", async (request) => {
    if (executing.delete(request)) inFlight.dec();
    else queued.dec();
    requests.inc();
    const started = requestStarted.get(request);
    if (started !== undefined)
      requestDuration.observe(Number(process.hrtime.bigint() - started) / 1e9);
  });
  if (options.websocket !== undefined) {
    options.websocket.attach(app.server);
    app.addHook("preClose", async () => options.websocket?.close());
  }

  app.get("/healthz", async () => ({ status: "ok", mode: "read-only" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      if (options.readiness !== undefined) await options.readiness();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
  app.get("/v1/markets", async (request, reply) => {
    const query = z
      .object({
        chainId: chainIdSchema,
        limit: limitSchema,
        cursor: cursorSchema,
      })
      .parse(request.query);
    return reply.send(
      jsonMarketPageV1(await store.listMarkets(query.chainId, query)),
    );
  });
  app.get("/v1/markets/:market", async (request, reply) => {
    const params = z.object({ market: addressSchema }).parse(request.params);
    const query = z.object({ chainId: chainIdSchema }).parse(request.query);
    const market = await store.market(query.chainId, params.market);
    return market === undefined
      ? reply.code(404).send({ error: "market not found" })
      : reply.send(jsonMarketV1(market));
  });
  app.get("/v2/markets", async (request, reply) => {
    const query = z
      .object({
        chainId: chainIdSchema,
        limit: limitSchema.default(20),
        cursor: opaqueCursorSchema,
        status: marketStatusSchema.optional(),
        owner: addressSchema.optional(),
      })
      .parse(request.query);
    return reply.send(
      jsonMarketPageV2(await store.listMarketCatalog(query.chainId, query)),
    );
  });
  app.get("/v2/markets/:market", async (request, reply) => {
    const params = z.object({ market: addressSchema }).parse(request.params);
    const query = z.object({ chainId: chainIdSchema }).parse(request.query);
    const market = await store.market(query.chainId, params.market);
    return market === undefined
      ? reply.code(404).send({ error: "market not found" })
      : reply.send(jsonMarketV2(market));
  });
  app.get("/v2/activity/:owner", async (request, reply) => {
    const params = z.object({ owner: addressSchema }).parse(request.params);
    const query = z
      .object({
        chainId: chainIdSchema,
        limit: limitSchema.default(20),
        cursor: opaqueCursorSchema,
      })
      .parse(request.query);
    return reply.send(
      jsonPage(await store.listActivity(query.chainId, params.owner, query)),
    );
  });
  app.get("/v1/listings", async (request, reply) => {
    const query = z
      .object({
        chainId: chainIdSchema,
        limit: limitSchema,
        cursor: cursorSchema,
        vault: addressSchema.optional(),
        active: booleanSchema.optional(),
      })
      .parse(request.query);
    return reply.send(jsonPage(await store.listListings(query.chainId, query)));
  });
  app.get("/v1/fills", async (request, reply) => {
    const query = z
      .object({
        chainId: chainIdSchema,
        limit: limitSchema,
        cursor: cursorSchema,
        vault: addressSchema.optional(),
        listingId: bytes32Schema.optional(),
      })
      .parse(request.query);
    return reply.send(jsonPage(await store.listFills(query.chainId, query)));
  });
  app.get("/v1/positions/:owner", async (request, reply) => {
    const params = z.object({ owner: addressSchema }).parse(request.params);
    const query = z
      .object({
        chainId: chainIdSchema,
        limit: limitSchema,
        cursor: cursorSchema,
        vault: addressSchema.optional(),
      })
      .parse(request.query);
    return reply.send(
      jsonPage(await store.listPositions(query.chainId, params.owner, query)),
    );
  });
  app.get("/v1/claims/:owner", async (request, reply) => {
    const params = z.object({ owner: addressSchema }).parse(request.params);
    const query = z
      .object({
        chainId: chainIdSchema,
        limit: limitSchema,
        cursor: cursorSchema,
        vault: addressSchema.optional(),
      })
      .parse(request.query);
    return reply.send(
      jsonPage(await store.listClaims(query.chainId, params.owner, query)),
    );
  });

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: "not found" }),
  );
  app.setErrorHandler(async (error, _request, reply) => {
    if (
      error instanceof z.ZodError ||
      error instanceof RangeError ||
      error instanceof TypeError
    ) {
      return reply.code(400).send({ error: "invalid request" });
    }
    return reply.code(500).send({ error: "internal error" });
  });
  return app;
}

function jsonPage<T>(value: QueryPage<T>): {
  items: unknown[];
  nextCursor?: string;
} {
  const result = { items: value.items.map((item) => json(item)) };
  return value.nextCursor === undefined
    ? result
    : { ...result, nextCursor: value.nextCursor };
}

function jsonMarketPageV1(value: QueryPage<MarketView>): {
  items: unknown[];
  nextCursor?: string;
} {
  const result = { items: value.items.map(jsonMarketV1) };
  return value.nextCursor === undefined
    ? result
    : { ...result, nextCursor: value.nextCursor };
}

function jsonMarketPageV2(value: QueryPage<MarketView>): {
  items: unknown[];
  nextCursor?: string;
} {
  const result = { items: value.items.map(jsonMarketV2) };
  return value.nextCursor === undefined
    ? result
    : { ...result, nextCursor: value.nextCursor };
}

function normalizedEvidence(value: MarketView): {
  evidenceHash: Hex | null;
  evidenceUri: `ipfs://${string}` | null;
} {
  try {
    const evidenceHash =
      value.evidenceHash === null
        ? null
        : normalizeEvidenceHash(value.evidenceHash);
    const evidenceUri =
      evidenceHash === null ? null : evidenceUriFromHash(evidenceHash);
    return {
      evidenceHash: evidenceUri === null ? null : evidenceHash,
      evidenceUri,
    };
  } catch {
    throw new Error("stored market evidence is invalid");
  }
}

function jsonMarketV1(value: MarketView): unknown {
  const evidence = normalizedEvidence(value);
  return json({
    chainId: value.chainId,
    market: value.market,
    creator: value.creator,
    deploymentMode: value.deploymentMode,
    outcomeCount: value.outcomeCount,
    closeAt: value.closeAt,
    marketPrimaryCap: value.marketPrimaryCap,
    creatorBond: value.creatorBond,
    state: value.state,
    winningOutcome: value.winningOutcome,
    ...evidence,
    createdBlock: value.createdBlock,
    updatedBlock: value.updatedBlock,
    confirmationStatus: value.confirmationStatus,
  });
}

function jsonMarketV2(value: MarketView): unknown {
  return json({
    ...value,
    status: marketStatus(value.state),
    ...normalizedEvidence(value),
  });
}

function json(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(json);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, json(entry)]),
    );
  }
  return value;
}

export function normalizeApiAddress(value: string): Address {
  return getAddress(value);
}
