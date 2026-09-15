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
