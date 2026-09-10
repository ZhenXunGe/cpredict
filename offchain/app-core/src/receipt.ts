import {
  decodeEventLog,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { AppError, sameAddress } from "./contracts.js";
import { ENTRY_POINT } from "./kernel.js";
import { USDC_ADDRESS, usdcAbi, type ReceiveAuthorization } from "./usdc.js";

/** The bundle receipt is not the result of an individual UserOperation. */
export function operationEvent(
  receipt: Pick<TransactionReceipt, "logs" | "status">,
  expected: { hash: Hex; sender: Address; nonce: bigint },
) {
  const matches = receipt.logs.flatMap((log) => {
    if (!sameAddress(log.address, ENTRY_POINT.address)) return [];
    try {
      const event = decodeEventLog({
        abi: entryPoint07Abi,
        topics: log.topics,
        data: log.data,
      });
      // viem selects the event from topic[0]; its eventName option does not
      // filter runtime decoding. Deployment and revert logs share userOpHash.
      if (event.eventName !== "UserOperationEvent") return [];
      return event.args.userOpHash.toLowerCase() === expected.hash.toLowerCase()
        ? [event.args]
        : [];
    } catch {
      return [];
    }
  });
  const event = matches[0];
  if (
    receipt.status !== "success" ||
    matches.length !== 1 ||
    !event ||
    !sameAddress(event.sender, expected.sender) ||
    event.nonce !== expected.nonce
  ) {
    throw new AppError("user_operation_event_missing", 503);
  }
  return event;
}

/** Attribute token logs to this execution, never to another operation in the bundle. */
export function assertDepositTransfer(
  receipt: Pick<TransactionReceipt, "logs" | "status">,
  expected: {
    hash: Hex;
    sender: Address;
    nonce: bigint;
    authorization: ReceiveAuthorization;
  },
): void {
  const event = operationEvent(receipt, expected);
  if (
    !event.success ||
    !sameAddress(expected.authorization.to, expected.sender)
  )
    throw new AppError("deposit_transfer_unverified", 503);
  let start = -1,
    end = -1;
  for (let index = 0; index < receipt.logs.length; index++) {
    const log = receipt.logs[index]!;
    if (!sameAddress(log.address, ENTRY_POINT.address)) continue;
    try {
      const decoded = decodeEventLog({
        abi: entryPoint07Abi,
        topics: log.topics,
        data: log.data,
      });
      if (
        decoded.eventName === "UserOperationEvent" &&
        decoded.args.userOpHash.toLowerCase() === expected.hash.toLowerCase()
      ) {
        end = index;
        break;
      }
      if (
        decoded.eventName === "BeforeExecution" ||
        decoded.eventName === "UserOperationEvent"
      )
        start = index + 1;
    } catch {
      /* Non-event logs are not evidence. */
    }
  }
  if (start < 0 || end < 0)
    throw new AppError("deposit_transfer_unverified", 503);
  const auth = expected.authorization;
  let authorizations = 0,
    transfers = 0;
  for (const log of receipt.logs.slice(start, end < 0 ? start : end)) {
    if (!sameAddress(log.address, USDC_ADDRESS)) continue;
    try {
      const decoded = decodeEventLog({
        abi: usdcAbi,
        topics: log.topics,
        data: log.data,
      });
      if (
        decoded.eventName === "AuthorizationUsed" &&
        sameAddress(decoded.args.authorizer, auth.from) &&
        decoded.args.nonce.toLowerCase() === auth.nonce.toLowerCase()
      )
        authorizations++;
      if (
        decoded.eventName === "Transfer" &&
        sameAddress(decoded.args.from, auth.from) &&
        sameAddress(decoded.args.to, auth.to) &&
        decoded.args.value === BigInt(auth.value)
      )
        transfers++;
    } catch {
      /* A matching address without decoded matching data is insufficient. */
    }
  }
  if (end < 0 || authorizations !== 1 || transfers !== 1)
    throw new AppError("deposit_transfer_unverified", 503);
}
