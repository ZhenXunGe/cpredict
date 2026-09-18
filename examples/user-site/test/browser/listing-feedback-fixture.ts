import {
  A,
  H,
  appAccount,
  operation,
} from "../../../../offchain/app-core/test/fixtures.js";
import { computePnl } from "../../../../offchain/app-core/src/pnl.js";
export function listingFeedbackResponse(
  url: URL,
  snapshot: unknown,
  market: object,
  mode: string,
): unknown {
  const p = url.pathname;
  const terminal = mode === "terminal";
  if (p === "/v1/operations")
    return {
      items:
        mode === "unknown"
          ? [
              {
                ...operation,
                kind: "cancel-listing",
                intent: { kind: "cancel-listing", listingId: H(55) },
                state: "unknown",
              },
            ]
          : [],
    };
  if (p.startsWith("/v2/markets/"))
    return { ...market, market: A(101), state: terminal ? 1 : 0 };
  if (p.startsWith("/v2/pnl/"))
    return {
      pnl: {
        ...computePnl(appAccount.address, [], { coverageComplete: true }),
        lots:
          mode === "missing-lot"
            ? []
            : [
                {
                  market: A(101),
                  outcomeId: "0",
                  units: "5000000",
                  escrowUnits: "3000000",
                  knownCost: "5000000",
                  costComplete: true,
                },
              ],
      },
      snapshot,
    };
  if (p.startsWith("/v2/entitlements/"))
    return {
      items: [55, 56].map((id, i) => ({
        id: `listing-${id}`,
        market: A(101),
        kind: "escrow",
        outcomeId: "0",
        listingId: H(id),
        units: i ? "2000000" : "1000000",
        amount: null,
        status: "claimable",
        reason: terminal
          ? "return_terminal_listing"
          : "cancel_listing_to_recover_shares",
      })),
      nextCursor: null,
      snapshot,
    };
}
