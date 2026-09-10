import { AppError } from "../../app-core/src/contracts.js";
import { fetchJson } from "../../app-core/src/fetch-json.js";
export { fetchJson } from "../../app-core/src/fetch-json.js";

export interface RpcTransport {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
}
export class ProviderRpc implements RpcTransport {
  constructor(private readonly url: string) {}
  async request(method: string, params: readonly unknown[]): Promise<unknown> {
    const data = await fetchJson(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (
      !data ||
      typeof data !== "object" ||
      !("result" in data) ||
      "error" in data
    )
      throw new AppError("provider_rejected", 503);
    return data.result;
  }
}
