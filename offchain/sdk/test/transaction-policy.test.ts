import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import type {
  Account,
  Address,
  Chain,
  PublicClient,
  Transport,
  WalletClient,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  gasLimitByOperation,
  sendTransactionWithGasPolicy,
} from "../src/transaction-policy.js";

const to = "0x00000000000000000000000000000000000000B1" as Address;
const hash = `0x${"12".repeat(32)}` as const;
const account = privateKeyToAccount(generatePrivateKey());

function publicClient(overrides: Record<string, unknown> = {}) {
  return {
    estimateGas: vi.fn(async () => 100_000n),
    getBlock: vi.fn(async () => ({ baseFeePerGas: 50_000_000n })),
    estimateFeesPerGas: vi.fn(async () => ({
      maxFeePerGas: 70_000_000n,
      maxPriorityFeePerGas: 10_000_000n,
    })),
    ...overrides,
  } as unknown as PublicClient<Transport, Chain>;
}

function walletClient() {
  return {
    chain: mainnet,
    sendTransaction: vi.fn(async () => hash),
  } as unknown as WalletClient<Transport, Chain, Account>;
}

describe("browser transaction gas policy", () => {
  it("adds bounded gas headroom and normalizes max fee above the current base fee", async () => {
    const wallet = walletClient();

    await expect(
      sendTransactionWithGasPolicy(publicClient(), wallet, "primary-buy", {
        account,
        to,
        data: "0x1234",
      }),
    ).resolves.toBe(hash);

    expect(wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        gas: 120_000n,
        maxFeePerGas: 110_000_000n,
        maxPriorityFeePerGas: 10_000_000n,
      }),
    );
  });

  it("allows the observed Arbitrum listing estimate with bounded headroom", async () => {
    const wallet = walletClient();
    const rpc = publicClient({
      estimateGas: vi.fn(async () => 232_563n),
    });

    await sendTransactionWithGasPolicy(rpc, wallet, "listing-create", {
      account,
      to,
      data: "0x1234",
    });

    expect(wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 279_076n }),
    );
  });

  it("allows the observed Arbitrum resolve estimate with bounded headroom", async () => {
    const wallet = walletClient();
    const rpc = publicClient({
      estimateGas: vi.fn(async () => 353_629n),
    });

    await sendTransactionWithGasPolicy(rpc, wallet, "market-resolve", {
      account,
      to,
      data: "0x1234",
    });

    expect(wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: 424_355n }),
    );
  });

  it("replaces an implausible RPC estimate with the reviewed operation ceiling", async () => {
    const wallet = walletClient();
    const rpc = publicClient({
      estimateGas: vi.fn(async () => 394_064_967_394_918n),
    });

    await sendTransactionWithGasPolicy(rpc, wallet, "market-create-full", {
      account,
      to,
      data: "0x1234",
    });

    expect(wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        gas: gasLimitByOperation["market-create-full"],
      }),
    );
  });

  it("uses the reviewed ceiling when RPC gas estimation is unavailable", async () => {
    const wallet = walletClient();
    const rpc = publicClient({
      estimateGas: vi.fn(async () => {
        throw new Error("estimate unavailable");
      }),
    });

    await sendTransactionWithGasPolicy(rpc, wallet, "sandbox-mint", {
      account,
      to,
      data: "0x1234",
    });

    expect(wallet.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ gas: gasLimitByOperation["sandbox-mint"] }),
    );
  });

  it("blocks a plausible estimate that exceeds the reviewed ceiling", async () => {
    const wallet = walletClient();
    const rpc = publicClient({
      estimateGas: vi.fn(async () => 350_000n),
    });

    await expect(
      sendTransactionWithGasPolicy(rpc, wallet, "primary-buy", {
        account,
        to,
        data: "0x1234",
      }),
    ).rejects.toMatchObject({
      name: "GasPolicyError",
      code: "gas-above-limit",
    });
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it("blocks an unbounded maximum fee before the wallet can sign", async () => {
    const wallet = walletClient();
    const rpc = publicClient({
      estimateGas: vi.fn(async () => 8_000_000n),
      getBlock: vi.fn(async () => ({ baseFeePerGas: 2_000_000_000n })),
    });

    await expect(
      sendTransactionWithGasPolicy(rpc, wallet, "market-create-full", {
        account,
        to,
        data: "0x1234",
      }),
    ).rejects.toMatchObject({
      name: "GasPolicyError",
      code: "fee-above-limit",
    });
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });
});
