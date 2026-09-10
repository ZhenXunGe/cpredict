import { describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  TransactionReceiptNotFoundError,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { type Operation } from "../../app-core/src/contracts.js";
import { ENTRY_POINT } from "../../app-core/src/kernel.js";
import { A, H, operation } from "../../app-core/test/fixtures.js";
import { OperationRecovery } from "../src/recovery.js";
import { MemoryApplicationStore } from "./memory-store.js";

function setup(patch: Partial<Operation> = {}, success = true) {
  const current = {
    ...operation,
    state: "unknown" as const,
    userOperationHash: H(1),
    ...patch,
  };
  const store = new MemoryApplicationStore();
  store.records.set(current.id, {
    operation: current,
    subject: "did:privy:test",
    idempotencyKey: "test",
    requestHash: H(9),
  });
  const receipt = {
    status: "success",
    transactionHash: H(2),
    blockHash: H(3),
    blockNumber: 20n,
    logs: [
      {
        address: ENTRY_POINT.address,
        topics: encodeEventTopics({
          abi: entryPoint07Abi,
          eventName: "UserOperationEvent",
          args: { userOpHash: H(1), sender: current.account, paymaster: A(50) },
        }),
        data: encodeAbiParameters(
          [
            { type: "uint256" },
            { type: "bool" },
            { type: "uint256" },
            { type: "uint256" },
          ],
          [BigInt(current.nonce), success, 30n, 20n],
        ),
      },
    ],
  } as unknown as TransactionReceipt;
  const rpc = {
    getTransactionReceipt: vi.fn().mockResolvedValue(receipt),
    getBlockNumber: vi.fn().mockResolvedValue(22n),
    getBlock: vi
      .fn()
      .mockImplementation(async (args: { blockTag?: string }) => {
        if (args.blockTag === "finalized") throw new Error("tag unavailable");
        return { hash: H(3), number: 20n };
      }),
  };
  const bundler = {
    request: vi
      .fn()
      .mockResolvedValue({
        userOpHash: H(1),
        success: true,
        receipt: { transactionHash: H(2) },
      }),
  };
  const recovery = new OperationRecovery(
    store,
    rpc as unknown as PublicClient,
    bundler,
    3,
    () => new Date("2026-09-09T00:06:00Z"),
  );
  return { current, store, rpc, bundler, recovery };
}

describe("operation recovery without replay", () => {
  it("uses individual execution evidence even when the provider claims success", async () => {
    const s = setup({}, false);
    expect(await s.recovery.refresh(s.current)).toMatchObject({
      state: "reverted",
      actualGasCost: "30",
      finality: "application-confirmed",
    });
    expect(s.bundler.request.mock.calls).toEqual([
      ["eth_getUserOperationReceipt", [H(1)]],
    ]);
  });
  it("continues querying an unknown accepted operation after its admission expires", async () => {
    const s = setup();
    s.bundler.request.mockResolvedValue(null);
    expect(await s.recovery.refresh(s.current)).toMatchObject({
      state: "unknown",
      userOperationHash: H(1),
    });
    expect(s.rpc.getTransactionReceipt).not.toHaveBeenCalled();
    expect(s.bundler.request.mock.calls).toEqual([
      ["eth_getUserOperationReceipt", [H(1)]],
    ]);
  });
  it("cancels an expired admission only when no operation has been submitted", async () => {
    const s = setup({ state: "awaiting-signature", userOperationHash: null });
    expect(await s.recovery.refresh(s.current)).toMatchObject({
      state: "cancelled",
      reason: "admission_expired_without_submission",
    });
    expect(s.bundler.request).not.toHaveBeenCalled();
    expect(s.rpc.getTransactionReceipt).not.toHaveBeenCalled();
  });
  it("preserves a confirmed result during a transport outage", async () => {
    const s = setup({
      state: "confirmed",
      transactionHash: H(2),
      finality: "application-confirmed",
    });
    s.rpc.getTransactionReceipt.mockRejectedValue(new Error("RPC offline"));
    const paused = await s.recovery.tick(() => true);
    expect(paused).toEqual({ attempted: 0, failed: 0 });
    await s.recovery.tick();
    expect((await s.store.operation(s.current.id))?.operation.state).toBe(
      "confirmed",
    );
    expect(s.bundler.request).not.toHaveBeenCalled();
  });
  it.each(["missing", "noncanonical"])(
    "reopens a confirmed result for a %s receipt and keeps its original operation hash",
    async (reason) => {
      const s = setup({
        state: "confirmed",
        transactionHash: H(2),
        finality: "application-confirmed",
        blockHash: H(3),
        blockNumber: "20",
        actualGasCost: "30",
      });
      if (reason === "missing")
        s.rpc.getTransactionReceipt.mockRejectedValue(
          new TransactionReceiptNotFoundError({ hash: H(2) }),
        );
      else s.rpc.getBlock.mockResolvedValue({ hash: H(4), number: 20n });
      expect(await s.recovery.refresh(s.current)).toMatchObject({
        state: "unknown",
        finality: "pending",
        transactionHash: null,
        blockHash: null,
        blockNumber: null,
        actualGasCost: null,
        userOperationHash: H(1),
      });
      expect(s.bundler.request).not.toHaveBeenCalled();
    },
  );
  it("does not accept an unrelated provider receipt", async () => {
    const s = setup();
    s.bundler.request.mockResolvedValue({
      userOpHash: H(99),
      receipt: { transactionHash: H(2) },
    });
    await expect(s.recovery.refresh(s.current)).rejects.toMatchObject({
      code: "receipt_hash_mismatch",
    });
    expect((await s.store.operation(s.current.id))?.operation.state).toBe(
      "unknown",
    );
    expect(s.rpc.getTransactionReceipt).not.toHaveBeenCalled();
  });
});
