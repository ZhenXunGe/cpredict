import { z } from "zod";
import { secureUrl } from "../../app-core/src/contracts.js";

export function parseSubmissionUrls(primary: string, json?: string): string[] {
  try {
    const urls = [
      secureUrl.parse(primary),
      ...z
        .array(secureUrl)
        .max(8)
        .parse(JSON.parse(json || "[]")),
    ];
    if (new Set(urls).size !== urls.length) throw new Error();
    return urls;
  } catch {
    throw new Error("invalid private automation writer configuration");
  }
}

/** Probe one writer before signing. A failed probe is safe to try on another
 * endpoint because no transaction has been broadcast yet. */
export async function submissionEndpointReady(
  request: (input: {
    method: "eth_chainId" | "eth_blockNumber";
  }) => Promise<unknown>,
  chainId: number,
  minimumHead = 1n,
): Promise<boolean> {
  try {
    const id = await request({ method: "eth_chainId" });
    if (
      typeof id !== "string" ||
      !/^0x[\da-f]+$/i.test(id) ||
      BigInt(id) !== BigInt(chainId)
    )
      return false;
    const head = await request({ method: "eth_blockNumber" });
    return (
      typeof head === "string" &&
      /^0x[\da-f]+$/i.test(head) &&
      BigInt(head) >= minimumHead
    );
  } catch {
    return false;
  }
}

type SubmissionMethod =
  | "eth_chainId"
  | "eth_blockNumber"
  | "eth_getBlockByNumber"
  | "eth_getTransactionCount"
  | "eth_gasPrice"
  | "eth_estimateGas"
  | "eth_call"
  | "eth_sendRawTransaction";
export interface SubmissionEndpoint {
  name?: string;
  request(input: {
    method: SubmissionMethod;
    params?: readonly unknown[];
  }): Promise<unknown>;
}

/** Choose a healthy writer before preparing a transaction. A signed raw
 * transaction is sent to exactly that writer once, with no broadcast fallback. */
export class SubmissionEndpointPool {
  private selected: number | undefined;
  private readonly retryAt: number[];
  private readonly failures: number[];
  constructor(
    private readonly endpoints: readonly SubmissionEndpoint[],
    private readonly chainId: number,
    private readonly now: () => number = Date.now,
    private readonly onSelected?: (index: number | undefined) => void,
  ) {
    if (!endpoints.length || endpoints.length > 9)
      throw new Error("invalid_submission_endpoints");
    this.retryAt = endpoints.map(() => 0);
    this.failures = endpoints.map(() => 0);
  }
  async ready(minimumHead = 1n): Promise<boolean> {
    this.selected = undefined;
    this.onSelected?.(undefined);
    for (const [index, endpoint] of this.endpoints.entries()) {
      if (this.retryAt[index]! > this.now()) continue;
      if (
        await submissionEndpointReady(
          (input) => endpoint.request(input),
          this.chainId,
          minimumHead,
        )
      ) {
        this.failures[index] = 0;
        this.retryAt[index] = 0;
        this.selected = index;
        this.onSelected?.(index);
        return true;
      }
      // Keep checking monthly-reset quotas, but cap dead-credential traffic.
      const delays = [60_000, 300_000, 900_000, 3_600_000];
      this.failures[index] = Math.min(this.failures[index]! + 1, delays.length);
      this.retryAt[index] = this.now() + delays[this.failures[index]! - 1]!;
    }
    return false;
  }
  async sendRaw(raw: string): Promise<unknown> {
    const index = this.selected;
    this.selected = undefined;
    this.onSelected?.(undefined);
    if (index === undefined) throw new Error("submission_rpc_unavailable");
    // The original hash is persisted before this point. Even if the provider
    // times out, another endpoint must not receive the same raw transaction.
    return this.endpoints[index]!.request({
      method: "eth_sendRawTransaction",
      params: [raw],
    });
  }
  provider(): string {
    const name =
      this.selected === undefined
        ? undefined
        : this.endpoints[this.selected]?.name;
    return name && /^[a-z][a-z0-9-]{0,31}$/.test(name)
      ? name
      : this.selected === undefined
        ? "writer-unavailable"
        : `writer-${this.selected + 1}`;
  }
  /** Read-only admission on the exact selected writer; never reselect mid-check. */
  async readSelected(
    method: string,
    params: readonly unknown[] = [],
  ): Promise<unknown> {
    if (
      ![
        "eth_chainId",
        "eth_blockNumber",
        "eth_getBlockByNumber",
        "eth_getTransactionCount",
        "eth_gasPrice",
        "eth_estimateGas",
        "eth_call",
      ].includes(method)
    )
      throw new Error("unsupported_writer_validation_method");
    if (this.selected === undefined)
      throw new Error("submission_rpc_unavailable");
    return this.endpoints[this.selected]!.request({
      method: method as SubmissionMethod,
      params,
    });
  }
}
