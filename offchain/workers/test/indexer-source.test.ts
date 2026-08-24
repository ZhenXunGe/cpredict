import { describe, expect, it, vi } from "vitest";
import { IndexerTerminalMarketSource } from "../src/indexer-source.js";

const open = "0x00000000000000000000000000000000000000A1";
const terminal = "0x00000000000000000000000000000000000000B1";

describe("IndexerTerminalMarketSource", () => {
  it("uses bounded pagination and returns only terminal markets", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ market: open, state: 0 }],
            nextCursor: "10",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              { market: terminal, state: "2" },
              { market: terminal, state: 2 },
            ],
          }),
          { status: 200 },
        ),
      );
    const source = new IndexerTerminalMarketSource(
      new URL("https://indexer.example.invalid"),
      421614,
      fetcher,
    );
    await expect(source.terminalMarkets(1n)).resolves.toEqual([terminal]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("cursor=10");
  });

  it("rejects insecure remote endpoints", () => {
    expect(
      () =>
        new IndexerTerminalMarketSource(
          new URL("http://indexer.example.invalid"),
          1,
        ),
    ).toThrow("HTTPS");
  });

  it("enforces a bounded request timeout", () => {
    expect(
      () =>
        new IndexerTerminalMarketSource(
          new URL("https://indexer.example.invalid"),
          421614,
          fetch,
          100,
          30_001,
        ),
    ).toThrow("requestTimeoutMs");
  });

  it("accepts loopback development hosts and rejects oversized pages", async () => {
    const source = new IndexerTerminalMarketSource(
      new URL("http://localhost:3001"),
      421614,
      vi.fn(async () => new Response("x".repeat(1_048_577), { status: 200 })),
    );
    await expect(source.terminalMarkets(1n)).rejects.toThrow("size limit");
  });
});
