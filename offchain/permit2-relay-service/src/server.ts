import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { Counter, Histogram, Registry } from "prom-client";
import { ZodError } from "zod";
import {
  permit2RelayBuyWireSchema,
  permit2RelayIntentId,
} from "../../sdk/src/permit2-relay.js";
import type { Permit2RelayServiceConfig } from "./config.js";
import {
  Permit2RelayPolicyDeniedError,
  type Permit2RelayChain,
  type Permit2RelayIntentStore,
  type Permit2RelaySender,
} from "./types.js";

export async function createPermit2RelayServer(options: {
  chain: Permit2RelayChain;
  sender: Permit2RelaySender;
  intentStore: Permit2RelayIntentStore;
  config: Pick<Permit2RelayServiceConfig, "expectedSender" | "logLevel">;
}) {
  const registry = new Registry();
  const requests = new Counter({
    name: "cpredict_permit2_relay_requests_total",
    help: "Permit2 relay requests by terminal outcome",
    labelNames: ["outcome"],
    registers: [registry],
  });
  const latency = new Histogram({
    name: "cpredict_permit2_relay_request_seconds",
    help: "Permit2 relay validation and submission latency",
    registers: [registry],
  });
  const app = Fastify({
    logger: {
      level: options.config.logLevel,
      redact: {
        paths: ["req.body.signature", "res.body.transactionHash"],
        censor: "[REDACTED]",
      },
    },
    bodyLimit: 32 * 1024,
    requestTimeout: 15_000,
    connectionTimeout: 5_000,
    maxRequestsPerSocket: 50,
    trustProxy: false,
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });
  await app.register(rateLimit, { max: 20, timeWindow: "1 minute" });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await Promise.all([
        options.chain.ready(),
        options.sender.ready(),
        options.intentStore.ready(),
      ]);
      if (
        (await options.sender.address()).toLowerCase() !==
        options.config.expectedSender.toLowerCase()
      ) {
        throw new Error("relay sender mismatch");
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

  app.post("/v1/permit2-buys", async (request, reply) => {
    const stop = latency.startTimer();
    try {
      const parsed = permit2RelayBuyWireSchema.parse(request.body);
      const input = {
        ...parsed,
        factory: parsed.factory,
        permit2: parsed.permit2,
      };
      const intentId = permit2RelayIntentId(input);
      const existing = await options.intentStore.find(intentId);
      if (existing?.state === "submitted") {
        requests.inc({ outcome: "idempotent" });
        return reply.code(202).send({
          intentId,
          transactionHash: existing.hash,
          status: "submitted",
          idempotent: true,
        });
      }
      if (existing?.state === "pending") {
        requests.inc({ outcome: "outcome_unknown" });
        return reply.code(409).send({ error: "relay outcome unknown" });
      }
      const sender = await options.sender.address();
      const prepared = await options.chain.prepare(input, sender);
      const reservation = await options.intentStore.reserve({
        intentId,
        owner: input.owner,
        vault: input.vault,
        permitNonce: input.permit.nonce,
        expiresAt: input.permit.deadline,
      });
      if (reservation.kind === "submitted") {
        requests.inc({ outcome: "idempotent" });
        return reply.code(202).send({
          intentId,
          transactionHash: reservation.hash,
          status: "submitted",
          idempotent: true,
        });
      }
      if (reservation.kind === "pending") {
        requests.inc({ outcome: "outcome_unknown" });
        return reply.code(409).send({ error: "relay outcome unknown" });
      }

      let transactionHash;
      try {
        transactionHash = await options.sender.sendTransaction(prepared);
      } catch {
        // Once sendTransaction starts, absence of a hash does not prove that the provider did not
        // broadcast. Keep the durable pending reservation and never retry automatically.
        requests.inc({ outcome: "outcome_unknown" });
        return reply.code(503).send({ error: "relay outcome unknown" });
      }
      try {
        await reservation.markSubmitted(transactionHash);
      } catch {
        // The browser can still follow this exact hash. Returning it is safer than inviting a
        // duplicate request after the broadcast already happened.
        request.log.error(
          { requestId: request.id, intentId },
          "relay submission persistence is uncertain",
        );
      }
      requests.inc({ outcome: "submitted" });
      return reply.code(202).send({
        intentId,
        transactionHash,
        status: "submitted",
        idempotent: false,
      });
    } catch (error: unknown) {
      if (
        error instanceof ZodError ||
        error instanceof RangeError ||
        error instanceof TypeError
      ) {
        requests.inc({ outcome: "invalid" });
        return reply.code(400).send({ error: "invalid relay request" });
      }
      if (error instanceof Permit2RelayPolicyDeniedError) {
        requests.inc({ outcome: "denied" });
        return reply.code(403).send({ error: "relay denied" });
      }
      requests.inc({ outcome: "unavailable" });
      request.log.warn(
        {
          requestId: request.id,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "relay dependency failed",
      );
      return reply.code(503).send({ error: "relay unavailable" });
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
