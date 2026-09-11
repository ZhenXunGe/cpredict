import { describe, it, expect } from "vitest";
import { reconciliationChecks } from "../src/reconciliation.js";
import { normalizeFinancialFacts } from "../src/financial-facts.js";
import { A, env } from "../../app-core/test/fixtures.js";
import {
  block,
  createMarket,
  purchase,
  raw,
  vault,
  trader,
} from "./financial-fixtures.js";
function checks(events: ReturnType<typeof purchase>) {
  return reconciliationChecks(
    env,
    normalizeFinancialFacts(events, [block(1), block(2), block(3), block(4)], {
      environment: env,
      markets: new Set(),
      listings: new Map(),
      trackedAccounts: new Set([trader.toLowerCase()]),
    }),
    [trader],
  );
}
describe("independent ledger conservation reconciliation", () => {
  it("persists an opening-balance report without leaking internal bigint accumulators", () => {
    const result = reconciliationChecks(
      env,
      [],
      [trader],
      new Map([[trader.toLowerCase(), 1000n]]),
    );
    expect(() => JSON.stringify({ results: result })).not.toThrow();
    const saved = JSON.parse(JSON.stringify({ results: result }));
    expect(
      saved.results.find((row: { args: string[] }) => row.args[0] === trader)
        ?.expected,
    ).toBe("1000");
  });
  it("carries pre-deployment ctUSD into balance reconciliation without inventing historical trades", () => {
    const facts = normalizeFinancialFacts(
      [
        raw(
          "Transfer",
          env.deployment.paymentToken,
          { from: trader, to: A(90), value: 40n },
          2,
          0,
        ),
      ],
      [block(2)],
      {
        environment: env,
        markets: new Set(),
        listings: new Map(),
        trackedAccounts: new Set([trader.toLowerCase()]),
      },
    );
    const result = reconciliationChecks(
      env,
      facts,
      [trader],
      new Map([[trader.toLowerCase(), 100n]]),
    );
    expect(
      result.find(
        (row) =>
          row.contract.toLowerCase() ===
            env.deployment.paymentToken.toLowerCase() &&
          row.args[0] === trader,
      )?.expected,
    ).toBe("60");
    expect(facts).toHaveLength(1);
    expect(facts[0]!.kind).toBe("payment-transfer");
  });
  it("compares physical shares, fee liabilities, test-token transfers and winner payouts without repeating a mint", () => {
    const result = checks([
      ...createMarket(),
      ...purchase(),
      raw(
        "Transfer",
        env.deployment.paymentToken,
        { from: A(0), to: trader, value: 1000n },
        2,
        2,
      ),
      raw(
        "MarketResolved",
        vault,
        {
          winningOutcome: 0n,
          totalPrincipal: 100n,
          totalRake: 10n,
          protocolFee: 2n,
          creatorFee: 8n,
          earlyBirdPool: 5n,
          winnerPool: 85n,
          evidenceHash: "0x" + "1".repeat(64),
        },
        3,
        0,
      ),
      raw(
        "TransferSingle",
        vault,
        { operator: trader, from: trader, to: A(0), id: 0n, value: 100n },
        4,
        0,
      ),
      raw(
        "WinnerClaimed",
        vault,
        { owner: trader, caller: trader, burnedUnits: 100n, payout: 85n },
        4,
        1,
      ),
    ]);
    const find = (signature: string, contract = vault, args: string[] = []) =>
      result.find(
        (r) =>
          r.signature === signature &&
          r.contract.toLowerCase() === contract.toLowerCase() &&
          r.args.map(String).join() === args.join(),
      )?.expected;
    expect(
      find("function totalSupply(uint256) view returns(uint256)", vault, ["0"]),
    ).toBe("0");
    expect(find("function remainingWinnerPool() view returns(uint256)")).toBe(
      "0",
    );
    expect(
      find("function remainingEarlyBirdPool() view returns(uint256)"),
    ).toBe("5");
    expect(
      find(
        "function balanceOf(address) view returns(uint256)",
        env.deployment.paymentToken,
        [trader],
      ),
    ).toBe("1000");
    expect(
      find("function balanceOf(address,uint256) view returns(uint256)", vault, [
        trader,
        "0",
      ]),
    ).toBe("0");
  });
  it("refuses incomplete source movements instead of activating an apparently balanced ledger", () => {
    expect(() => checks([...createMarket(), purchase()[1]!])).toThrow(
      "reconciliation_coverage_gap",
    );
  });
});
