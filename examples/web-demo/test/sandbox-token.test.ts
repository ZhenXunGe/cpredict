import { describe, expect, it, vi } from "vitest";
import type { Address, PublicClient } from "viem";
import { mintSandboxToken } from "../src/sandbox-token.js";
import type { ConnectedWallet } from "../src/wallet.js";

const account = "0x0000000000000000000000000000000000000001" as Address;
const token = "0x0000000000000000000000000000000000000002" as Address;
const hash = `0x${"ab".repeat(32)}` as const;

describe("sandbox token faucet transaction", () => {
  it("simulates once, submits once, and requires a successful receipt", async () => {
    const simulateContract = vi.fn(async () => ({ request: { address: token } }));
    const waitForTransactionReceipt = vi.fn(async () => ({
      status: "success",
      blockNumber: 42n,
      gasUsed: 55_000n,
    }));
    const writeContract = vi.fn(async () => hash);
    const result = await mintSandboxToken(
      { simulateContract, waitForTransactionReceipt } as unknown as PublicClient,
      { address: account, account: { address: account }, walletClient: { writeContract } } as unknown as ConnectedWallet,
      token,
      10_000_000_000n,
    );
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      address: token,
      functionName: "mint",
      args: [account, 10_000_000_000n],
    }));
    expect(writeContract).toHaveBeenCalledTimes(1);
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash });
    expect(result).toEqual({ hash, blockNumber: 42n, gasUsed: 55_000n });
  });

  it("rejects zero mint and failed receipts", async () => {
    await expect(mintSandboxToken({} as PublicClient, {} as ConnectedWallet, token, 0n))
      .rejects.toThrow(/必须大于 0/);
    await expect(mintSandboxToken(
      {
        simulateContract: async () => ({ request: {} }),
        waitForTransactionReceipt: async () => ({ status: "reverted" }),
      } as unknown as PublicClient,
      {
        address: account,
        account: { address: account },
        walletClient: { writeContract: async () => hash },
      } as unknown as ConnectedWallet,
      token,
      1n,
    )).rejects.toThrow(/mint 交易失败/);
  });
});
