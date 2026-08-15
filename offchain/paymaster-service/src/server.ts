import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { Counter, Histogram, Registry } from "prom-client";
import type { Address } from "viem";
import { ZodError } from "zod";
import { SponsorPolicy, sponsorshipRequestSchema } from "./policy.js";
import { createSponsorship, type SponsorshipConfig } from "./sponsorship.js";
import {
  SponsorBudgetExceededError,
  SponsorPolicyDeniedError,
  type SponsorAuthorizer,
  type SponsorBudgetStore,
  type SponsorSigner,
  type SponsorBudgetLimits,
} from "./types.js";

export interface SponsorServerOptions {
  policy: SponsorPolicy;
  signer: SponsorSigner;
  authorizer: SponsorAuthorizer;
  budgetStore: SponsorBudgetStore;
  config: SponsorshipConfig;
  expectedSigner: Address;
  budgetLimits: SponsorBudgetLimits;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export async function createSponsorServer(
  options: SponsorServerOptions,
): Promise<FastifyInstance> {
  if (
    (await options.signer.address()).toLowerCase() !==
    options.expectedSigner.toLowerCase()
  ) {
    throw new Error(
      "configured KMS/HSM signer does not match the required signer address",
    );
  }
  const registry = new Registry();
  const requests = new Counter({
    name: "cpredict_sponsor_requests_total",
    help: "Sponsorship requests by terminal outcome",
    labelNames: ["outcome"],
    registers: [registry],
  });
  const latency = new Histogram({
    name: "cpredict_sponsor_request_seconds",
    help: "Sponsorship policy and signing latency",
    registers: [registry],
  });
  const app = Fastify({
    logger: {
      level: options.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.body.userOperation.signature",
          "res.body.paymasterAndData",
        ],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: 64 * 1024,
    requestTimeout: 10_000,
    connectionTimeout: 5_000,
    maxRequestsPerSocket: 100,
    trustProxy: false,
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });
  await app.register(rateLimit, { max: 30, timeWindow: "1 minute" });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await Promise.all([
        options.policy.ready(),
        options.signer.ready(),
        options.authorizer.ready(),
        options.budgetStore.ready(),
      ]);
      if (
        (await options.signer.address()).toLowerCase() !==
        options.expectedSigner.toLowerCase()
      ) {
        throw new Error("signer mismatch");
      }
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
  app.post("/v1/sponsorship", async (request, reply) => {
    const stop = latency.startTimer();
    try {
      const identity = await options.authorizer.authorize(
        request.headers.authorization,
      );
      if (identity === null) {
        requests.inc({ outcome: "unauthorized" });
        return reply.code(401).send({ error: "unauthorized" });
      }
      const parsed = sponsorshipRequestSchema.parse(request.body);
      const decision = await options.policy.validate(
        parsed.userOperation,
        parsed.requestedMaxCost,
      );
      const nowSeconds = Math.floor(Date.now() / 1000);
      const lease = await options.budgetStore.reserve({
        subject: identity.subject,
        sender: parsed.userOperation.sender,
        maxCost: parsed.requestedMaxCost,
        validUntil: nowSeconds + options.config.validitySeconds,
        policyDay: Math.floor(nowSeconds / 86_400),
        operationCounts: decision.operationCounts,
        limits: options.budgetLimits,
      });
      let signatureCreated = false;
      let sponsorship;
      try {
        sponsorship = await createSponsorship(
          options.signer,
          options.config,
          parsed.userOperation,
          parsed.requestedMaxCost,
          nowSeconds,
        );
        signatureCreated = true;
        await lease.commit();
      } catch (error: unknown) {
        // If commit is uncertain after signing, retain the reservation until expiry. Releasing it
        // could authorize two signatures against the same off-chain budget.
        if (!signatureCreated) await lease.release();
        throw error;
      }
      requests.inc({ outcome: "issued" });
      return sponsorship;
    } catch (error: unknown) {
      requests.inc({ outcome: "rejected" });
      if (
        error instanceof ZodError ||
        error instanceof RangeError ||
        error instanceof TypeError
      ) {
        return reply.code(400).send({ error: "invalid sponsorship request" });
      }
      if (error instanceof SponsorPolicyDeniedError) {
        return reply.code(403).send({ error: "sponsorship denied" });
      }
      if (error instanceof SponsorBudgetExceededError) {
        return reply.code(429).send({ error: "sponsorship budget exceeded" });
      }
      request.log.warn(
        { requestId: request.id },
        "sponsorship dependency failed",
      );
      return reply.code(503).send({ error: "sponsorship unavailable" });
    } finally {
      stop();
    }
  });
  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: "not found" }),
  );
  app.setErrorHandler(async (error, request, reply) => {
    request.log.error(
      {
        requestId: request.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      },
      "request failed",
    );
    return reply.code(500).send({ error: "internal error" });
  });
  return app;
}
