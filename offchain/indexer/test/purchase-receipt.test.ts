import { expect, test } from "vitest";
import { entryPoint07Address } from "viem/account-abstraction";
import type { TransactionReceipt } from "viem";
import { A, H, env, operation } from "../../app-core/test/fixtures.js";
import { block, purchase, raw, trader, vault } from "./financial-fixtures.js";
import { verifiedPurchaseEvents } from "../src/purchase-receipt.js";
export const confirmedPurchase = {
  ...operation,
  state: "confirmed" as const,
  account: trader,
  kind: "buy" as const,
  intent: {
    kind: "buy" as const,
    market: vault,
    outcomeId: "0",
    units: "100",
    minUnits: "100",
    maxPayment: "100",
    deadline: "99999",
  },
  transactionHash: H(20),
  userOperationHash: H(200),
  blockNumber: "2",
  blockHash: H(2),
};
export function purchaseReceipt(success = true): TransactionReceipt {
  const events = [
    ...purchase(),
    raw(
      "UserOperationEvent",
      entryPoint07Address,
      {
        userOpHash: H(200),
        sender: trader,
        paymaster: A(0),
        nonce: 0n,
        success,
        actualGasCost: 3n,
        actualGasUsed: 1n,
      },
      2,
      3,
    ),
  ];
  return {
    status: "success",
    transactionHash: H(20),
    blockNumber: 2n,
    blockHash: H(2),
    logs: events.map((e) => ({ ...e, removed: false })),
  } as unknown as TransactionReceipt;
}
test("recovers exact confirmed fill and mint from a receipt even if all range logs were absent", () => {
  expect(
    verifiedPurchaseEvents(confirmedPurchase, purchaseReceipt(), env),
  ).toHaveLength(3);
});
test("rejects failed inner UserOp, stale canonical reference, missing mint and outcome mismatch", () => {
  expect(() =>
    verifiedPurchaseEvents(confirmedPurchase, purchaseReceipt(false), env),
  ).toThrow();
  expect(() =>
    verifiedPurchaseEvents(
      confirmedPurchase,
      { ...purchaseReceipt(), blockHash: H(3) },
      env,
    ),
  ).toThrow();
  expect(() =>
    verifiedPurchaseEvents(
      confirmedPurchase,
      { ...purchaseReceipt(), logs: purchaseReceipt().logs.slice(1) },
      env,
    ),
  ).toThrow();
  expect(() =>
    verifiedPurchaseEvents(
      {
        ...confirmedPurchase,
        intent: { ...confirmedPurchase.intent, outcomeId: "1" },
      },
      purchaseReceipt(),
      env,
    ),
  ).toThrow();
});
test("does not treat other accounts, other deployments or unknown operations as successful", () => {
  expect(() =>
    verifiedPurchaseEvents(
      { ...confirmedPurchase, account: A(99) },
      purchaseReceipt(),
      env,
    ),
  ).toThrow();
  expect(() =>
    verifiedPurchaseEvents(
      { ...confirmedPurchase, deploymentId: "different" },
      purchaseReceipt(),
      env,
    ),
  ).toThrow();
  expect(() =>
    verifiedPurchaseEvents(
      { ...confirmedPurchase, state: "unknown" },
      purchaseReceipt(),
      env,
    ),
  ).toThrow();
});
