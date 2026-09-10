import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { readMarket } from "../src/protocol.js";

const address = "0x0000000000000000000000000000000000000001";
const fields = {
  creator: address,
  creatorTreasury: "0x0000000000000000000000000000000000000002",
  rulesHash: `0x${"ab".repeat(32)}`,
  outcomeCount: 2,
  createdAt: 1_000n,
  closeAt: 1_900n,
  eventStartsAt: 1_901n,
  outcomeDeadlineAt: 2_000n,
  featureFlags: 3n,
  perUserPrimaryCap: 100_000_000n,
  marketPrimaryCap: 500_000_000n,
  minimumPrimaryUnits: 10_000n,
  minimumC2CUnits: 20_000n,
  creatorBond: 10_000_000n,
  marketState: 2,
  voidReason: 2,
  winningOutcome: 0,
  totalPrincipal: 90_000_000n,
  resolutionDeadline: 2_800n,
  permit2Enabled: true,
  earlyBirdEnabled: true,
};

describe("market snapshot", () => {
  it("reads the target ABI at one block and preserves field and void-reason mappings", async () => {
    const multicall = vi.fn(
      async (request: { contracts: { functionName: string }[] }) =>
        request.contracts.map(({ functionName }) => {
          if (!(functionName in fields))
            throw new Error(`Unexpected getter: ${functionName}`);
          return fields[functionName as keyof typeof fields];
        }),
    );
    const client = {
      getBlock: vi.fn(async () => ({ number: 77n, timestamp: 2_000n })),
      multicall,
    } as unknown as PublicClient;
    expect(await readMarket(client, address)).toEqual({
      ...fields,
      address,
      observedAt: 2_000n,
    });
    expect(multicall).toHaveBeenCalledWith(
      expect.objectContaining({
        blockNumber: 77n,
        allowFailure: false,
      }),
    );
  });
});
