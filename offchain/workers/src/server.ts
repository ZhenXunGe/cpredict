import Fastify, { type FastifyInstance } from "fastify";
import type { Registry } from "prom-client";

export interface TerminalWorkerServerOptions {
  readiness(): Promise<void>;
  registry: Registry;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}

export function createTerminalWorkerServer(
  options: TerminalWorkerServerOptions,
): FastifyInstance {
  const app = Fastify({
    logger: { level: options.logLevel },
    bodyLimit: 1_024,
    requestTimeout: 5_000,
    connectionTimeout: 5_000,
    maxRequestsPerSocket: 100,
    trustProxy: false,
  });
  app.get("/healthz", async () => ({
    status: "ok",
    mode: "permissionless-maintenance",
  }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await options.readiness();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", options.registry.contentType);
    return options.registry.metrics();
  });
  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({ error: "not found" }),
  );
  return app;
}
