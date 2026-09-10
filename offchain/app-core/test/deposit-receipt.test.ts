import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type TransactionReceipt,
} from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { assertDepositTransfer } from "../src/receipt.js";
import { ENTRY_POINT } from "../src/kernel.js";
import { usdcAbi, USDC_ADDRESS } from "../src/usdc.js";
import { A, H } from "./fixtures.js";

const auth = {
  from: A(10),
  to: A(11),
  value: "1000000",
  validAfter: "0",
  validBefore: "2000000000",
  nonce: H(20),
};
const expected = {
  hash: H(1),
  sender: auth.to,
  nonce: 0n,
  authorization: auth,
};
const used = {
  address: USDC_ADDRESS,
  topics: encodeEventTopics({
    abi: usdcAbi,
    eventName: "AuthorizationUsed",
    args: { authorizer: auth.from, nonce: auth.nonce },
  }),
  data: "0x",
};
const transfer = {
  address: USDC_ADDRESS,
  topics: encodeEventTopics({
    abi: usdcAbi,
    eventName: "Transfer",
    args: { from: auth.from, to: auth.to },
  }),
  data: encodeAbiParameters([{ type: "uint256" }], [1000000n]),
};
const event = (hash = H(1), success = true) => ({
  address: ENTRY_POINT.address,
  topics: encodeEventTopics({
    abi: entryPoint07Abi,
    eventName: "UserOperationEvent",
    args: { userOpHash: hash, sender: auth.to, paymaster: A(90) },
  }),
  data: encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "bool" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [0n, success, 12n, 34n],
  ),
});
const receipt = (logs: unknown[]) =>
  ({ status: "success", logs }) as Pick<TransactionReceipt, "logs" | "status">;
const boundary = {
  address: ENTRY_POINT.address,
  topics: encodeEventTopics({
    abi: entryPoint07Abi,
    eventName: "BeforeExecution",
  }),
  data: "0x",
};
describe("USDC deposit receipt attribution", () => {
  it("accepts the exact authorization and transfer inside the matching operation", () => {
    expect(() =>
      assertDepositTransfer(
        receipt([boundary, used, transfer, event()]),
        expected,
      ),
    ).not.toThrow();
  });
  it.each([
    [transfer, event()],
    [used, event()],
    [used, transfer, event(H(2)), event()],
    [event(), used, transfer],
    [used, used, transfer, event()],
    [used, { ...transfer, address: A(5) }, event()],
    [
      used,
      { ...transfer, data: encodeAbiParameters([{ type: "uint256" }], [2n]) },
      event(),
    ],
    [used, transfer, event(H(1), false)],
    [
      used,
      transfer,
      {
        address: ENTRY_POINT.address,
        topics: encodeEventTopics({
          abi: entryPoint07Abi,
          eventName: "BeforeExecution",
        }),
        data: "0x",
      },
      event(),
    ],
  ])(
    "rejects incomplete, duplicate, wrong-value or out-of-operation evidence %#",
    (...logs) => {
      expect(() =>
        assertDepositTransfer(receipt([boundary, ...logs]), expected),
      ).toThrow();
    },
  );
  it("refuses partial receipts without an execution boundary", () => {
    expect(() =>
      assertDepositTransfer(receipt([used, transfer, event()]), expected),
    ).toThrow();
  });
});
