import { describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import {
  readAccount,
  readProtocol,
  type MarketSnapshot,
} from "../src/protocol.js";

const ADDRESS = "0x0000000000000000000000000000000000001001";

describe("React development prop tracing", () => {
  it("does not expose primitive BigInt arrays in protocol or account snapshots", async () => {
    const protocol = await readProtocol(
      queuedClient([
        1n,
        2,
        3,
        4,
        5n,
        6n,
        7n,
        8,
        9,
        10n,
        11n,
        12n,
        13n,
        14,
      ]),
      ADDRESS,
      ADDRESS,
    );
    const account = await readAccount(
      queuedClient([0n, 0n, 0n, 0n, 0n, false, 0n, 0n, 2_000_000n, 0n]),
      ADDRESS,
      { address: ADDRESS, outcomeCount: 2 } as unknown as MarketSnapshot,
      ADDRESS,
      ADDRESS,
      ADDRESS,
      ADDRESS,
    );

    expect(protocol.paymasterBudgets).toEqual({
      operation: 11n,
      userDay: 12n,
      globalDay: 13n,
    });
    expect(account.positions).toEqual([
      { outcomeId: 0, balance: 2_000_000n },
      { outcomeId: 1, balance: 0n },
    ]);
    expect(() => assertNoPrimitiveBigIntArrays({ protocol, account })).not.toThrow();
  });
});

function queuedClient(values: unknown[]): PublicClient {
  const queue = [...values];
  return {
    readContract: vi.fn(async () => queue.shift()),
  } as unknown as PublicClient;
}

function assertNoPrimitiveBigIntArrays(value: unknown): void {
  if (Array.isArray(value)) {
    if (value.some((item) => typeof item === "bigint")) {
      throw new TypeError("React development tracing cannot serialize bigint[]");
    }
    value.forEach(assertNoPrimitiveBigIntArrays);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  Object.values(value).forEach(assertNoPrimitiveBigIntArrays);
}
