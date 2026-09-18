import {
  decodeEventLog,
  toEventSelector,
  type Address,
  type TransactionReceipt,
} from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import {
  sameAddress,
  type Environment,
  type Operation,
} from "../../app-core/src/contracts.js";
import { financialEventsAbi } from "./financial-facts.js";
import { verifiedPurchaseEvents } from "./purchase-receipt.js";
import { normalizeLog, type IndexedEvent } from "./store.js";

export const reconciledOperationKinds = [
  "buy",
  "create-market",
  "create-listing",
  "fill-listing",
  "cancel-listing",
  "return-listing",
  "resolve",
  "creator-void",
  "void-timeout",
  "claim-winner",
  "claim-early-bird",
  "refund",
  "claim-timeout-bonus",
  "settle-bond",
  "settle-bond-and-claim",
  "claim-bond",
  "claim-fees",
] as const;

/** Only successful, exact UserOperation receipt segments from this deployment are evidence. */
export function verifiedOperationEvents(
  op: Operation,
  receipt: TransactionReceipt,
  env: Environment,
  registeredMarkets: readonly Address[],
  trackedAccounts: readonly Address[] = [],
): IndexedEvent[] {
  const intent = op.intent,
    d = env.deployment;
  if (
    !reconciledOperationKinds.some((k) => k === op.kind) ||
    op.kind !== intent.kind ||
    op.state !== "confirmed" ||
    op.environment !== env.id ||
    op.deploymentId !== d.id ||
    !op.transactionHash ||
    !op.userOperationHash ||
    !op.blockNumber ||
    !op.blockHash ||
    receipt.status !== "success" ||
    receipt.transactionHash !== op.transactionHash ||
    receipt.blockHash !== op.blockHash ||
    receipt.blockNumber !== BigInt(op.blockNumber)
  )
    throw new Error("operation_receipt_mismatch");
  const logs = [...receipt.logs].sort((a, b) => a.logIndex - b.logIndex);
  if (
    new Set(logs.map((l) => l.logIndex)).size !== logs.length ||
    logs.some(
      (l) =>
        l.removed ||
        l.blockNumber !== receipt.blockNumber ||
        l.blockHash !== receipt.blockHash ||
        l.transactionHash !== receipt.transactionHash,
    )
  )
    throw new Error("operation_receipt_inconsistent");
  const decoded = logs.map((log) => {
    try {
      const event = decodeEventLog({
        abi: financialEventsAbi,
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      return {
        log,
        name: event.eventName as string,
        args: event.args as Record<string, unknown>,
      };
    } catch {
      return { log, name: "", args: {} as Record<string, unknown> };
    }
  });
  const markers = decoded.filter(
    (e) =>
      sameAddress(e.log.address, entryPoint07Address) &&
      e.name === "UserOperationEvent",
  );
  const matches = markers.filter(
    (e) => e.args.userOpHash === op.userOperationHash,
  );
  const marker = matches[0];
  if (
    matches.length !== 1 ||
    !marker ||
    marker.args.success !== true ||
    !sameAddress(marker.args.sender as Address, op.account) ||
    marker.args.nonce !== BigInt(op.nonce)
  )
    throw new Error("operation_userop_mismatch");
  const start = Math.max(
    -1,
    ...logs
      .filter(
        (l) =>
          sameAddress(l.address, entryPoint07Address) &&
          l.topics[0] === toEventSelector("BeforeExecution()") &&
          l.logIndex < marker.log.logIndex,
      )
      .map((l) => l.logIndex),
    ...markers
      .filter((m) => m.log.logIndex < marker.log.logIndex)
      .map((m) => m.log.logIndex),
  );
  const segment = decoded.filter(
    (e) => e.log.logIndex > start && e.log.logIndex <= marker.log.logIndex,
  );
  const markets = new Set(registeredMarkets.map((m) => m.toLowerCase()));
  if (intent.kind === "create-market") {
    const created = segment.filter(
      (e) =>
        sameAddress(e.log.address, d.factory) &&
        e.name === "MarketCreated" &&
        sameAddress(e.args.creator as Address, op.account),
    );
    if (created.length !== 1) throw new Error("operation_creation_missing");
    markets.add((created[0]!.args.market as string).toLowerCase());
  }
  const core = new Set(
    [d.factory, d.marketplace, d.feeVault, d.bondEscrow].map((a) =>
      a.toLowerCase(),
    ),
  );
  const accounts = new Set(
    [op.account, ...trackedAccounts].map((a) => a.toLowerCase()),
  );
  const selected = segment.filter(
    (e) =>
      e === marker ||
      (e.name &&
        (core.has(e.log.address.toLowerCase()) ||
          markets.has(e.log.address.toLowerCase()) ||
          (sameAddress(e.log.address, d.paymentToken) &&
            e.name === "Transfer" &&
            (accounts.has(String(e.args.from).toLowerCase()) ||
              accounts.has(String(e.args.to).toLowerCase()))))),
  );
  const has = (
    contract: Address,
    name: string,
    fields: Record<string, unknown> = {},
  ) =>
    selected.some(
      (e) =>
        sameAddress(e.log.address, contract) &&
        e.name === name &&
        Object.entries(fields).every(([key, value]) =>
          typeof value === "string" && typeof e.args[key] === "string"
            ? value.toLowerCase() === (e.args[key] as string).toLowerCase()
            : value === e.args[key],
        ),
    );
  let valid = false;
  switch (intent.kind) {
    case "buy":
      verifiedPurchaseEvents(op, receipt, env);
      valid = true;
      break;
    case "create-market":
      valid = true;
      break;
    case "create-listing":
      valid = has(d.marketplace, "ListingCreated", {
        seller: op.account,
        vault: intent.market,
        outcomeId: BigInt(intent.outcomeId),
        amount: BigInt(intent.units),
        unitPrice: BigInt(intent.unitPrice),
        expiresAt: BigInt(intent.expiresAt),
      });
      break;
    case "fill-listing":
      valid = selected.some(
        (e) =>
          sameAddress(e.log.address, d.marketplace) &&
          e.name === "ListingFilled" &&
          e.args.listingId === intent.listingId &&
          sameAddress(e.args.buyer as Address, op.account) &&
          (e.args.filledUnits as bigint) >= BigInt(intent.minUnits) &&
          (e.args.filledUnits as bigint) <= BigInt(intent.units) &&
          (e.args.gross as bigint) <= BigInt(intent.maxPayment),
      );
      break;
    case "cancel-listing":
      valid = has(d.marketplace, "ListingCancelled", {
        listingId: intent.listingId,
        seller: op.account,
      });
      break;
    case "return-listing":
      valid = has(d.marketplace, "TerminalListingReturned", {
        listingId: intent.listingId,
        caller: op.account,
      });
      break;
    case "claim-winner":
      valid = has(intent.market, "WinnerClaimed", { owner: op.account });
      break;
    case "claim-early-bird":
      valid = has(intent.market, "EarlyBirdClaimed", { owner: op.account });
      break;
    case "refund":
      valid = has(intent.market, "PrincipalRefunded", { owner: op.account });
      break;
    case "claim-timeout-bonus":
      valid = has(intent.market, "TimeoutBonusClaimed", { owner: op.account });
      break;
    case "claim-bond":
      valid = has(d.bondEscrow, "BondClaimed", { creator: op.account });
      break;
    case "claim-fees":
      valid = has(d.feeVault, "FeeClaimed", { beneficiary: op.account });
      break;
    case "resolve":
      valid =
        has(intent.market, "MarketResolved", {
          winningOutcome: BigInt(intent.outcomeId),
          evidenceHash: intent.evidenceHash,
        }) || has(intent.market, "MarketVoided", { reason: 2 });
      break;
    case "creator-void":
      valid = has(intent.market, "MarketVoided", {
        reason: 1,
        caller: op.account,
        evidenceHash: intent.evidenceHash,
      });
      break;
    case "void-timeout":
      valid = has(intent.market, "MarketVoided", {
        reason: 3,
        caller: op.account,
      });
      break;
    // settle is deliberately idempotent on chain and may emit no new events.
    case "settle-bond":
      valid = markets.has(intent.market.toLowerCase());
      break;
    case "settle-bond-and-claim":
      valid =
        markets.has(intent.market.toLowerCase()) &&
        has(d.bondEscrow, "BondClaimed", { creator: op.account });
      break;
  }
  if (!valid) throw new Error("operation_effect_mismatch");
  return selected.map((e) => normalizeLog(d.chainId, e.log, "confirmed"));
}
