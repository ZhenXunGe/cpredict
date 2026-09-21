import { describe, it, expect } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import { buildBusinessCalls, type AdmissionReader } from "../src/calls.js";
import { intentSchema } from "../src/contracts.js";
import { orderbookAbi, bidReserve } from "../../sdk/src/orderbook.js";
import { A, env } from "./fixtures.js";
const v2 = {
  ...env,
  deployment: {
    ...env.deployment,
    marketplaceVersion: "orderbook-v2" as const,
  },
};
const reader: AdmissionReader = {
  registeredMarket: async () => true,
  verifiedRules: async () => true,
  creationPayment: async () => 0n,
  listing: async () => ({ market: A(20), seller: A(10), active: true }),
  order: async () => ({
    market: A(20),
    owner: A(21),
    side: 0,
    outcomeId: 1,
    active: true,
  }),
};
describe("V2 order intents", () => {
  it("defaults matching on and reserves exact rounded funds with zeroed approvals", async () => {
    const intent = intentSchema.parse({
      kind: "create-order",
      market: A(20),
      side: "bid",
      outcomeId: "1",
      units: "1000001",
      unitPrice: "333333",
      expiresAt: "2000",
    });
    expect(intent).toMatchObject({ autoMatch: true });
    const calls = await buildBusinessCalls(v2, A(10), intent, reader, 1000n);
    expect(calls).toHaveLength(4);
    expect(
      decodeFunctionData({ abi: erc20Abi, data: calls[1]!.data }).args?.[1],
    ).toBe(bidReserve(1000001n, 333333n));
    expect(
      decodeFunctionData({ abi: orderbookAbi, data: calls[2]!.data }),
    ).toMatchObject({
      functionName: "createOrder",
      args: [A(20), 1, 0, 1000001n, 333333n, 2000n, true],
    });
    expect(
      decodeFunctionData({ abi: erc20Abi, data: calls[3]!.data }).args?.[1],
    ).toBe(0n);
  });
  it("sell to bid grants only temporary share approval and side mismatch is rejected", async () => {
    const intent = {
      kind: "fill-order" as const,
      orderId: "1",
      side: "bid" as const,
      units: "1000000",
      minUnits: "1000000",
      paymentLimit: "400000",
      deadline: "1200",
    };
    const calls = await buildBusinessCalls(v2, A(10), intent, reader, 1000n);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.to).toBe(A(20));
    expect(calls[1]!.to).toBe(env.deployment.marketplace);
    await expect(
      buildBusinessCalls(v2, A(10), { ...intent, side: "ask" }, reader, 1000n),
    ).rejects.toThrow();
  });
  it("keeps old/new protocols separate and exits require ownership", async () => {
    await expect(
      buildBusinessCalls(
        env,
        A(10),
        { kind: "cancel-order", orderId: "1" },
        reader,
        1000n,
      ),
    ).rejects.toThrow();
    await expect(
      buildBusinessCalls(
        v2,
        A(10),
        { kind: "cancel-order", orderId: "1" },
        reader,
        1000n,
      ),
    ).rejects.toThrow();
    const mine = {
      ...reader,
      order: async () => ({
        market: A(20),
        owner: A(10),
        side: 0,
        outcomeId: 1,
        active: true,
      }),
    };
    expect(
      await buildBusinessCalls(
        { ...v2, features: { ...v2.features, newExposure: false } },
        A(10),
        { kind: "cancel-order", orderId: "1" },
        mine,
        1000n,
      ),
    ).toHaveLength(1);
  });
});
