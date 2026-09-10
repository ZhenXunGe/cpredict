import { describe, expect, it } from "vitest";
import { A, H, env } from "../../app-core/test/fixtures.js";
import { normalizeFinancialFacts } from "../src/financial-facts.js";
import {
  block,
  createMarket,
  purchase,
  raw,
  trader,
  seller,
  vault,
  listing,
} from "./financial-fixtures.js";
const context = {
  environment: env,
  markets: new Set([vault.toLowerCase()]),
  listings: new Map(),
  trackedAccounts: new Set([trader.toLowerCase()]),
};
describe("financial event normalization", () => {
  it("combines mint and primary purchase once, retaining the original early-bird score", () => {
    const facts = normalizeFinancialFacts(
      [...createMarket(), ...purchase()],
      [block(1), block(2)],
      context,
    );
    expect(facts.filter((f) => f.kind === "share-transfer")).toEqual([]);
    expect(facts.find((f) => f.kind === "primary-buy")).toMatchObject({
      units: "100",
      amount: "100",
      extra: { score: "300" },
    });
    expect(facts.filter((f) => f.kind === "coverage-gap")).toEqual([]);
  });
  it("keeps listing escrow separate and retains gross, seller net and both fees", () => {
    const events = [
      raw(
        "TransferSingle",
        vault,
        {
          operator: trader,
          from: trader,
          to: env.deployment.marketplace,
          id: 0n,
          value: 40n,
        },
        3,
        0,
      ),
      raw(
        "ListingCreated",
        env.deployment.marketplace,
        {
          listingId: listing,
          vault,
          seller: trader,
          outcomeId: 0n,
          amount: 40n,
          unitPrice: 1250000n,
          expiresAt: 900n,
          sellerNonce: 0n,
        },
        3,
        1,
      ),
      raw(
        "TransferSingle",
        vault,
        {
          operator: env.deployment.marketplace,
          from: env.deployment.marketplace,
          to: seller,
          id: 0n,
          value: 40n,
        },
        4,
        0,
      ),
      raw(
        "ListingFilled",
        env.deployment.marketplace,
        {
          listingId: listing,
          buyer: seller,
          seller: trader,
          desiredUnits: 40n,
          filledUnits: 40n,
          gross: 50n,
          sellerProceeds: 48n,
          platformFee: 1n,
          creatorFee: 1n,
          remainingUnits: 0n,
        },
        4,
        1,
      ),
    ];
    const facts = normalizeFinancialFacts(
      events,
      [block(3), block(4)],
      context,
    );
    expect(facts.map((f) => f.kind)).toEqual([
      "listing-created",
      "listing-filled",
    ]);
    expect(facts[1]).toMatchObject({
      amount: "50",
      owner: seller,
      counterparty: trader,
      extra: { sellerProceeds: "48", platformFee: "1", creatorFee: "1" },
    });
  });
  it("does not count the empty-timeout explanatory event as a second bond credit", () => {
    const events = [
      raw(
        "EmptyTimeoutBondCredited",
        env.deployment.bondEscrow,
        { market: vault, creator: trader, amount: 100n },
        3,
        0,
      ),
      raw(
        "BondCredited",
        env.deployment.bondEscrow,
        { market: vault, creator: trader, amount: 100n },
        3,
        1,
      ),
    ];
    expect(
      normalizeFinancialFacts(events, [block(3)], context).map((f) => [
        f.kind,
        f.amount,
      ]),
    ).toEqual([["bond-credited", "100"]]);
  });
  it("preserves aggregate fee claims and identifies missing share movement instead of inventing cost", () => {
    const events = [
      purchase()[1]!,
      raw(
        "FeeClaimed",
        env.deployment.feeVault,
        { beneficiary: trader, caller: seller, amount: 7n },
        3,
        0,
      ),
    ];
    const facts = normalizeFinancialFacts(
      events,
      [block(2), block(3)],
      context,
    );
    expect(facts.some((f) => f.kind === "coverage-gap")).toBe(true);
    expect(facts.find((f) => f.kind === "fee-claimed")).toMatchObject({
      market: null,
      amount: "7",
    });
  });
  it("includes only tracked payment accounts and keeps external transfers as explicit facts", () => {
    const events = [
      raw(
        "Transfer",
        env.deployment.paymentToken,
        { from: A(0), to: trader, value: 1000n },
        1,
        0,
      ),
      raw(
        "Transfer",
        env.deployment.paymentToken,
        { from: A(0), to: seller, value: 1000n },
        1,
        1,
      ),
      raw(
        "TransferSingle",
        vault,
        { operator: seller, from: seller, to: trader, id: 1n, value: 10n },
        1,
        2,
      ),
    ];
    const facts = normalizeFinancialFacts(events, [block(1)], context);
    expect(facts.map((f) => f.kind)).toEqual([
      "payment-transfer",
      "share-transfer",
    ]);
    expect(facts[0]?.owner).toBeNull();
    expect(facts[1]?.units).toBe("10");
  });
});
