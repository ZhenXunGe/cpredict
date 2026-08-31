import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import type {
  Account,
  Chain,
  PublicClient,
  Transport,
  WalletClient,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { CpredictClient } from "../src/client.js";
import { ZERO_EVIDENCE_HASH } from "../src/evidence.js";

const vault = "0x00000000000000000000000000000000000000B1";
const marketplace = "0x00000000000000000000000000000000000000C1";
const hash = `0x${"12".repeat(32)}` as const;

function gasRpc() {
  return {
    estimateGas: vi.fn(async () => 200_000n),
    getBlock: vi.fn(async () => ({ baseFeePerGas: 50_000_000n })),
    estimateFeesPerGas: vi.fn(async () => ({
      maxFeePerGas: 70_000_000n,
      maxPriorityFeePerGas: 10_000_000n,
    })),
  };
}

describe("CpredictClient transaction discipline", () => {
  it("simulates, submits once and waits for a successful receipt", async () => {
    const actions: string[] = [];
    const publicClient = {
      ...gasRpc(),
      simulateContract: vi.fn(async () => {
        actions.push("simulate");
        return { request: {} };
      }),
      waitForTransactionReceipt: vi.fn(async () => {
        actions.push("receipt");
        return { status: "success", blockNumber: 10n, gasUsed: 20n };
      }),
    } as unknown as PublicClient<Transport, Chain>;
    const walletClient = {
      chain: mainnet,
      sendTransaction: vi.fn(async () => {
        actions.push("send");
        return hash;
      }),
    } as unknown as WalletClient<Transport, Chain, Account>;
    const client = new CpredictClient(
      publicClient,
      walletClient,
      privateKeyToAccount(generatePrivateKey()),
    );

    await expect(
      client.buy({
        vault,
        outcomeId: 1n,
        desiredUnits: 2_000_000n,
        minimumUnits: 1_000_000n,
        maximumPayment: 2_000_000n,
        deadline: 1_900_000_000n,
      }),
    ).resolves.toEqual({ hash, blockNumber: 10n, gasUsed: 20n });
    expect(actions).toEqual(["simulate", "send", "receipt"]);
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(1);
    expect(walletClient.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        gas: 240_000n,
        maxFeePerGas: 110_000_000n,
        maxPriorityFeePerGas: 10_000_000n,
      }),
    );
  });

  it("does not submit when simulation rejects a stale listing", async () => {
    const publicClient = {
      ...gasRpc(),
      simulateContract: vi.fn(async () => {
        throw new Error("ListingNotActive");
      }),
    } as unknown as PublicClient<Transport, Chain>;
    const walletClient = {
      chain: mainnet,
      sendTransaction: vi.fn(),
    } as unknown as WalletClient<Transport, Chain, Account>;
    const client = new CpredictClient(
      publicClient,
      walletClient,
      privateKeyToAccount(generatePrivateKey()),
    );
    await expect(
      client.fillListing({
        marketplace,
        listingId: `0x${"34".repeat(32)}`,
        desiredUnits: 1_000_000n,
        minimumUnits: 1_000_000n,
        maximumGross: 1_000_000n,
        deadline: 1_900_000_000n,
      }),
    ).rejects.toThrow("ListingNotActive");
    expect(walletClient.sendTransaction).not.toHaveBeenCalled();
  });

  it("binds explicit or absent evidence hashes into terminal calls", async () => {
    const simulateContract = vi.fn(async () => ({ request: {} }));
    const publicClient = {
      ...gasRpc(),
      simulateContract,
      waitForTransactionReceipt: vi.fn(async () => ({
        status: "success",
        blockNumber: 10n,
        gasUsed: 20n,
      })),
    } as unknown as PublicClient<Transport, Chain>;
    const walletClient = {
      chain: mainnet,
      sendTransaction: vi.fn(async () => hash),
    } as unknown as WalletClient<Transport, Chain, Account>;
    const client = new CpredictClient(
      publicClient,
      walletClient,
      privateKeyToAccount(generatePrivateKey()),
    );
    const evidenceHash = `0x${"ab".repeat(32)}` as const;

    await client.resolve(vault, 1n, evidenceHash);
    expect(simulateContract).toHaveBeenLastCalledWith(
      expect.objectContaining({
        functionName: "resolve",
        args: [1n, evidenceHash],
      }),
    );
    await client.creatorVoid(vault);
    expect(simulateContract).toHaveBeenLastCalledWith(
      expect.objectContaining({
        functionName: "creatorVoid",
        args: [ZERO_EVIDENCE_HASH],
      }),
    );
    expect(walletClient.sendTransaction).toHaveBeenCalledTimes(2);
  });
});
