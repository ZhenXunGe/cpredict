import {
  A,
  H,
  appAccount,
  operation,
} from "../../../../offchain/app-core/test/fixtures.js";
import { operationSchema } from "../../../../offchain/app-core/src/contracts.js";
import { ledgerFactSchema } from "../../../../offchain/app-core/src/ledger-contracts.js";
const intents: import("../../../../offchain/app-core/src/contracts.js").BusinessIntent[] =
  [
    {
      kind: "buy",
      market: A(101),
      outcomeId: "0",
      units: "2500000",
      minUnits: "1000000",
      maxPayment: "2500000",
      deadline: "1999999999",
    },
    {
      kind: "create-listing",
      market: A(101),
      outcomeId: "1",
      units: "2500000",
      unitPrice: "1500000",
      expiresAt: "1999999999",
    },
    {
      kind: "fill-listing",
      listingId: H(55),
      units: "2500000",
      minUnits: "1000000",
      maxPayment: "3750000",
      deadline: "1999999999",
    },
  ];
intents.push({ kind: "cancel-listing", listingId: H(55) });
intents.push({ kind: "return-listing", listingId: H(56) });
const ops = intents.map((intent, i) =>
  operationSchema.parse({
    ...operation,
    id: `30000000-0000-4000-8000-00000000000${i + 1}`,
    intent,
    kind: intent.kind,
    state: "confirmed",
    transactionHash: H(201 + i),
    userOperationHash: H(301 + i),
    blockNumber: "100",
    blockHash: H(100),
    finality: "application-confirmed",
  }),
);
const facts = ops.map((o, i) =>
  ledgerFactSchema.parse({
    id: `feedback-fact-${i}`,
    kind: [
      "primary-buy",
      "listing-created",
      "listing-filled",
      "listing-cancelled",
      "listing-returned",
    ][i],
    blockNumber: "100",
    blockHash: H(100),
    transactionHash: o.transactionHash,
    transactionIndex: i,
    logIndex: 5,
    factIndex: 0,
    timestamp: "1789142400",
    market: A(101),
    owner: appAccount.address,
    counterparty: i === 2 ? A(99) : null,
    outcomeId: i === 0 ? "0" : "1",
    listingId: i === 0 ? null : i === 4 ? H(56) : H(55),
    units: i === 4 ? "750000" : i >= 2 ? "1250000" : "2500000",
    amount: i === 0 ? "2500000" : i === 2 ? "1875000" : null,
    extra:
      i === 1
        ? { unitPrice: "1500000" }
        : i === 2
          ? {
              gross: "1875000",
              sellerProceeds: "1800000",
              platformFee: "37500",
              creatorFee: "37500",
            }
          : {},
  }),
);
export function historyFeedbackResponse(url: URL, snapshot: unknown): unknown {
  const p = url.pathname;
  if (p === "/v1/operations") return { items: ops, nextCursor: null };
  if (p.startsWith("/v1/operations/"))
    return { operation: ops.find((o) => o.id === p.split("/").at(-1)) };
  if (p.startsWith("/v2/pnl/") && p.includes("/facts/"))
    return { items: [], snapshot };
  if (p.startsWith("/v2/activity/")) {
    const tx = url.searchParams.get("transactionHash");
    const i = ops.findIndex((o) => o.transactionHash === tx);
    return {
      items: tx
        ? i < 0
          ? []
          : [
              facts[i],
              {
                ...facts[i],
                id: `marker-${i}`,
                kind: "user-operation",
                market: null,
                outcomeId: null,
                listingId: null,
                units: null,
                logIndex: 6,
                extra: { userOpHash: ops[i]!.userOperationHash },
              },
            ]
        : facts,
      nextCursor: null,
      snapshot,
    };
  }
  return undefined;
}
