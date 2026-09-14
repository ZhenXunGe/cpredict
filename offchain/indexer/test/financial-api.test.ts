import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import { A, H, env } from "../../app-core/test/fixtures.js";
import {
  entitlementsResponseSchema,
  ledgerFactSchema,
  type LedgerFact,
  type LedgerSnapshot,
} from "../../app-core/src/ledger-contracts.js";
import { registerFinancialApi } from "../src/financial-api.js";
import type { PostgresFinancialLedger } from "../src/financial-store.js";

const snapshot: LedgerSnapshot = {
  environment: env.id,
  deploymentId: env.deployment.id,
  version: 1,
  epoch: "1",
  blockNumber: "100",
  blockHash: H(100),
  timestamp: "100",
  coverageStart: "1",
  complete: true,
  status: "active",
};
function fact(
  n: number,
  kind: LedgerFact["kind"],
  patch: Partial<LedgerFact>,
): LedgerFact {
  return ledgerFactSchema.parse({
    id: `f${n}`,
    kind,
    blockNumber: String(n),
    blockHash: H(n),
    transactionHash: H(n),
    transactionIndex: 0,
    logIndex: 0,
    factIndex: 0,
    timestamp: String(n),
    market: A(101),
    owner: A(11),
    counterparty: null,
    outcomeId: "0",
    listingId: null,
    units: null,
    amount: null,
    extra: {},
    ...patch,
  });
}

describe("entitlements pagination", () => {
  it.each([
    { state: 0, limit: 1 },
    { state: 2, limit: 1 },
    { state: 0, limit: 2 },
    { state: 2, limit: 2 },
  ])(
    "advances past a filtered early-bird with state $state and limit $limit",
    async ({ state, limit }) => {
      const facts = [
        fact(1, "primary-buy", {
          units: "100",
          amount: "100",
          extra: { score: "30" },
        }),
        fact(2, "share-transfer", { units: "100", counterparty: A(12) }),
        fact(3, "bond-locked", { market: A(102), amount: "100" }),
        ...(limit === 2
          ? [fact(4, "bond-locked", { market: A(100), amount: "100" })]
          : []),
      ];
      const ledger = {
        environment: env,
        snapshot: async () => snapshot,
        accountSnapshot: async () => snapshot,
        accountFacts: async () => facts,
        assertSnapshot: vi.fn(async () => {}),
      };
      const readContract = vi.fn(
        async ({
          address,
          functionName,
        }: {
          address: Address;
          functionName: string;
        }) => {
          switch (functionName) {
            case "marketState":
              return address === A(101) ? state : 1;
            case "voidReason":
              return address === A(101) && state === 2 ? 1 : 0;
            case "outcomeCount":
              return 2;
            case "winningOutcome":
              return 0;
            case "timeoutBonusFunded":
              return false;
            case "bondOf":
              return [A(11), 100n, false];
            default:
              return 0n;
          }
        },
      );
      const app = Fastify();
      registerFinancialApi(
        app,
        ledger as unknown as PostgresFinancialLedger,
        {
          readContract,
          getBlock: async () => ({ hash: snapshot.blockHash }),
        } as unknown as PublicClient,
        1n,
      );
      const url = `/v2/entitlements/${A(11)}?environment=${env.id}&deploymentId=${env.deployment.id}&limit=${limit}`;
      try {
        const first = await app.inject(url);
        expect(first.statusCode).toBe(200);
        const page = entitlementsResponseSchema.parse(first.json());
        expect(page.items).toHaveLength(limit - 1);
        expect(page.nextCursor).not.toBeNull();
        readContract.mockClear();
        const second = await app.inject(
          `${url}&cursor=${encodeURIComponent(page.nextCursor!)}`,
        );
        expect(second.statusCode).toBe(200);
        const next = entitlementsResponseSchema.parse(second.json());
        expect(next.items).toMatchObject([
          { market: A(102), kind: "bond", status: "claimable" },
        ]);
        expect(next.items).toHaveLength(1);
        expect(next.nextCursor).toBeNull();
        expect(next.snapshot).toEqual(page.snapshot);
        // The cursor must consume filtered candidates, not read them again.
        expect(
          readContract.mock.calls.some(([call]) => call.address === A(101)),
        ).toBe(false);
      } finally {
        await app.close();
      }
    },
  );
});
