import { entryPoint07Address } from "viem/account-abstraction";
import type { TransactionReceipt } from "viem";
import type {
  BusinessIntent,
  Operation,
} from "../../app-core/src/contracts.js";
import { A, H, env, operation } from "../../app-core/test/fixtures.js";
import {
  raw,
  trader,
  vault,
  listing,
  purchase,
  createMarket,
} from "./financial-fixtures.js";
import type { IndexedEvent } from "../src/store.js";

export function confirmed(intent: BusinessIntent, n = 3): Operation {
  return {
    ...operation,
    state: "confirmed",
    account: trader,
    kind: intent.kind,
    intent,
    transactionHash: H(n * 10),
    userOperationHash: H(n * 100),
    blockNumber: String(n),
    blockHash: H(n),
  };
}
export function receiptFor(
  op: Operation,
  events: IndexedEvent[],
): TransactionReceipt {
  const n = Number(op.blockNumber);
  return {
    status: "success",
    transactionHash: op.transactionHash,
    blockNumber: BigInt(n),
    blockHash: op.blockHash,
    logs: [
      ...events,
      raw(
        "UserOperationEvent",
        entryPoint07Address,
        {
          userOpHash: op.userOperationHash,
          sender: op.account,
          nonce: BigInt(op.nonce),
          paymaster: A(0),
          success: true,
          actualGasCost: 1n,
          actualGasUsed: 1n,
        },
        n,
        100,
      ),
    ].map((e) => ({ ...e, removed: false })),
  } as unknown as TransactionReceipt;
}
