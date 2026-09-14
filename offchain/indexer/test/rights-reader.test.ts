import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { A, env } from "../../app-core/test/fixtures.js";
import { OnchainRightsReader } from "../src/rights-reader.js";

describe("creator bond rights across protocol versions", () => {
  it.each([
    {
      protocol: "legacy-v1",
      state: 0,
      reason: 0,
      principal: 100n,
      returnable: false,
    },
    {
      protocol: "legacy-v1",
      state: 1,
      reason: 0,
      principal: 100n,
      returnable: true,
    },
    {
      protocol: "legacy-v1",
      state: 2,
      reason: 0,
      principal: 100n,
      returnable: true,
    },
    {
      protocol: "legacy-v1",
      state: 3,
      reason: 0,
      principal: 100n,
      returnable: false,
    },
    {
      protocol: "legacy-v1",
      state: 3,
      reason: 0,
      principal: 0n,
      returnable: true,
    },
    {
      protocol: "time-v2",
      state: 0,
      reason: 0,
      principal: 100n,
      returnable: false,
    },
    {
      protocol: "time-v2",
      state: 1,
      reason: 0,
      principal: 100n,
      returnable: true,
    },
    {
      protocol: "time-v2",
      state: 2,
      reason: 1,
      principal: 100n,
      returnable: true,
    },
    {
      protocol: "time-v2",
      state: 2,
      reason: 2,
      principal: 100n,
      returnable: true,
    },
    {
      protocol: "time-v2",
      state: 2,
      reason: 3,
      principal: 100n,
      returnable: false,
    },
    {
      protocol: "time-v2",
      state: 2,
      reason: 3,
      principal: 0n,
      returnable: true,
    },
  ] as const)(
    "classifies $protocol state $state reason $reason principal $principal",
    async (scenario) => {
      const readContract = vi.fn(
        async ({ functionName }: { functionName: string }) => {
          switch (functionName) {
            case "bondOf":
              return [A(11), 100n, false];
            case "marketState":
              return scenario.state;
            case "totalPrincipal":
              return scenario.principal;
            case "voidReason":
              if (scenario.protocol === "legacy-v1")
                throw new Error("legacy contract has no voidReason selector");
              return scenario.reason;
            default:
              throw new Error(`unexpected read: ${functionName}`);
          }
        },
      );
      const reader = new OnchainRightsReader(
        { readContract } as unknown as PublicClient,
        {
          ...env,
          deployment: { ...env.deployment, protocolVersion: scenario.protocol },
        },
        100n,
      );
      await expect(reader.bond(A(101), A(11))).resolves.toEqual({
        amount: 100n,
        settled: false,
        terminal: scenario.state !== 0,
        returnable: scenario.returnable,
      });
      if (scenario.protocol === "legacy-v1")
        expect(
          readContract.mock.calls.some(
            ([call]) => call.functionName === "voidReason",
          ),
        ).toBe(false);
      for (const [call] of readContract.mock.calls)
        expect(call).toMatchObject({ blockNumber: 100n });
    },
  );
});
