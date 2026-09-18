import { decodeEventLog, zeroAddress, type TransactionReceipt } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import {
  sameAddress,
  type Environment,
  type Operation,
} from "../../app-core/src/contracts.js";
import { financialEventsAbi } from "./financial-facts.js";
import { normalizeLog, type IndexedEvent } from "./store.js";

/** A confirmed operation is a receipt lookup hint, never authority to invent a fill. */
export function verifiedPurchaseEvents(
  operation: Operation,
  receipt: TransactionReceipt,
  environment: Environment,
): IndexedEvent[] {
  const intent = operation.intent;
  if (
    operation.state !== "confirmed" ||
    intent.kind !== "buy" ||
    operation.environment !== environment.id ||
    operation.deploymentId !== environment.deployment.id ||
    !operation.transactionHash ||
    !operation.userOperationHash ||
    !operation.blockNumber ||
    !operation.blockHash ||
    receipt.status !== "success" ||
    receipt.transactionHash !== operation.transactionHash ||
    receipt.blockNumber !== BigInt(operation.blockNumber) ||
    receipt.blockHash !== operation.blockHash
  )
    throw new Error("purchase receipt does not match confirmed operation");
  const decoded = receipt.logs.map((log) => {
    if (
      log.removed ||
      log.blockHash !== receipt.blockHash ||
      log.blockNumber !== receipt.blockNumber ||
      log.transactionHash !== receipt.transactionHash
    )
      throw new Error("purchase receipt contains inconsistent logs");
    try {
      return {
        log,
        event: decodeEventLog({
          abi: financialEventsAbi,
          data: log.data,
          topics: log.topics,
        }),
      };
    } catch {
      return { log, event: null };
    }
  });
  const markers = decoded.filter(
    ({ log, event }) =>
      sameAddress(log.address, entryPoint07Address) &&
      event?.eventName === "UserOperationEvent",
  );
  const marker = markers.find(
    ({ event }) =>
      event?.eventName === "UserOperationEvent" &&
      event.args.userOpHash === operation.userOperationHash,
  );
  if (
    !marker ||
    marker.event?.eventName !== "UserOperationEvent" ||
    !marker.event.args.success ||
    !sameAddress(marker.event.args.sender, operation.account)
  )
    throw new Error("confirmed purchase user operation was not successful");
  const start = Math.max(
    -1,
    ...markers
      .filter((m) => m.log.logIndex < marker.log.logIndex)
      .map((m) => m.log.logIndex),
  );
  const segment = decoded.filter(
    ({ log }) => log.logIndex > start && log.logIndex <= marker.log.logIndex,
  );
  const purchases = segment.filter(
    ({ log, event }) =>
      sameAddress(log.address, intent.market) &&
      event?.eventName === "PrimaryPurchased",
  );
  const purchase = purchases[0]?.event;
  if (
    purchases.length !== 1 ||
    purchase?.eventName !== "PrimaryPurchased" ||
    !sameAddress(purchase.args.buyer, operation.account) ||
    purchase.args.outcomeId !== BigInt(intent.outcomeId) ||
    purchase.args.filledUnits <= 0n ||
    purchase.args.filledUnits < BigInt(intent.minUnits) ||
    purchase.args.filledUnits > BigInt(intent.units) ||
    purchase.args.payment > BigInt(intent.maxPayment)
  )
    throw new Error("purchase receipt fill does not match intent");
  const mints = segment.filter(
    ({ log, event }) =>
      sameAddress(log.address, intent.market) &&
      event?.eventName === "TransferSingle" &&
      sameAddress(event.args.from, zeroAddress) &&
      sameAddress(event.args.to, operation.account) &&
      event.args.id === BigInt(intent.outcomeId) &&
      event.args.value === purchase.args.filledUnits,
  );
  if (mints.length !== 1)
    throw new Error("purchase receipt share mint is missing");
  const selected = segment.filter(
    ({ log, event }) =>
      log === marker.log ||
      log === purchases[0]!.log ||
      log === mints[0]!.log ||
      (sameAddress(log.address, environment.deployment.paymentToken) &&
        event?.eventName === "Transfer" &&
        (sameAddress(event.args.from, operation.account) ||
          sameAddress(event.args.to, operation.account))),
  );
  return selected.map(({ log }) =>
    normalizeLog(environment.deployment.chainId, log, "confirmed"),
  );
}
