import { describe, expect, it, vi } from "vitest";
import {
  createHttpPermit2BuyRelayer,
  permit2RelayBuyWireSchema,
  permit2RelayIntentId,
  Permit2RelayOutcomeUnknownError,
  serializePermit2RelayBuyInput,
} from "../src/permit2-relay.js";

const input = {
  chainId: 421_614n,
  factory: "0x00000000000000000000000000000000000000F1",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  vault: "0x00000000000000000000000000000000000000A1",
  owner: "0x00000000000000000000000000000000000000B1",
  outcomeId: 1n,
  desiredUnits: 2_000_000n,
  minimumUnits: 2_000_000n,
  maximumPayment: 2_000_000n,
  deadline: 1_900_000_000n,
  permit: {
    permitted: {
      token: "0x00000000000000000000000000000000000000C1",
      amount: 2_000_000n,
    },
    nonce: 7n,
    deadline: 1_900_000_000n,
  },
  signature: `0x${"11".repeat(65)}`,
} as const;

describe("Permit2 buy relayer client", () => {
  it("uses a deterministic intent id and a decimal-only wire format", () => {
    const serialized = serializePermit2RelayBuyInput(input);
    expect(serialized.maximumPayment).toBe("2000000");
    expect(permit2RelayBuyWireSchema.parse(serialized)).toMatchObject({
      chainId: 421_614n,
      maximumPayment: 2_000_000n,
    });
    expect(permit2RelayIntentId(input)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(permit2RelayIntentId(input)).toBe(permit2RelayIntentId(input));
  });

  it("posts once and parses the submitted transaction hash", async () => {
    const intentId = permit2RelayIntentId(input);
    const requested: Array<string> = [];
    const fetcher = vi.fn(async (request: RequestInfo | URL) => {
      requested.push(String(request));
      return new Response(
        JSON.stringify({
          intentId,
          transactionHash: `0x${"22".repeat(32)}`,
          status: "submitted",
          idempotent: false,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    });
    const relayer = createHttpPermit2BuyRelayer({
      baseUrl: "https://demo.example/relay/",
      fetcher,
    });
    await expect(relayer.relayBuy(input)).resolves.toMatchObject({
      intentId,
      status: "submitted",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requested[0]).toBe(
      "https://demo.example/relay/v1/permit2-buys",
    );
  });

  it("marks pending and dependency failures as outcome unknown without retrying", async () => {
    const fetcher = vi.fn(async () =>
      new Response('{"error":"relay outcome unknown"}', {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const relayer = createHttpPermit2BuyRelayer({
      baseUrl: "https://demo.example/relay",
      fetcher,
    });
    await expect(relayer.relayBuy(input)).rejects.toBeInstanceOf(
      Permit2RelayOutcomeUnknownError,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
