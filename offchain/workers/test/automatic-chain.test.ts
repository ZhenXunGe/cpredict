import { describe, expect, it, vi } from "vitest";
import {
  keccak256,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AutomationGasCapExceeded,
  type AutomaticAction,
} from "../src/automatic-claims.js";
import {
  automationGasLimit,
  ViemAutomationChain,
} from "../src/automatic-chain.js";

const account = privateKeyToAccount(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);
const action: AutomaticAction = {
  key: "match:test",
  owner: account.address,
  kind: "match-orders",
  target: "0x2222222222222222222222222222222222222222" as Address,
  data: "0x1234",
  requiresClaimPreference: false,
};

describe("keeper gas admission", () => {
  it("rounds the inclusion margin up and rejects invalid estimates", () => {
    expect(automationGasLimit(59841n)).toBe(77794n);
    expect(automationGasLimit(1n)).toBe(2n);
    expect(() => automationGasLimit(0n)).toThrow(
      "invalid_automation_gas_estimate",
    );
    expect(() => automationGasLimit(-1n)).toThrow(
      "invalid_automation_gas_estimate",
    );
  });
  it("checks the maximum transaction cost before signing", async () => {
    const raw = "0x123456" as const;
    const wallet = {
      chain: undefined,
      prepareTransactionRequest: vi.fn(async () => ({
        nonce: 1n,
        gas: 21n,
        maxFeePerGas: 2n,
      })),
      signTransaction: vi.fn(async () => raw),
    } as unknown as WalletClient;
    const chain = new ViemAutomationChain(
      {} as PublicClient,
      wallet,
      account,
      1n,
      undefined,
      undefined,
      55n,
    );
    await expect(chain.prepare(action)).rejects.toBeInstanceOf(
      AutomationGasCapExceeded,
    );
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    const allowed = new ViemAutomationChain(
      {} as PublicClient,
      wallet,
      account,
      1n,
      undefined,
      undefined,
      56n,
    );
    expect(await allowed.prepare(action)).toMatchObject({
      raw,
      hash: keccak256(raw),
      maximumCost: 56n,
    });
    expect(wallet.signTransaction).toHaveBeenCalledOnce();
    expect(wallet.signTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 28n }),
    );
  });
});

describe("exact-writer final admission", () => {
  async function fixture(data: `0x${string}` = action.data) {
    const raw = await account.signTransaction({
      chainId: 421614,
      type: "eip1559",
      nonce: 5,
      gas: 100000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 1n,
      to: action.target,
      data,
      value: 0n,
    });
    const c = {
      getBlock: vi.fn(async () => ({ number: 100n, hash: keccak256("0xab") })),
      getTransactionCount: vi.fn(async () => 5),
      getGasPrice: vi.fn(async () => 10n),
      estimateGas: vi.fn(async () => 70000n),
      call: vi.fn(async () => ({ data: "0x" as const })),
    };
    const chain = new ViemAutomationChain(
      {
        call: vi.fn(async () => {
          throw new Error("must_use_selected_writer");
        }),
      } as never,
      { chain: { id: 421614 } } as WalletClient,
      account,
      2n,
      undefined,
      undefined,
      undefined,
      c as unknown as PublicClient,
    );
    const tx = {
      ...action,
      data,
      id: "test",
      state: "prepared" as const,
      raw,
      hash: keccak256(raw),
      nonce: 5n,
      maximumCost: 2000000n,
    };
    return { c, chain, tx };
  }
  it("simulates exact signed gas and pins/fences its head on the selected writer", async () => {
    const f = await fixture();
    await f.chain.validate(f.tx);
    expect(f.c.call).toHaveBeenCalledWith(
      expect.objectContaining({
        gas: 100000n,
        maxFeePerGas: 20n,
        blockNumber: 100n,
      }),
    );
    expect(f.c.getBlock).toHaveBeenCalledTimes(2);
  });
  it("rejects intent/nonce/fee/gas changes before broadcast", async () => {
    for (const reason of [
      "intent_mismatch",
      "nonce_changed",
      "fee_too_low",
      "gas_limit",
    ] as const) {
      const f = await fixture();
      if (reason === "intent_mismatch") f.tx.target = account.address;
      else if (reason === "nonce_changed")
        f.c.getTransactionCount.mockResolvedValue(6);
      else if (reason === "fee_too_low") f.c.getGasPrice.mockResolvedValue(21n);
      else f.c.estimateGas.mockResolvedValue(100001n);
      await expect(f.chain.validate(f.tx)).rejects.toMatchObject({ reason });
    }
  });
  it("malformed or zero claim return fails closed", async () => {
    const { encodeFunctionData, encodeAbiParameters } = await import("viem");
    const { automaticAbi } = await import("../src/automatic-source.js");
    const data = encodeFunctionData({
      abi: automaticAbi,
      functionName: "claimWinningsFor",
      args: [account.address],
    });
    for (const result of [
      "0x",
      encodeAbiParameters([{ type: "uint256" }], [0n]),
    ]) {
      const f = await fixture(data);
      f.c.call.mockResolvedValue({ data: result as never });
      await expect(f.chain.validate(f.tx)).rejects.toMatchObject({
        reason: "no_entitlement",
      });
    }
  });
  it("head changes invalidate all final checks", async () => {
    const f = await fixture();
    f.c.getBlock
      .mockResolvedValueOnce({ number: 100n, hash: keccak256("0xab") })
      .mockResolvedValueOnce({ number: 100n, hash: keccak256("0xcd") });
    await expect(f.chain.validate(f.tx)).rejects.toMatchObject({
      reason: "rejected",
    });
  });
});

describe("same nonce recovery signing", () => {
  it("preserves original call and applies fee/gas margin before signing", async () => {
    const { parseTransaction, recoverTransactionAddress } = await import(
      "viem"
    );
    const original = await account.signTransaction({
      chainId: 421614,
      type: "eip1559",
      nonce: 5,
      gas: 70000n,
      maxFeePerGas: 20n,
      maxPriorityFeePerGas: 2n,
      to: action.target,
      data: action.data,
      value: 0n,
    });
    const wallet = {
      chain: { id: 421614 },
      prepareTransactionRequest: vi.fn(async () => ({
        chainId: 421614,
        type: "eip1559" as const,
        nonce: 5,
        gas: 70000n,
        maxFeePerGas: 22n,
        maxPriorityFeePerGas: 1n,
        to: action.target,
        data: action.data,
        value: 0n,
      })),
      signTransaction: vi.fn(
        async (r: Parameters<typeof account.signTransaction>[0]) =>
          account.signTransaction(r),
      ),
    };
    const chain = new ViemAutomationChain(
      {} as PublicClient,
      wallet as unknown as WalletClient,
      account,
      2n,
      undefined,
      undefined,
      3000000n,
    );
    const tx = {
      ...action,
      id: "x",
      state: "unknown" as const,
      raw: original,
      hash: keccak256(original),
      nonce: 5n,
      maximumCost: 1400000n,
    };
    const replacement = await chain.prepareRecovery(tx);
    expect(parseTransaction(replacement.raw)).toMatchObject({
      chainId: 421614,
      nonce: 5,
      to: action.target,
      data: action.data,
      gas: 91000n,
      maxFeePerGas: 25n,
      maxPriorityFeePerGas: 3n,
    });
    expect(
      (
        await recoverTransactionAddress({
          serializedTransaction: replacement.raw as never,
        })
      ).toLowerCase(),
    ).toBe(account.address.toLowerCase());
    expect(parseTransaction(replacement.raw).value ?? 0n).toBe(0n);
    expect(replacement.maximumCost).toBe(2275000n);
    expect(wallet.prepareTransactionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        nonce: 5,
        to: action.target,
        data: action.data,
      }),
    );
    await expect(
      chain.prepareRecovery({ ...tx, data: "0xab" }),
    ).rejects.toMatchObject({ reason: "intent_mismatch" });
  });
});
