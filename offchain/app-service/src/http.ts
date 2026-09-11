import type { Hex } from "viem";
import { z } from "zod";
import { AppError, bytes } from "../../app-core/src/contracts.js";
import { fetchJson } from "../../app-core/src/fetch-json.js";
export { fetchJson } from "../../app-core/src/fetch-json.js";

export interface RpcTransport {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
}

const callErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: bytes,
});

/** Only validated eth_call revert bytes may cross the public RPC boundary. */
export class ProviderCallError extends AppError {
  constructor(
    readonly rpcCode: number,
    readonly data: Hex,
  ) {
    super("provider_rejected", 503);
  }
}

export class ProviderRpc implements RpcTransport {
  constructor(
    private readonly url: string,
    private readonly observed?: (available: boolean) => void,
  ) {}
  async request(method: string, params: readonly unknown[]): Promise<unknown> {
    let data: unknown;
    try {
      data = await fetchJson(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    } catch (error) {
      this.observed?.(false);
      throw error;
    }
    if (
      !data ||
      typeof data !== "object" ||
      (!("result" in data) && !("error" in data))
    ) {
      this.observed?.(false);
      throw new AppError("provider_rejected", 503);
    }
    // A protocol error (for example a rejected simulation) is still a reachable
    // provider. Business rejection counters are separate from availability.
    this.observed?.(true);
    if ("error" in data) {
      if (method === "eth_call" && !("result" in data)) {
        const error = callErrorSchema.safeParse(data.error);
        if (error.success)
          throw new ProviderCallError(error.data.code, error.data.data);
      }
      throw new AppError("provider_rejected", 503);
    }
    return data.result;
  }
}
