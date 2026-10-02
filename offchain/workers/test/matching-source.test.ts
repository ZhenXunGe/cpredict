import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import type { Sql } from "postgres";
import { A, env } from "../../app-core/test/fixtures.js";
import { MatchingSource } from "../src/matching-source.js";
import type { PostgresAutomaticStore } from "../src/automatic-store.js";

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

  it("reads a market's terminal state once per pinned scan without changing cleanup order", async () => {
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
        : [{ order_id: "1" }, { order_id: "2" }]) as unknown as Sql;
    const client = {
      getBlock: vi.fn(async () => ({ number: 10n, timestamp: 1000n })),
      readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
        functionName === "orders"
          ? [A(100), A(10), 10000n, 1000000n, 999n, 0, 1, true, true, 0n]
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

    expect((await collect(source)).map((action) => action.key)).toEqual([
      "release-order:1",
      "release-order:2",
    ]);
    expect(
      vi
        .mocked(client.readContract)
        .mock.calls.filter(([args]) => args.functionName === "isTerminal"),
    ).toHaveLength(1);
  });

  it("puts entitlement-blocking terminal asks ahead of expired cleanup and filters quota-denied work", async () => {
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
        : [{ order_id: "1" }, { order_id: "2" }]) as unknown as Sql;
    const client = {
      getBlock: vi.fn(async () => ({ number: 10n, timestamp: 1000n })),
      readContract: vi.fn(
        async ({
          functionName,
          args,
          address,
        }: {
          functionName: string;
          args: readonly bigint[];
          address: string;
        }) =>
          functionName === "orders"
            ? [
                A(Number(args[0]) + 100),
                A(10),
                10000n,
                1000000n,
                args[0] === 1n ? 900n : 1100n,
                0,
                1,
                true,
                true,
                0n,
              ]
            : functionName === "isTerminal"
              ? address === A(102)
              : 0n,
      ),
    } as unknown as PublicClient;
    const quota = {
      cleanupQuota: vi.fn(async (action: { key: string }) =>
        action.key === "release-order:1"
          ? "cleanup_account_quota_exceeded"
          : null,
      ),
      status: vi.fn(async () => undefined),
    } as unknown as PostgresAutomaticStore;
    const environment = {
      ...env,
      deployment: {
        ...env.deployment,
        marketplaceVersion: "orderbook-v2" as const,
        marketplace: A(80),
      },
    };
    expect(
      (await collect(new MatchingSource(sql, client, environment))).map(
        (a) => a.key,
      ),
    ).toEqual(["release-order:2", "release-order:1"]);
    const source = new MatchingSource(
      sql,
      client,
      environment,
      Date.now,
      30000,
      quota,
    );
    expect((await collect(source)).map((a) => a.key)).toEqual([
      "release-order:2",
    ]);
    expect(quota.status).toHaveBeenCalledWith(
      A(10),
      "cleanup_account_quota_exceeded",
    );
    expect(quota.cleanupQuota).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "release-order:2",
        cleanupMarket: A(102),
        cleanupPriority: "terminal-blocking",
      }),
    );
  });
});

it("groups whole orders by quantity and only rereads changed orders; epoch invalidates cache", async () => {
  let block = 10,
    epoch = "1",
    partial = false,
    changed = [1, 2, 3],
    reads: number[] = [];
  const orders = new Map([
    [1, [A(101), A(11), 10n, 800000n, 99999n, 0, 1, true, true, 0n]],
    [2, [A(101), A(12), 5n, 1000000n, 99999n, 0, 0, true, true, 5n]],
    [3, [A(101), A(12), 10n, 1000000n, 99999n, 0, 0, true, true, 10n]],
  ]);
  const sql = (async (strings: TemplateStringsArray) => {
    const q = strings.join("");
    if (q.includes("ledger_environment")) return [{ epoch }];
    if (q.includes("ORDER BY block_number DESC"))
      return [
        {
          block_number: String(block),
          transaction_hash: `tx${block}`,
          transaction_index: 0,
          log_index: 1,
        },
      ];
    return changed.map((id) => ({ order_id: String(id) }));
  }) as unknown as Sql;
  const client = {
    getBlock: async () => ({ number: BigInt(block), timestamp: 1000n }),
    readContract: async ({
      functionName,
      args,
    }: {
      functionName: string;
      args: unknown[];
    }) => {
      if (functionName === "orders") {
        reads.push(Number(args[0]));
        return orders.get(Number(args[0]));
      }
      if (functionName === "orderAllowsPartialFills") return partial;
      if (functionName === "isTerminal") return false;
      if (functionName === "bestPartialOrder") return args[2] === 0 ? 3n : 1n;
      if (functionName === "bestOrderForUnits")
        return args[3] === 10n
          ? args[2] === 0
            ? 3n
            : 1n
          : args[2] === 0
            ? 2n
            : orders.has(4)
              ? 4n
              : 0n;
      throw Error(`unexpected ${functionName}`);
    },
  } as unknown as PublicClient;
  const source = new MatchingSource(sql, client, {
    ...env,
    deployment: {
      ...env.deployment,
      marketplaceVersion: "orderbook-v2",
      orderbookFillPolicyVersion: 1,
    },
  });
  expect((await collect(source)).map((a) => a.key)).toEqual([
    `match:${A(101)}:0:units:10`,
  ]);
  reads = [];
  changed = [2];
  block++;
  await collect(source);
  expect(reads.filter((id) => id === 2)).toHaveLength(1);
  expect(reads.filter((id) => id === 1)).toHaveLength(1); // matching head validation only
  changed = [1, 2, 3];
  epoch = "2";
  reads = [];
  await collect(source);
  expect(reads.filter((id) => id === 2)).toHaveLength(1);
  partial = true;
  epoch = "3";
  changed = [1, 2, 3, 4];
  orders.set(4, [A(101), A(11), 5n, 800000n, 99999n, 0, 1, true, true, 0n]);
  const first = source.candidates()[Symbol.asyncIterator]();
  expect((await first.next()).value?.key).toBe(`match:${A(101)}:0:units:5`);
  await first.return?.();
  block++;
  changed = [2];
  const next = await collect(source);
  expect(next[0]?.key).toBe(`match:${A(101)}:0:units:10`);
  expect(next.some((a) => a.key.endsWith(":partial"))).toBe(false);
});
