import { expect, test } from "vitest";
import { entryPoint07Address } from "viem/account-abstraction";
import type { TransactionReceipt } from "viem";
import type {
  BusinessIntent,
  Operation,
} from "../../app-core/src/contracts.js";
import { A, H, env, operation } from "../../app-core/test/fixtures.js";
import {
  raw,
  trader,
  vault,
  listing,
  purchase,
  createMarket,
} from "./financial-fixtures.js";
import { verifiedOperationEvents } from "../src/operation-receipt.js";
import type { IndexedEvent } from "../src/store.js";

import { confirmed, receiptFor } from "./operation-receipt-fixtures.js";
const cases: {
  intent: BusinessIntent;
  name: string;
  contract: typeof vault;
  args: Record<string, unknown>;
}[] = [
  {
    intent: {
      kind: "create-listing",
      market: vault,
      outcomeId: "0",
      units: "40",
      unitPrice: "1250000",
      expiresAt: "9999",
    },
    name: "ListingCreated",
    contract: env.deployment.marketplace,
    args: {
      listingId: listing,
      vault,
      seller: trader,
      outcomeId: 0n,
      amount: 40n,
      unitPrice: 1250000n,
      expiresAt: 9999n,
      sellerNonce: 0n,
    },
  },
  {
    intent: {
      kind: "fill-listing",
      listingId: listing,
      units: "40",
      minUnits: "40",
      maxPayment: "50",
      deadline: "9999",
    },
    name: "ListingFilled",
    contract: env.deployment.marketplace,
    args: {
      listingId: listing,
      buyer: trader,
      seller: A(12),
      desiredUnits: 40n,
      filledUnits: 40n,
      gross: 50n,
      sellerProceeds: 48n,
      platformFee: 1n,
      creatorFee: 1n,
      remainingUnits: 0n,
    },
  },
  {
    intent: { kind: "cancel-listing", listingId: listing },
    name: "ListingCancelled",
    contract: env.deployment.marketplace,
    args: { listingId: listing, seller: trader, returnedUnits: 40n },
  },
  {
    intent: { kind: "return-listing", listingId: listing },
    name: "TerminalListingReturned",
    contract: env.deployment.marketplace,
    args: {
      listingId: listing,
      caller: trader,
      seller: A(12),
      returnedUnits: 40n,
    },
  },
  {
    intent: { kind: "claim-winner", market: vault },
    name: "WinnerClaimed",
    contract: vault,
    args: { owner: trader, caller: trader, burnedUnits: 40n, payout: 50n },
  },
  {
    intent: { kind: "claim-early-bird", market: vault },
    name: "EarlyBirdClaimed",
    contract: vault,
    args: { owner: trader, caller: trader, score: 40n, reward: 5n },
  },
  {
    intent: { kind: "refund", market: vault },
    name: "PrincipalRefunded",
    contract: vault,
    args: {
      owner: trader,
      caller: trader,
      burnedUnits: 40n,
      refund: 40n,
      timeoutEligibilityRecorded: true,
    },
  },
  {
    intent: { kind: "claim-timeout-bonus", market: vault },
    name: "TimeoutBonusClaimed",
    contract: vault,
    args: { owner: trader, caller: trader, units: 40n, reward: 5n },
  },
  {
    intent: { kind: "claim-fees" },
    name: "FeeClaimed",
    contract: env.deployment.feeVault,
    args: { beneficiary: trader, caller: trader, amount: 5n },
  },
  {
    intent: { kind: "claim-bond" },
    name: "BondClaimed",
    contract: env.deployment.bondEscrow,
    args: { creator: trader, caller: trader, amount: 5n },
  },
  {
    intent: { kind: "settle-bond-and-claim", market: vault },
    name: "BondClaimed",
    contract: env.deployment.bondEscrow,
    args: { creator: trader, caller: trader, amount: 5n },
  },
  {
    intent: {
      kind: "resolve",
      market: vault,
      outcomeId: "1",
      evidenceHash: H(50),
    },
    name: "MarketResolved",
    contract: vault,
    args: {
      winningOutcome: 1n,
      totalPrincipal: 100n,
      totalRake: 5n,
      protocolFee: 1n,
      creatorFee: 1n,
      earlyBirdPool: 3n,
      winnerPool: 95n,
      evidenceHash: H(50),
    },
  },
  {
    intent: { kind: "creator-void", market: vault, evidenceHash: H(50) },
    name: "MarketVoided",
    contract: vault,
    args: {
      reason: 1,
      caller: trader,
      refundPrincipal: 100n,
      evidenceHash: H(50),
    },
  },
  {
    intent: { kind: "void-timeout", market: vault },
    name: "MarketVoided",
    contract: vault,
    args: {
      reason: 3,
      caller: trader,
      refundPrincipal: 100n,
      evidenceHash: H(0),
    },
  },
];
test.each(cases)(
  "verifies $intent.kind and retains companion transfers",
  ({ intent, name, contract, args }) => {
    const op = confirmed(intent),
      events = [
        raw(name, contract, args, 3, 1),
        raw(
          "Transfer",
          env.deployment.paymentToken,
          { from: vault, to: trader, value: 5n },
          3,
          2,
        ),
      ];
    expect(
      verifiedOperationEvents(op, receiptFor(op, events), env, [vault]),
    ).toHaveLength(3);
    expect(() =>
      verifiedOperationEvents(op, receiptFor(op, events.slice(1)), env, [
        vault,
      ]),
    ).toThrow();
  },
);
test("supports primary purchase and an already-settled bond no-op", () => {
  const op = confirmed({
    kind: "buy",
    market: vault,
    outcomeId: "0",
    units: "100",
    minUnits: "100",
    maxPayment: "100",
    deadline: "9999",
  });
  expect(
    verifiedOperationEvents(op, receiptFor(op, purchase(3)), env, [vault]),
  ).toHaveLength(3);
  const settled = confirmed({ kind: "settle-bond", market: vault });
  expect(
    verifiedOperationEvents(settled, receiptFor(settled, []), env, [vault]),
  ).toHaveLength(1);
});
test("discovers a new market only from this factory and includes its initialization logs", () => {
  const intent: BusinessIntent = {
    kind: "create-market",
    userSalt: H(70),
    maxPayment: "100",
    params: {
      rulesHash: H(71),
      metadataURI: "https://example.com/rules",
      resolutionSourceHash: H(72),
      resolutionSourceURI: "https://example.com/source",
      outcomeCount: 2,
      closeAt: "2000",
      eventStartsAt: "0",
      outcomeDeadlineAt: "3000",
      creatorTreasury: trader,
      deploymentMode: 0,
      featureFlags: "0",
      creatorRakeBps: 500,
      creatorC2CFeeBps: 50,
      perUserPrimaryCap: "1000",
      marketPrimaryCap: "2000",
      minimumPrimaryUnits: "1",
      minimumC2CUnits: "1",
      creatorBond: "100",
    },
  };
  const op = { ...confirmed(intent), account: A(12) },
    events = createMarket(3);
  expect(
    verifiedOperationEvents(op, receiptFor(op, events), env, []),
  ).toHaveLength(3);
  const wrong = events.map((e) =>
    e.address === env.deployment.factory ? { ...e, address: A(999) } : e,
  );
  expect(() =>
    verifiedOperationEvents(op, receiptFor(op, wrong), env, []),
  ).toThrow();
});
test("rejects unrelated UserOperations, nonce, reverted, unknown, deployment and duplicated logs", () => {
  const c = cases[2]!,
    op = confirmed(c.intent),
    receipt = receiptFor(op, [raw(c.name, c.contract, c.args, 3, 1)]);
  for (const patch of [
    { nonce: "1" },
    { state: "unknown" as const },
    { account: A(88) },
    { deploymentId: "other" },
    { userOperationHash: H(9) },
  ])
    expect(() =>
      verifiedOperationEvents({ ...op, ...patch }, receipt, env, [vault]),
    ).toThrow();
  expect(() =>
    verifiedOperationEvents(op, { ...receipt, status: "reverted" }, env, [
      vault,
    ]),
  ).toThrow();
  expect(() =>
    verifiedOperationEvents(
      op,
      { ...receipt, logs: [...receipt.logs, receipt.logs[0]!] },
      env,
      [vault],
    ),
  ).toThrow();
  const failed = receiptFor(op, [raw(c.name, c.contract, c.args, 3, 1)]);
  failed.logs[1] = {
    ...failed.logs[1]!,
    ...raw(
      "UserOperationEvent",
      entryPoint07Address,
      {
        userOpHash: op.userOperationHash,
        sender: trader,
        nonce: 0n,
        paymaster: A(0),
        success: false,
        actualGasCost: 1n,
        actualGasUsed: 1n,
      },
      3,
      100,
    ),
  } as unknown as TransactionReceipt["logs"][number];
  expect(() => verifiedOperationEvents(op, failed, env, [vault])).toThrow();
});
test("never borrows evidence from a previous operation or an unregistered lookalike market", () => {
  const c = cases[4]!,
    op = confirmed(c.intent),
    event = raw(c.name, c.contract, c.args, 3, 1);
  const other = raw(
    "UserOperationEvent",
    entryPoint07Address,
    {
      userOpHash: H(999),
      sender: trader,
      nonce: 0n,
      paymaster: A(0),
      success: true,
      actualGasCost: 1n,
      actualGasUsed: 1n,
    },
    3,
    2,
  );
  expect(() =>
    verifiedOperationEvents(op, receiptFor(op, [event, other]), env, [vault]),
  ).toThrow();
  expect(() =>
    verifiedOperationEvents(op, receiptFor(op, [event]), env, []),
  ).toThrow();
});

test("includes tracked counterparties but does not mistake untracked internal transfers for missing account logs", () => {
  const op = confirmed({
    kind: "buy",
    market: vault,
    outcomeId: "0",
    units: "100",
    minUnits: "100",
    maxPayment: "100",
    deadline: "9999",
  });
  const events = [
    ...purchase(3),
    raw(
      "Transfer",
      env.deployment.paymentToken,
      { from: vault, to: env.deployment.feeVault, value: 1n },
      3,
      3,
    ),
    raw(
      "Transfer",
      env.deployment.paymentToken,
      { from: vault, to: A(12), value: 5n },
      3,
      4,
    ),
  ];
  expect(
    verifiedOperationEvents(op, receiptFor(op, events), env, [vault]),
  ).toHaveLength(3);
  expect(
    verifiedOperationEvents(op, receiptFor(op, events), env, [vault], [A(12)]),
  ).toHaveLength(4);
});
