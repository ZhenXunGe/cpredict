import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import {
  CANCEL_LISTING_SELECTOR,
  CREATE_LISTING_SELECTOR,
  SponsorPolicy,
} from "../src/policy.js";
import type {
  PackedUserOperationInput,
  SponsorAccountAdapter,
} from "../src/types.js";

const MARKET = getAddress("0x0000000000000000000000000000000000001000");
const BUY_SELECTOR = "0x12345678" as Hex;
const CREATE_LISTING_ABI = [
  {
    type: "function",
    name: "createListing",
    stateMutability: "nonpayable",
    inputs: [
      { name: "vault", type: "address" },
      { name: "outcomeId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "unitPrice", type: "uint256" },
      { name: "expiresAt", type: "uint64" },
    ],
    outputs: [{ name: "listingId", type: "bytes32" }],
  },
] as const;

function userOperation(): PackedUserOperationInput {
  return {
    sender: getAddress("0x0000000000000000000000000000000000002000"),
    nonce: 1n,
    initCode: "0x",
    callData: "0x01020304",
    accountGasLimits: `0x${"00".repeat(32)}`,
    preVerificationGas: 1n,
    gasFees: `0x${"00".repeat(32)}`,
    signature: "0x",
  };
}

function policy(
  target: Address,
  selector: Hex,
  value = 0n,
  operation: "createListing" | "cancelListing" | "other" = "other",
  data: Hex = selector === CREATE_LISTING_SELECTOR
    ? createListingData(1_000_000n)
    : (`${selector}00` as Hex),
): SponsorPolicy {
  const decoder: SponsorAccountAdapter = {
    ready: async () => undefined,
    decode: async () => [{ target, value, data }],
  };
  return new SponsorPolicy({
    decoder,
    allowedTargets: new Map([[MARKET, new Map([[selector, operation]])]]),
    maxCostPerRequest: 1_000n,
    maxInitCodeBytes: 1_024,
    maxCallDataBytes: 16_384,
    minSponsoredListingUnits: 1_000_000n,
  });
}

describe("sponsor policy", () => {
  it("accepts only configured target and selector", async () => {
    await expect(
      policy(MARKET, BUY_SELECTOR).validate(userOperation(), 100n),
    ).resolves.toEqual({
      operationCounts: { createListing: 0, cancelListing: 0 },
    });
    await expect(
      policy(
        getAddress("0x0000000000000000000000000000000000003000"),
        BUY_SELECTOR,
      ).validate(userOperation(), 100n),
    ).rejects.toThrow("not sponsored");
  });

  it("classifies every sponsored listing operation for atomic daily accounting", async () => {
    await expect(
      policy(MARKET, CREATE_LISTING_SELECTOR, 0n, "createListing").validate(
        userOperation(),
        100n,
      ),
    ).resolves.toEqual({
      operationCounts: { createListing: 1, cancelListing: 0 },
    });
    await expect(
      policy(MARKET, CANCEL_LISTING_SELECTOR, 0n, "cancelListing").validate(
        userOperation(),
        100n,
      ),
    ).resolves.toEqual({
      operationCounts: { createListing: 0, cancelListing: 1 },
    });
  });

  it("rejects sponsored createListing calls below the minimum or with malformed arguments", async () => {
    await expect(
      policy(
        MARKET,
        CREATE_LISTING_SELECTOR,
        0n,
        "createListing",
        createListingData(999_999n),
      ).validate(userOperation(), 100n),
    ).rejects.toThrow("below policy minimum");
    await expect(
      policy(
        MARKET,
        CREATE_LISTING_SELECTOR,
        0n,
        "createListing",
        `${CREATE_LISTING_SELECTOR}00` as Hex,
      ).validate(userOperation(), 100n),
    ).rejects.toThrow("malformed createListing calldata");
  });

  it("rejects an adapter that attempts to misclassify a quota-sensitive selector", () => {
    expect(() => policy(MARKET, CREATE_LISTING_SELECTOR, 0n, "other")).toThrow(
      "classification is inconsistent",
    );
    expect(() => policy(MARKET, BUY_SELECTOR, 0n, "createListing")).toThrow(
      "classification is inconsistent",
    );
  });

  it("rejects ETH value and excessive cost", async () => {
    await expect(
      policy(MARKET, BUY_SELECTOR, 1n).validate(userOperation(), 100n),
    ).rejects.toThrow();
    await expect(
      policy(MARKET, BUY_SELECTOR).validate(userOperation(), 1_001n),
    ).rejects.toThrow();
  });
});

function createListingData(amount: bigint): Hex {
  return encodeFunctionData({
    abi: CREATE_LISTING_ABI,
    functionName: "createListing",
    args: [MARKET, 0n, amount, 1_000_000n, 1_900_000_000n],
  });
}
