import type { Operation } from "../../../offchain/app-core/src/contracts.js";
import type { LedgerFact } from "../../../offchain/app-core/src/ledger-contracts.js";
import { SHARE_SCALE } from "../../../offchain/sdk/src/units.js";

export function listingTotal(
  units: string | null,
  price: unknown,
): string | null {
  return units !== null &&
    typeof price === "string" &&
    /^(0|[1-9]\d*)$/.test(price)
    ? ((BigInt(units) * BigInt(price)) / SHARE_SCALE).toString()
    : null;
}

export const businessFactKinds: Partial<
  Record<Operation["kind"], LedgerFact["kind"]>
> = {
  buy: "primary-buy",
  "create-listing": "listing-created",
  "claim-winner": "winner-claimed",
  "claim-early-bird": "early-bird-claimed",
  refund: "refunded",
  "claim-timeout-bonus": "timeout-claimed",
};

/** A bundler transaction can contain several operations from the same account.
 * Only the events preceding this operation's own completion marker belong to it. */
export function operationBusinessFacts(
  operation: Operation,
  facts: readonly LedgerFact[],
): LedgerFact[] {
  if (
    operation.state !== "confirmed" ||
    !operation.transactionHash ||
    !operation.userOperationHash
  )
    return [];
  const own = facts
    .filter(
      (f) =>
        f.transactionHash.toLowerCase() ===
          operation.transactionHash!.toLowerCase() &&
        f.owner?.toLowerCase() === operation.account.toLowerCase(),
    )
    .sort((a, b) => a.logIndex - b.logIndex || a.factIndex - b.factIndex);
  const marker = own.find(
    (f) =>
      f.kind === "user-operation" &&
      typeof f.extra.userOpHash === "string" &&
      f.extra.userOpHash.toLowerCase() ===
        operation.userOperationHash!.toLowerCase(),
  );
  if (!marker) return [];
  const previous = own
    .filter((f) => f.kind === "user-operation" && f.logIndex < marker.logIndex)
    .at(-1);
  return own.filter(
    (f) =>
      f.logIndex > (previous?.logIndex ?? -1) &&
      f.logIndex < marker.logIndex &&
      f.kind === businessFactKinds[operation.kind] &&
      (!("market" in operation.intent) ||
        f.market?.toLowerCase() === operation.intent.market.toLowerCase()),
  );
}
