import { describe, expect, it, vi } from "vitest";
import {
  buildAccountBatch,
  selectSponsorship,
  SponsorshipUnavailableError,
  type SmartAccountAdapter,
} from "../src/aa.js";

interface Operation {
  callData: `0x${string}`;
  nonceKey: bigint;
  sponsored?: string;
}

describe("AA sponsorship fallback", () => {
  it("uses providers in order before explicit native fallback", async () => {
    const calls: string[] = [];
    const result = await selectSponsorship<Operation>(
      { callData: "0x01", nonceKey: 0n },
      [
        {
          name: "protocol",
          lane: "protocol-free",
          async sponsor() {
            calls.push("protocol");
            throw new Error("budget exhausted");
          },
        },
        {
          name: "external",
          lane: "external-usdc",
          async sponsor(operation) {
            calls.push("external");
            return { ...operation, sponsored: "usdc" };
          },
        },
      ],
      { timeoutMs: 500, allowNativeEth: true },
    );
    expect(calls).toEqual(["protocol", "external"]);
    expect(result.lane).toBe("external-usdc");
    expect(result.failedProviders).toEqual(["protocol"]);
  });

  it("fails instead of silently charging native ETH when fallback is disabled", async () => {
    await expect(
      selectSponsorship(
        { callData: "0x", nonceKey: 0n },
        [
          {
            name: "protocol",
            lane: "protocol-free",
            async sponsor() {
              throw new Error("down");
            },
          },
        ],
        { timeoutMs: 100, allowNativeEth: false },
      ),
    ).rejects.toBeInstanceOf(SponsorshipUnavailableError);
  });

  it("enforces fallback order and advances when a provider ignores abort signals", async () => {
    await expect(
      selectSponsorship(
        { callData: "0x", nonceKey: 0n },
        [
          {
            name: "external",
            lane: "external-usdc",
            async sponsor(operation) {
              return operation;
            },
          },
          {
            name: "protocol",
            lane: "protocol-free",
            async sponsor(operation) {
              return operation;
            },
          },
        ],
        { timeoutMs: 100, allowNativeEth: false },
      ),
    ).rejects.toThrow("must precede");

    const result = await selectSponsorship(
      { callData: "0x", nonceKey: 0n },
      [
        {
          name: "never-settles",
          lane: "protocol-free",
          async sponsor() {
            return new Promise<never>(() => undefined);
          },
        },
        {
          name: "external",
          lane: "external-usdc",
          async sponsor(operation) {
            return operation;
          },
        },
      ],
      { timeoutMs: 100, allowNativeEth: false },
    );
    expect(result.lane).toBe("external-usdc");
    expect(result.failedProviders).toEqual(["never-settles"]);
  });
});

describe("AA batch construction", () => {
  it("uses an independent nonce key and rejects native-value calls", async () => {
    const adapter: SmartAccountAdapter<Operation> = {
      name: "test-account",
      encodeCalls: vi.fn(() => "0x1234" as const),
      async buildUserOperation(args) {
        return args;
      },
    };
    const operation = await buildAccountBatch(
      adapter,
      [
        {
          to: "0x0000000000000000000000000000000000000001",
          data: "0xabcdef",
          value: 0n,
        },
      ],
      9n,
    );
    expect(operation).toEqual({ callData: "0x1234", nonceKey: 9n });
    await expect(
      buildAccountBatch(
        adapter,
        [
          {
            to: "0x0000000000000000000000000000000000000001",
            data: "0x",
            value: 1n,
          },
        ],
        0n,
      ),
    ).rejects.toThrow("cannot transfer native value");
  });
});
