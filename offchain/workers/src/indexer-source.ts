import { getAddress, isAddress, type Address } from "viem";
import { z } from "zod";
import type { TerminalMarketSource } from "./terminal-workers.js";

const pageSchema = z.object({
  items: z.array(
    z.object({
      market: z
        .string()
        .refine(isAddress)
        .transform((value) => getAddress(value)),
      state: z.union([
        z.number().int(),
        z.string().regex(/^\d+$/).transform(Number),
      ]),
    }),
  ),
  nextCursor: z.string().optional(),
});
const MAX_RESPONSE_BYTES = 1_048_576;

/** Reads terminal markets from the local/HTTPS Indexer API using bounded cursor pagination. */
export class IndexerTerminalMarketSource implements TerminalMarketSource {
  constructor(
    private readonly endpoint: URL,
    private readonly chainId: number,
    private readonly fetcher: typeof fetch = fetch,
    private readonly maxPages = 100,
    private readonly requestTimeoutMs = 5_000,
  ) {
    if (
      endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && isLoopback(endpoint.hostname))
    ) {
      throw new TypeError(
        "Indexer endpoint must use HTTPS (localhost is allowed for development)",
      );
    }
    if (!Number.isSafeInteger(chainId) || chainId <= 0)
      throw new RangeError("invalid chainId");
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1_000) {
      throw new RangeError("maxPages must be within [1, 1000]");
    }
    if (
      !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs < 500 ||
      requestTimeoutMs > 30_000
    ) {
      throw new RangeError("requestTimeoutMs must be within [500, 30000]");
    }
  }

  async terminalMarkets(_blockNumber: bigint): Promise<readonly Address[]> {
    const result = new Set<Address>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber += 1) {
      const url = new URL("/v1/markets", this.endpoint);
      url.searchParams.set("chainId", this.chainId.toString());
      url.searchParams.set("limit", "100");
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);
      const response = await this.fetcher(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!response.ok)
        throw new Error(
          `Indexer market query failed with HTTP ${response.status}`,
        );
      const declaredLength = Number(
        response.headers.get("content-length") ?? "0",
      );
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > MAX_RESPONSE_BYTES
      ) {
        throw new Error("Indexer market response exceeds size limit");
      }
      const body = await response.text();
      if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
        throw new Error("Indexer market response exceeds size limit");
      }
      const page = pageSchema.parse(JSON.parse(body));
      for (const item of page.items)
        if (item.state !== 0) result.add(item.market);
      if (page.nextCursor === undefined) return [...result];
      cursor = page.nextCursor;
    }
    throw new Error("Indexer market pagination exceeded configured maxPages");
  }
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}
