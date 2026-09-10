import {
  TransactionReceiptNotFoundError,
  type PublicClient,
  type Hex,
} from "viem";
import { z } from "zod";
import {
  AppError,
  hash,
  type Operation,
} from "../../app-core/src/contracts.js";
import { operationEvent } from "../../app-core/src/receipt.js";
import type { RpcTransport } from "./http.js";
import type { ApplicationStore } from "./store.js";

/** Reconciliation queries facts only. It has no code path that sends a UserOperation. */
export class OperationRecovery {
  constructor(
    private readonly store: ApplicationStore,
    private readonly client: PublicClient,
    private readonly bundler: RpcTransport,
    private readonly confirmations: number,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async refresh(operation: Operation): Promise<Operation> {
    const o = operation;
    if (
      o.userOperationHash === null &&
      ["preparing", "awaiting-signature"].includes(o.state) &&
      Date.parse(o.expiresAt) <= this.now().getTime()
    ) {
      return (
        await this.store.transition(o.id, ["preparing", "awaiting-signature"], {
          state: "cancelled",
          reason: "admission_expired_without_submission",
          updatedAt: this.now().toISOString(),
        })
      ).record.operation;
    }
    if (o.userOperationHash === null || o.finality === "finalized") return o;
    let transactionHash: Hex | null = o.transactionHash;
    if (transactionHash === null) {
      const result = await this.bundler.request("eth_getUserOperationReceipt", [
        o.userOperationHash,
      ]);
      if (result === null) {
        return (
          await this.store.transition(
            o.id,
            ["submitted", "unknown", "confirming"],
            { updatedAt: this.now().toISOString() },
          )
        ).record.operation;
      }
      const receipt = z
        .object({
          userOpHash: hash,
          receipt: z.object({ transactionHash: hash }),
        })
        .parse(result);
      if (
        receipt.userOpHash.toLowerCase() !== o.userOperationHash.toLowerCase()
      )
        throw new AppError("receipt_hash_mismatch", 503);
      transactionHash = receipt.receipt.transactionHash;
    }
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({
        hash: transactionHash,
      });
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError))
        throw new AppError("chain_query_unavailable", 503);
      return this.reorganized(o);
    }
    const event = operationEvent(receipt, {
      hash: o.userOperationHash,
      sender: o.account,
      nonce: BigInt(o.nonce),
    });
    const [head, block] = await Promise.all([
      this.client.getBlockNumber(),
      this.client.getBlock({ blockNumber: receipt.blockNumber }),
    ]);
    if (block.hash.toLowerCase() !== receipt.blockHash.toLowerCase())
      return this.reorganized(o);
    const enough = head >= receipt.blockNumber + BigInt(this.confirmations - 1);
    let finality: Operation["finality"] = enough
      ? "application-confirmed"
      : "pending";
    if (enough) {
      try {
        if (
          (await this.client.getBlock({ blockTag: "finalized" })).number >=
          receipt.blockNumber
        )
          finality = "finalized";
      } catch {
        /* RPCs without finalized tags do not imply finality. */
      }
    }
    return (
      await this.store.transition(
        o.id,
        ["submitted", "unknown", "confirming", "confirmed", "reverted"],
        {
          state: enough
            ? event.success
              ? "confirmed"
              : "reverted"
            : "confirming",
          finality,
          transactionHash,
          blockNumber: receipt.blockNumber.toString(),
          blockHash: receipt.blockHash,
          actualGasCost: event.actualGasCost.toString(),
          reason: enough && !event.success ? "user_operation_reverted" : null,
          updatedAt: this.now().toISOString(),
        },
      )
    ).record.operation;
  }
  private async reorganized(o: Operation): Promise<Operation> {
    return (
      await this.store.transition(
        o.id,
        ["submitted", "confirming", "confirmed", "reverted", "unknown"],
        {
          state: "unknown",
          finality: "pending",
          reason: "receipt_missing_or_reorganized",
          transactionHash: null,
          blockHash: null,
          blockNumber: null,
          actualGasCost: null,
          updatedAt: this.now().toISOString(),
        },
      )
    ).record.operation;
  }
  async tick(): Promise<void> {
    for (const item of await this.store.pending(50)) {
      try {
        await this.refresh(item.operation);
      } catch {
        /* Preserve known state and retry queries on the next bounded pass. */
      }
    }
  }
}
