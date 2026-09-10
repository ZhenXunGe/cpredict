import {
  decodeEventLog,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { AppError, sameAddress } from "./contracts.js";
import { ENTRY_POINT } from "./kernel.js";

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
