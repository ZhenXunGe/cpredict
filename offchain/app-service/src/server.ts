import Fastify, { type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import {
  AppError,
  address,
  bytes,
  intentSchema,
  gasPaymentSchema,
  registerOperationSchema,
  depositPrepareSchema,
  depositReportQuerySchema,
  type VerifiedIdentity,
} from "../../app-core/src/contracts.js";
import type { IdentityVerifier } from "./auth.js";
import type { AuthenticatedAAGateway } from "./gateway.js";
import { rpcRequestSchema } from "./gateway.js";
import { ProviderCallError, type RpcTransport } from "./http.js";
import type { OperationService } from "./operations.js";
import { readRpc } from "./read-rpc.js";
import type { OperationRecovery } from "./recovery.js";
import {
  feedbackSchema,
  feedbackQuerySchema,
  telemetrySchema,
} from "../../app-core/src/report-contracts.js";
import type { ReportingStore } from "./reports.js";
import { ApplicationMetrics } from "./metrics.js";
import type { ZeroDevManagementReader } from "./provider-management.js";

export async function createApplicationServer(options: {
  operations: OperationService;
  auth: IdentityVerifier;
  gateway: AuthenticatedAAGateway;
  recovery: OperationRecovery;
  chainRpc: RpcTransport;
  reports?: ReportingStore;
  metrics?: ApplicationMetrics;
  management?: ZeroDevManagementReader;
}) {
  const { operations: service } = options,
    env = service.runtime.environment;
  const app = Fastify({
    logger: {
      level: "warn",
      redact: ["req.headers.authorization", "req.body", "res.body"],
    },
    bodyLimit: 128 * 1024,
    requestTimeout: 15_000,
    connectionTimeout: 15_000,
    trustProxy: service.runtime.trustedProxies.length
      ? service.runtime.trustedProxies
      : false,
  });
  const metrics = options.metrics ?? new ApplicationMetrics();
  metrics.attach(app);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });
  await app.register(rateLimit, { max: 180, timeWindow: "1 minute" });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (
      request.headers.origin &&
      !service.runtime.allowedOrigins.includes(request.headers.origin)
    )
      throw new AppError("origin_not_allowed", 403);
    if (
      (request.headers["x-cpredict-environment"] !== undefined ||
        request.headers["x-cpredict-deployment"] !== undefined) &&
      (request.headers["x-cpredict-environment"] !== env.id ||
        request.headers["x-cpredict-deployment"] !== env.deployment.id)
    )
      throw new AppError("environment_mismatch", 409);
  });
  const authenticate = async (r: FastifyRequest): Promise<VerifiedIdentity> => {
    const header = r.headers.authorization;
    if (!header || !header.startsWith("Bearer ") || header.length > 16_384)
      throw new AppError("unauthorized", 401);
    try {
      const identity = await options.auth.verify(header.slice(7));
      metrics.observeDependency("privy", true);
      return identity;
    } catch (error) {
      // Invalid credentials are an authentication rejection, not evidence that
      // the Privy service itself is unavailable.
      if (!(error instanceof AppError) || error.status >= 500)
        metrics.observeDependency("privy", false);
      throw error;
    }
  };
  const ownedId = (r: FastifyRequest) =>
    z.object({ id: z.string().uuid() }).parse(r.params).id;
  app.post(
    "/v1/telemetry",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request) => {
      const input = telemetrySchema.parse(request.body),
        identity = input.event === "visit" ? null : await authenticate(request);
      if (input.accountId) {
        if (!identity) throw new AppError("unauthorized", 401);
        await service.controlledAccount(identity, input.accountId, false);
      }
      if (input.event === "account-ready" && !input.accountId)
        throw new AppError("account_required");
      if (!options.reports) throw new AppError("reporting_unavailable", 503);
      await options.reports.telemetry(input, identity?.subject ?? null);
      return { accepted: true };
    },
  );
  app.post(
    "/v1/feedback",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request) => {
      const identity = await authenticate(request),
        input = feedbackSchema.parse(request.body);
      if (input.accountId)
        await service.controlledAccount(identity, input.accountId, false);
      if (input.operationId) {
        const o = await service.ownedOperation(identity, input.operationId);
        if (input.accountId && o.accountId !== input.accountId)
          throw new AppError("operation_account_mismatch");
      }
      if (!options.reports) throw new AppError("reporting_unavailable", 503);
      await options.reports.feedback(input, identity.subject);
      return { id: input.id, accepted: true };
    },
  );
  app.get("/v1/ops/reports", async (request) => {
    const identity = await authenticate(request);
    if (!service.runtime.adminSubjects.includes(identity.subject))
      throw new AppError("forbidden", 403);
    const q = z
      .strictObject({
        start: z.string().datetime(),
        end: z.string().datetime(),
      })
      .parse(request.query);
    if (!options.reports) throw new AppError("reporting_unavailable", 503);
    const report = await options.reports.report(
      new Date(q.start),
      new Date(q.end),
    );
    try {
      const head = await service.client.getBlockNumber();
      report.services.rpc = "available";
      report.services.chainHead = head.toString();
      report.services.indexDelayBlocks =
        report.data.indexedBlock === null
          ? null
          : (head > BigInt(report.data.indexedBlock)
              ? head - BigInt(report.data.indexedBlock)
              : 0n
            ).toString();
    } catch {
      report.services.rpc = "unavailable";
    }
    return {
      ...report,
      providerManagement: options.management?.status() ?? null,
    };
  });
  app.get("/v1/ops/deposits", async (request) => {
    const identity = await authenticate(request);
    if (!service.runtime.adminSubjects.includes(identity.subject))
      throw new AppError("forbidden", 403);
    return service.store.depositReport(
      depositReportQuerySchema.parse(request.query),
      service.now().toISOString(),
    );
  });
  app.get("/v1/ops/feedback", async (request) => {
    const identity = await authenticate(request);
    if (!service.runtime.adminSubjects.includes(identity.subject))
      throw new AppError("forbidden", 403);
    if (!options.reports) throw new AppError("reporting_unavailable", 503);
    return options.reports.feedbackPage(
      feedbackQuerySchema.parse(request.query),
    );
  });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => {
    await service.store.ready();
    return {
      status: "ready",
      environment: env.id,
      deploymentId: env.deployment.id,
    };
  });
  app.get("/v1/config", async () => ({ environment: env }));
  app.get("/v1/me/accounts", async (request) => {
    const identity = await authenticate(request);
    const accounts = (await service.store.accounts(identity.subject)).filter(
      (a) =>
        identity.controllers.some(
          (c) => c.address.toLowerCase() === a.controller.toLowerCase(),
        ),
    );
    return {
      accounts,
      permissions: {
        opsRead: service.runtime.adminSubjects.includes(identity.subject),
      },
    };
  });
  app.post(
    "/v1/me/accounts/challenge",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (request) => {
      const identity = await authenticate(request);
      const body = z.strictObject({ controller: address }).parse(request.body);
      return service.challenge(identity, body.controller);
    },
  );
  app.post("/v1/me/accounts", async (request) => {
    const identity = await authenticate(request);
    const body = z
      .strictObject({
        challengeId: z.string().uuid(),
        signature: bytes.refine((v) => v.length <= 16_386),
      })
      .parse(request.body);
    return {
      account: await service.bind(identity, body.challengeId, body.signature),
    };
  });
  app.post(
    "/v1/deposits/prepare",
    { config: { rateLimit: { max: 15, timeWindow: "1 minute" } } },
    async (request) => ({
      deposit: await service.deposits.prepare(
        await authenticate(request),
        depositPrepareSchema.parse(request.body),
      ),
    }),
  );
  app.get("/v1/deposits", async (request) => {
    const identity = await authenticate(request);
    const q = z
      .strictObject({
        accountId: z.string().uuid(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
        cursor: z.string().max(2048).optional(),
        active: z.enum(["true", "false"]).optional(),
      })
      .parse(request.query);
    await service.controlledAccount(identity, q.accountId, false);
    return service.store.depositPage(
      identity.subject,
      q.accountId,
      service.now().toISOString(),
      q.limit,
      q.cursor,
      q.active === "true",
    );
  });
  app.get("/v1/deposits/:id", async (request) => {
    const identity = await authenticate(request),
      id = ownedId(request);
    let deposit = await service.deposits.owned(identity, id);
    if (deposit.operationId) {
      try {
        await options.recovery.refresh(
          await service.ownedOperation(identity, deposit.operationId),
        );
        deposit = await service.deposits.owned(identity, id);
      } catch {
        return { deposit, recovery: "unavailable" };
      }
    }
    return { deposit, recovery: "available" };
  });
  app.post("/v1/deposits/:id/cancel", async (request) => ({
    deposit: await service.deposits.cancel(
      await authenticate(request),
      ownedId(request),
    ),
  }));
  app.post("/v1/operations/prepare", async (request) => {
    const identity = await authenticate(request);
    const body = z
      .strictObject({
        accountId: z.string().uuid(),
        intent: intentSchema,
        gasPayment: gasPaymentSchema.optional(),
      })
      .parse(request.body);
    return service.prepare(
      identity,
      body.accountId,
      body.intent,
      body.gasPayment,
    );
  });
  for (const path of ["/v1/operations", "/v1/faucet/claims"])
    app.post(path, async (request, reply) => {
      const identity = await authenticate(request),
        input = registerOperationSchema.parse(request.body);
      if (path.includes("faucet") && input.intent.kind !== "faucet")
        throw new AppError("faucet_intent_required");
      return reply
        .code(201)
        .send({ operation: await service.register(identity, input) });
    });
  app.get("/v1/operations", async (request) => {
    const identity = await authenticate(request);
    const q = z
      .strictObject({
        key: z.string().uuid().optional(),
        accountId: z.string().uuid().optional(),
        cursor: z.string().max(2048).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .parse(request.query);
    if (q.key) {
      const found = await service.store.byKey(identity.subject, q.key);
      if (found && q.accountId && found.operation.accountId !== q.accountId)
        throw new AppError("account_not_found", 404);
      return {
        items: found
          ? [await service.ownedOperation(identity, found.operation.id)]
          : [],
        nextCursor: null,
      };
    }
    if (!q.accountId) throw new AppError("account_required");
    await service.controlledAccount(identity, q.accountId, false);
    return service.store.operationPage(
      identity.subject,
      q.accountId,
      q.limit,
      q.cursor,
    );
  });
  app.get("/v1/operations/:id", async (request) => {
    const identity = await authenticate(request),
      operation = await service.ownedOperation(identity, ownedId(request));
    try {
      return {
        operation: await options.recovery.refresh(operation),
        recovery: "available",
      };
    } catch {
      return { operation, recovery: "unavailable" };
    }
  });
  app.post("/v1/operations/:id/cancel", async (request) => ({
    operation: await service.cancel(
      await authenticate(request),
      ownedId(request),
    ),
  }));
  app.post("/v1/aa/:id", async (request) => {
    const identity = await authenticate(request),
      id = ownedId(request),
      rpc = rpcRequestSchema.parse(request.body);
    try {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: await options.gateway.request(identity, id, rpc),
      };
    } catch (error) {
      const e =
        error instanceof AppError
          ? error
          : new AppError("provider_request_rejected", 503);
      metrics.failure(e.code);
      await options.reports?.serviceEvent(e.code).catch(() => undefined);
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: -32000,
          message: e.code,
          data: { code: e.code, operationId: e.operationId ?? id },
        },
      };
    }
  });
  app.post(
    "/v1/sponsorship/policy",
    { config: { rateLimit: { max: 1200, timeWindow: "1 minute" } } },
    async (request) => {
      const result = await options.gateway.policy(request.body);
      metrics.policyDecision(result.proceed);
      return result;
    },
  );
  app.post("/v1/rpc", async (request) => {
    const rpc = rpcRequestSchema
      .extend({ params: z.array(z.unknown()).max(3).default([]) })
      .parse(request.body);
    try {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: await readRpc(options.chainRpc, rpc.method, rpc.params),
      };
    } catch (error) {
      if (!(error instanceof ProviderCallError)) throw error;
      // EntryPoint.getSenderAddress returns the address via a custom error.
      // The SDK needs a JSON-RPC error, not HTTP 503; never forward diagnostics.
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: error.rpcCode,
          message: "execution reverted",
          data: error.data,
        },
      };
    }
  });
  app.setErrorHandler(async (error, _request, reply) => {
    const e =
      error instanceof AppError
        ? error
        : error instanceof z.ZodError
          ? new AppError("invalid_request")
          : new AppError("service_unavailable", 503);
    metrics.failure(e.code);
    await options.reports?.serviceEvent(e.code).catch(() => undefined);
    return reply.code(e.status).send({
      error: {
        code: e.code,
        message: e.message,
        ...(e.operationId ? { operationId: e.operationId } : {}),
      },
    });
  });
  return app;
}
