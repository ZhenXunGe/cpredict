import type {
  AppAccount,
  BusinessIntent,
  Operation,
} from "../../../offchain/app-core/src/contracts.js";
import type {
  Entitlement,
  LedgerSnapshot,
} from "../../../offchain/app-core/src/ledger-contracts.js";

function entitlementAction(e: Entitlement): BusinessIntent | null {
  if (e.kind === "escrow" && e.listingId)
    return {
      kind:
        e.reason === "return_terminal_listing"
          ? "return-listing"
          : "cancel-listing",
      listingId: e.listingId,
    };
  if (e.kind === "bond")
    return e.market
      ? { kind: "settle-bond", market: e.market }
      : { kind: "claim-bond" };
  if (e.kind === "fees") return { kind: "claim-fees" };
  if (!e.market) return null;
  if (e.kind === "winner") return { kind: "claim-winner", market: e.market };
  if (e.kind === "early-bird")
    return { kind: "claim-early-bird", market: e.market };
  if (e.kind === "refund") return { kind: "refund", market: e.market };
  if (e.kind === "timeout-bonus")
    return { kind: "claim-timeout-bonus", market: e.market };
  return null;
}

export function entitlementIntent(e: Entitlement): BusinessIntent | null {
  return e.status === "claimable" ? entitlementAction(e) : null;
}

/** Include a just-registered modal operation before the next list poll, without
 * replacing a newer server reconciliation or crossing account/deployment scopes. */
export function entitlementOperations(
  account: AppAccount | null | undefined,
  records: readonly Operation[] = [],
  current: Operation | null = null,
): Operation[] {
  if (!account) return [];
  const scoped = (o: Operation) =>
    o.accountId === account.id &&
    o.account.toLowerCase() === account.address.toLowerCase() &&
    o.environment === account.environment &&
    o.deploymentId === account.deploymentId;
  const result = records.filter(scoped);
  if (current && scoped(current)) {
    const saved = result.find((o) => o.id === current.id);
    if (!saved || Date.parse(current.updatedAt) > Date.parse(saved.updatedAt))
      return [current, ...result.filter((o) => o.id !== current.id)];
  }
  return result;
}

export function snapshotIncludesOperation(
  snapshot: LedgerSnapshot | undefined,
  operation: Operation,
): boolean {
  if (
    !snapshot ||
    operation.blockNumber === null ||
    operation.blockHash === null ||
    operation.transactionHash === null ||
    snapshot.environment !== operation.environment ||
    snapshot.deploymentId !== operation.deploymentId
  )
    return false;
  const indexed = BigInt(snapshot.blockNumber),
    confirmed = BigInt(operation.blockNumber);
  return (
    indexed > confirmed ||
    (indexed === confirmed &&
      snapshot.blockHash.toLowerCase() === operation.blockHash.toLowerCase())
  );
}

function progressPhase(o: Operation, snapshot: LedgerSnapshot | undefined) {
  if (
    [
      "preparing",
      "awaiting-signature",
      "submitted",
      "confirming",
      "unknown",
    ].includes(o.state)
  )
    return "executing" as const;
  if (o.state === "confirmed" && !snapshotIncludesOperation(snapshot, o))
    return "syncing" as const;
  return null;
}

/** Poll each query against its own snapshot (including all loaded cursor pages),
 * never the global chain head. Keep a slower refresh for changes made elsewhere. */
export function entitlementRefreshInterval(
  operations: readonly Operation[],
  snapshots: readonly (LedgerSnapshot | undefined)[],
): number {
  return !snapshots.length ||
    snapshots.some((s) => !s || operations.some((o) => progressPhase(o, s)))
    ? 5000
    : 15000;
}

function actionKey(intent: BusinessIntent): string {
  if ("listingId" in intent) return `listing:${intent.listingId.toLowerCase()}`;
  return `${intent.kind}:${"market" in intent ? intent.market.toLowerCase() : "aggregate"}`;
}

export function entitlementProgress(
  e: Entitlement,
  operations: readonly Operation[],
  snapshot: LedgerSnapshot,
): { operation: Operation; phase: "executing" | "syncing" } | null {
  const action = entitlementAction(e);
  if (!action) return null;
  const key = actionKey(action);
  for (const operation of operations) {
    if (actionKey(operation.intent) !== key) continue;
    const phase = progressPhase(operation, snapshot);
    if (phase) return { operation, phase };
  }
  return null;
}
