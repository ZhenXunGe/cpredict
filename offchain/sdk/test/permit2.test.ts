import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  BUY_WITNESS_TYPE_STRING,
  BUY_WITH_PERMIT2_SELECTOR,
  buildBuyPermit2TypedData,
  buildFillPermit2TypedData,
  FILL_WITNESS_TYPE_STRING,
  FILL_WITH_PERMIT2_SELECTOR,
} from "../src/permit2.js";

const permit2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const owner = "0x00000000000000000000000000000000000000A1";
const vault = "0x00000000000000000000000000000000000000B1";
const marketplace = "0x00000000000000000000000000000000000000C1";
const authorization = {
  permitted: {
    token: "0x00000000000000000000000000000000000000D1",
    amount: 10_000_000n,
  },
  nonce: 7n,
  deadline: 1_900_000_000n,
} as const;

describe("canonical Permit2 witness typed data", () => {
  it("uses the exact canonical witness suffix expected by Permit2", () => {
    expect(BUY_WITNESS_TYPE_STRING).toBe(
      "BuyWitness witness)BuyWitness(address owner,address vault,bytes4 selector,uint256 outcomeId,uint256 desiredUnits,uint256 minUnits,uint256 maxPayment,uint64 callDeadline,uint256 chainId)TokenPermissions(address token,uint256 amount)",
    );
    expect(FILL_WITNESS_TYPE_STRING).toBe(
      "FillWitness witness)FillWitness(address buyer,address marketplace,bytes4 selector,bytes32 listingId,uint256 desiredUnits,uint256 minUnits,uint256 maxGross,uint64 callDeadline,uint256 chainId)TokenPermissions(address token,uint256 amount)",
    );
  });

  it("is signable and recoverable through a standard EIP-712 account", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const data = buildBuyPermit2TypedData(permit2, authorization, {
      owner,
      vault,
      selector: BUY_WITH_PERMIT2_SELECTOR,
      outcomeId: 1n,
      desiredUnits: 5_000_000n,
      minUnits: 4_000_000n,
      maxPayment: 5_000_000n,
      callDeadline: 1_800_000_000n,
      chainId: 421614n,
    });
    const signature = await account.signTypedData(data);
    await expect(recoverTypedDataAddress({ ...data, signature })).resolves.toBe(
      account.address,
    );
  });

  it("binds buy and fill to different spender, selector and witness domains", () => {
    const buy = buildBuyPermit2TypedData(permit2, authorization, {
      owner,
      vault,
      selector: BUY_WITH_PERMIT2_SELECTOR,
      outcomeId: 0n,
      desiredUnits: 1n,
      minUnits: 1n,
      maxPayment: 1n,
      callDeadline: 10n,
      chainId: 1n,
    });
    const fill = buildFillPermit2TypedData(permit2, authorization, {
      buyer: owner,
      marketplace,
      selector: FILL_WITH_PERMIT2_SELECTOR,
      listingId: `0x${"11".repeat(32)}`,
      desiredUnits: 1n,
      minUnits: 1n,
      maxGross: 1n,
      callDeadline: 10n,
      chainId: 1n,
    });
    expect(buy.message.spender).toBe(vault);
    expect(fill.message.spender).toBe(marketplace);
    expect(buy.witness).not.toBe(fill.witness);
    expect(buy.message.spender).not.toBe(zeroAddress);
  });
});
