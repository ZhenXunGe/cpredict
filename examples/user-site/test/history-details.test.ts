import { expect, test } from "vitest";
import { A, H, operation } from "../../../offchain/app-core/test/fixtures.js";
import { ledgerFactSchema } from "../../../offchain/app-core/src/ledger-contracts.js";
import {
  listingTotal,
  operationBusinessFacts,
} from "../src/history-details.js";

const op = {
  ...operation,
  kind: "claim-winner" as const,
  intent: { kind: "claim-winner" as const, market: A(101) },
  state: "confirmed" as const,
  transactionHash: H(10),
  userOperationHash: H(20),
};
const fact = (logIndex: number, marker?: string) =>
  ledgerFactSchema.parse({
    id: `f-${logIndex}`,
    kind: marker ? "user-operation" : "winner-claimed",
    blockNumber: "10",
    blockHash: H(10),
    transactionHash: H(10),
    transactionIndex: 0,
    logIndex,
    factIndex: 0,
    timestamp: "1000",
    market: marker ? null : A(101),
    owner: op.account,
    counterparty: null,
    outcomeId: "0",
    listingId: null,
    units: "1000000",
    amount: "2500000",
    extra: marker ? { userOpHash: marker } : {},
  });
test("business facts are bounded by their own UserOperation marker, account and market", () => {
  const rows = [
    fact(1),
    fact(2, H(19)),
    fact(3),
    fact(4, H(20)),
    fact(5),
    fact(6, H(21)),
  ];
  expect(operationBusinessFacts(op, rows).map((f) => f.id)).toEqual(["f-3"]);
  expect(
    operationBusinessFacts(
      op,
      rows.filter((f) => f.id !== "f-4"),
    ),
  ).toEqual([]);
  expect(operationBusinessFacts({ ...op, state: "unknown" }, rows)).toEqual([]);
  expect(
    operationBusinessFacts(op, [{ ...fact(3), owner: A(99) }, fact(4, H(20))]),
  ).toEqual([]);
  expect(
    operationBusinessFacts(op, [{ ...fact(3), market: A(99) }, fact(4, H(20))]),
  ).toEqual([]);
});
test("listing totals use integer share scaling and retain missing price as unknown", () => {
  expect(listingTotal("2500000", "1500000")).toBe("3750000");
  expect(listingTotal("9007199254740993000000", "1500000")).toBe(
    "13510798882111489500000",
  );
  expect(listingTotal("1000001", "1")).toBe("1");
  expect(listingTotal("1000000", undefined)).toBeNull();
  expect(listingTotal("1000000", "invalid")).toBeNull();
});

test("C2C fills match their own listing and operation, including partial fills", () => {
  const fillOp = {
    ...op,
    kind: "fill-listing" as const,
    intent: {
      kind: "fill-listing" as const,
      listingId: H(55),
      units: "2500000",
      minUnits: "1000000",
      maxPayment: "3750000",
      deadline: "1999999999",
    },
  };
  const fill = {
    ...fact(3),
    kind: "listing-filled" as const,
    listingId: H(55),
    units: "1250000",
    amount: "1875000",
    extra: {
      gross: "1875000",
      sellerProceeds: "1800000",
      platformFee: "37500",
      creatorFee: "37500",
    },
  };
  expect(operationBusinessFacts(fillOp, [fill, fact(4, H(20))])).toEqual([
    fill,
  ]);
  expect(
    operationBusinessFacts(fillOp, [
      { ...fill, listingId: H(56) },
      fact(4, H(20)),
    ]),
  ).toEqual([]);
  expect(
    operationBusinessFacts({ ...fillOp, state: "reverted" }, [
      fill,
      fact(4, H(20)),
    ]),
  ).toEqual([]);
});

test("cancellation details use the exact returned units, excluding other listings and earlier fills", () => {
  const cancelOp = {
    ...op,
    kind: "cancel-listing" as const,
    intent: { kind: "cancel-listing" as const, listingId: H(55) },
  };
  const cancelled = {
    ...fact(3),
    kind: "listing-cancelled" as const,
    listingId: H(55),
    units: "1250000",
    amount: null,
  };
  const rows = [
    { ...cancelled, id: "earlier", logIndex: 1, units: "2500000" },
    fact(2, H(19)),
    { ...cancelled, id: "other-listing", listingId: H(56) },
    { ...cancelled, id: "fill", kind: "listing-filled" as const },
    cancelled,
    fact(4, H(20)),
  ];
  expect(operationBusinessFacts(cancelOp, rows)).toEqual([cancelled]);
  expect(listingTotal(cancelled.units, "1500000")).toBe("1875000");
  expect(listingTotal(cancelled.units, undefined)).toBeNull();
  expect(
    operationBusinessFacts({ ...cancelOp, state: "unknown" }, rows),
  ).toEqual([]);
  expect(
    operationBusinessFacts({ ...cancelOp, state: "reverted" }, rows),
  ).toEqual([]);
  expect(
    operationBusinessFacts(
      cancelOp,
      rows.filter((f) => f.kind !== "user-operation"),
    ),
  ).toEqual([]);
});

test("terminal returns match their exact operation and listing without claiming settlement proceeds", () => {
  const returnOp = {
    ...op,
    kind: "return-listing" as const,
    intent: { kind: "return-listing" as const, listingId: H(56) },
  };
  const returned = {
    ...fact(3),
    kind: "listing-returned" as const,
    listingId: H(56),
    units: "750000",
    amount: null,
  };
  const rows = [
    { ...returned, id: "earlier", logIndex: 1 },
    fact(2, H(19)),
    { ...returned, id: "other", listingId: H(55) },
    { ...returned, id: "cancel", kind: "listing-cancelled" as const },
    { ...returned, id: "foreign", owner: A(99) },
    returned,
    fact(4, H(20)),
  ];
  expect(operationBusinessFacts(returnOp, rows)).toEqual([returned]);
  expect(listingTotal(returned.units, "1500000")).toBe("1125000");
  expect(returned.amount).toBeNull();
  expect(
    operationBusinessFacts({ ...returnOp, state: "unknown" }, rows),
  ).toEqual([]);
  expect(
    operationBusinessFacts({ ...returnOp, state: "reverted" }, rows),
  ).toEqual([]);
  expect(
    operationBusinessFacts(
      returnOp,
      rows.filter((f) => f.kind !== "user-operation"),
    ),
  ).toEqual([]);
});
