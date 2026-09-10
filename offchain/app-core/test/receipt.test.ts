import { describe, it, expect } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type TransactionReceipt,
} from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { operationEvent } from "../src/receipt.js";
import { ENTRY_POINT } from "../src/kernel.js";
import { A, H } from "./fixtures.js";
function log(n: number, success = true) {
  return {
    address: ENTRY_POINT.address,
    topics: encodeEventTopics({
      abi: entryPoint07Abi,
      eventName: "UserOperationEvent",
      args: { userOpHash: H(n), sender: A(11), paymaster: A(50) },
    }),
    data: encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "bool" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [7n, success, 30n, 20n],
    ),
  } as TransactionReceipt["logs"][number];
}
describe("canonical UserOperation execution evidence", () => {
  it("confirms first deployment without counting AccountDeployed as a second result", () => {
    const deployed = {
      address: ENTRY_POINT.address,
      topics: encodeEventTopics({
        abi: entryPoint07Abi,
        eventName: "AccountDeployed",
        args: { userOpHash: H(1), sender: A(11) },
      }),
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "address" }],
        [A(60), A(50)],
      ),
    } as TransactionReceipt["logs"][number];
    const expected = { hash: H(1), sender: A(11), nonce: 7n };
    for (const logs of [
      [deployed, log(1)],
      [log(1), deployed],
    ])
      expect(
        operationEvent({ status: "success", logs }, expected),
      ).toMatchObject({
        success: true,
        actualGasCost: 30n,
      });
    expect(() =>
      operationEvent({ status: "success", logs: [deployed] }, expected),
    ).toThrow();
  });
  it("reads the failed operation result alongside its revert-reason event", () => {
    const reason = {
      address: ENTRY_POINT.address,
      topics: encodeEventTopics({
        abi: entryPoint07Abi,
        eventName: "UserOperationRevertReason",
        args: { userOpHash: H(1), sender: A(11) },
      }),
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "bytes" }],
        [7n, "0x1234"],
      ),
    } as TransactionReceipt["logs"][number];
    expect(
      operationEvent(
        { status: "success", logs: [reason, log(1, false)] },
        { hash: H(1), sender: A(11), nonce: 7n },
      ),
    ).toMatchObject({ success: false, actualGasCost: 30n });
  });
  it("selects individual success and cost from a multi-operation bundle", () => {
    expect(
      operationEvent(
        { status: "success", logs: [log(1), log(2, false)] },
        { hash: H(2), sender: A(11), nonce: 7n },
      ),
    ).toMatchObject({ success: false, actualGasCost: 30n });
  });
  it("rejects a forged emitter, wrong sender, wrong nonce and duplicate events", () => {
    const expected = { hash: H(1), sender: A(11), nonce: 7n };
    for (const logs of [
      [{ ...log(1), address: A(99) }],
      [log(2)],
      [log(1), log(1)],
    ])
      expect(() =>
        operationEvent({ status: "success", logs }, expected),
      ).toThrow();
    expect(() =>
      operationEvent(
        { status: "success", logs: [log(1)] },
        { ...expected, sender: A(12) },
      ),
    ).toThrow();
    expect(() =>
      operationEvent(
        { status: "success", logs: [log(1)] },
        { ...expected, nonce: 8n },
      ),
    ).toThrow();
    expect(() =>
      operationEvent({ status: "reverted", logs: [log(1)] }, expected),
    ).toThrow();
  });
});
