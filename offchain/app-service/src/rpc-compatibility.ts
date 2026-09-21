import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  READ_METHODS,
  RpcReadPool,
  RpcResponseError,
} from "../../app-core/src/rpc-pool.js";
const envelope = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(256), z.number().finite(), z.null()]).optional(),
  method: z.string().min(1).max(128),
  params: z.array(z.unknown()).default([]),
});
/** Legacy /rpc envelope compatibility. AA submission routes remain separate. */
export function registerRpcCompatibility(
  app: FastifyInstance,
  pool: RpcReadPool,
) {
  app.post(
    "/v1/rpc-compat",
    {
      bodyLimit: 64 * 1024,
      config: { rateLimit: { max: 1200, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const controller = new AbortController();
      const deadline = Date.now() + 8_000;
      const abort = () => controller.abort();
      request.raw.once("aborted", abort);
      const closed = () => {
        if (!reply.raw.writableEnded) abort();
      };
      reply.raw.once("close", closed);
      const run = async (input: unknown) => {
        const parsed = envelope.safeParse(input);
        if (!parsed.success)
          return {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid Request" },
          };
        const { id, method, params } = parsed.data;
        try {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("request deadline exceeded");
          const result = READ_METHODS.has(method)
            ? await pool.request(method, params, {
                signal: controller.signal,
                timeoutMs: remaining,
              })
            : await pool.requestOnce(
                method,
                params,
                controller.signal,
                remaining,
              );
          return id === undefined ? undefined : { jsonrpc: "2.0", id, result };
        } catch (error) {
          return id === undefined
            ? undefined
            : {
                jsonrpc: "2.0",
                id,
                error:
                  error instanceof RpcResponseError
                    ? {
                        code: error.code,
                        message:
                          error.data === undefined
                            ? "RPC request rejected"
                            : "execution reverted",
                        ...(error.data === undefined
                          ? {}
                          : { data: error.data }),
                      }
                    : { code: -32005, message: "RPC temporarily unavailable" },
              };
        }
      };
      try {
        const batch = Array.isArray(request.body),
          input = batch ? (request.body as unknown[]) : [request.body];
        if (!input.length || input.length > 64)
          return {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid Request" },
          };
        const output: unknown[] = new Array(input.length);
        let cursor = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, input.length) }, async () => {
            for (;;) {
              const i = cursor++;
              if (i >= input.length) break;
              output[i] = await run(input[i]);
            }
          }),
        );
        const responses = output.filter((v) => v !== undefined);
        return responses.length
          ? batch
            ? responses
            : responses[0]
          : reply.code(204).send();
      } finally {
        request.raw.off("aborted", abort);
        reply.raw.off("close", closed);
      }
    },
  );
}
