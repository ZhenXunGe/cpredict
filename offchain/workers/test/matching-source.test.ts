import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import type { Sql } from "postgres";
import { A, env } from "../../app-core/test/fixtures.js";
import { MatchingSource } from "../src/matching-source.js";

async function collect(source: MatchingSource) {
  const actions = [];
  for await (const action of source.candidates()) actions.push(action);
  return actions;
}

describe("matching source scan cadence", () => {
  it("polls the database watermark every tick but performs chain scans only on changes or maintenance", async () => {
    let revision = {
        block_number: "10",
        transaction_hash: "0x10",
        transaction_index: 0,
        log_index: 1,
      },
      now = 1000,
      fullScans = 0;
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("ORDER BY block_number DESC")) return [revision];
      fullScans++;
      return [];
    }) as unknown as Sql;
    const client = {
      getBlock: vi.fn(async () => ({ number: 10n, timestamp: 1000n })),
    } as unknown as PublicClient;
    const environment = {
      ...env,
      deployment: {
        ...env.deployment,
        marketplaceVersion: "orderbook-v2" as const,
        marketplace: A(80),
      },
    };
    const source = new MatchingSource(sql, client, environment, () => now);

    expect(await collect(source)).toEqual([]);
    expect(await collect(source)).toEqual([]);
    expect(fullScans).toBe(1);
    expect(client.getBlock).toHaveBeenCalledTimes(1);

    now += 30000;
    expect(await collect(source)).toEqual([]);
    expect(fullScans).toBe(2);

    revision = {
      block_number: "11",
      transaction_hash: "0x11",
      transaction_index: 0,
      log_index: 0,
    };
    now += 2000;
    expect(await collect(source)).toEqual([]);
    expect(fullScans).toBe(3);
    expect(client.getBlock).toHaveBeenCalledTimes(3);
  });

  it("does not cache a failed chain scan", async () => {
    const sql = (async (strings: TemplateStringsArray) =>
      strings.join("").includes("ORDER BY block_number DESC")
        ? [
            {
              block_number: "10",
              transaction_hash: "0x10",
              transaction_index: 0,
              log_index: 1,
            },
          ]
        : []) as unknown as Sql;
    const client = {
      getBlock: vi
        .fn()
        .mockRejectedValueOnce(new Error("rpc unavailable"))
        .mockResolvedValueOnce({ number: 10n, timestamp: 1000n }),
    } as unknown as PublicClient;
    const source = new MatchingSource(sql, client, {
      ...env,
      deployment: {
        ...env.deployment,
        marketplaceVersion: "orderbook-v2" as const,
        marketplace: A(80),
      },
    });

    await expect(collect(source)).rejects.toThrow("rpc unavailable");
    await expect(collect(source)).resolves.toEqual([]);
    expect(client.getBlock).toHaveBeenCalledTimes(2);
  });

  it("keeps unconsumed candidates available when the one-transaction worker stops early", async () => {
    let fullScans = 0;
    const sql = (async (strings: TemplateStringsArray) => {
      if (strings.join("").includes("ORDER BY block_number DESC"))
        return [
          {
            block_number: "10",
            transaction_hash: "0x10",
            transaction_index: 0,
            log_index: 1,
          },
        ];
      fullScans++;
      return [{ order_id: "1" }, { order_id: "2" }];
    }) as unknown as Sql;
    const client = {
      getBlock: vi.fn(async () => ({ number: 10n, timestamp: 1000n })),
      readContract: vi.fn(
        async ({
          functionName,
          args,
        }: {
          functionName: string;
          args: readonly bigint[];
        }) =>
          functionName === "orders"
            ? [
                A(Number(args[0]) + 100),
                A(10),
                10000n,
                1000000n,
                999n,
                0,
                1,
                true,
                true,
                0n,
              ]
            : false,
      ),
    } as unknown as PublicClient;
    const source = new MatchingSource(sql, client, {
      ...env,
      deployment: {
        ...env.deployment,
        marketplaceVersion: "orderbook-v2" as const,
        marketplace: A(80),
      },
    });
    const firstPass = source.candidates()[Symbol.asyncIterator]();
    expect((await firstPass.next()).value?.key).toBe("release-order:1");
    await firstPass.return?.();
    expect((await collect(source)).map((action) => action.key)).toEqual([
      "release-order:2",
    ]);
    expect(fullScans).toBe(1);
    expect(await collect(source)).toEqual([]);
  });
});
