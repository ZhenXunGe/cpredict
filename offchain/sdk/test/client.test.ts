import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import {
  encodeAbiParameters,
  encodeEventTopics,
  type Account,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { marketplaceAbi } from "../src/abis.js";
import { BondSubmissionUnknownError, CpredictClient } from "../src/client.js";
import { ZERO_EVIDENCE_HASH } from "../src/evidence.js";

const vault = "0x00000000000000000000000000000000000000B1";
const marketplace = "0x00000000000000000000000000000000000000C1";
const seller = "0x00000000000000000000000000000000000000D1";
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

  it("returns the ListingCreated ID from the confirmed creation receipt", async () => {
    const listingId = `0x${"34".repeat(32)}` as const;
    const publicClient = {
      ...gasRpc(),
      simulateContract: vi.fn(async () => ({ request: {} })),
      waitForTransactionReceipt: vi.fn(async () => ({
        status: "success",
        blockNumber: 10n,
        gasUsed: 20n,
        logs: [
          {
            address: marketplace,
            topics: encodeEventTopics({
              abi: marketplaceAbi,
              eventName: "ListingCreated",
              args: { listingId, vault, seller },
            }),
            data: encodeAbiParameters(
              [
                { type: "uint256" },
                { type: "uint256" },
                { type: "uint256" },
                { type: "uint64" },
                { type: "uint256" },
              ],
              [0n, 2_000_000n, 900_000n, 1_900_000_000n, 1n],
            ),
          },
        ],
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

    await expect(
      client.createListing({
        marketplace,
        vault,
        outcomeId: 0n,
        amount: 2_000_000n,
        unitPrice: 900_000n,
        expiresAt: 1_900_000_000n,
      }),
    ).resolves.toMatchObject({ hash, listingId, blockNumber: 10n });
  });

  it("reads the latest onchain listing and block timestamp before UI authorization", async () => {
    const listingId = `0x${"34".repeat(32)}` as const;
    const publicClient = {
      readContract: vi.fn(
        async () =>
          [
            vault,
            seller,
            2_000_000n,
            900_000n,
            1_900_000_000n,
            0,
            true,
          ] as const,
      ),
      getBlock: vi.fn(async () => ({ timestamp: 1_800_000_000n })),
    } as unknown as PublicClient<Transport, Chain>;
    const client = new CpredictClient(
      publicClient,
      { chain: mainnet } as unknown as WalletClient<Transport, Chain, Account>,
      privateKeyToAccount(generatePrivateKey()),
    );

    await expect(
      client.readListing(marketplace as Address, listingId),
    ).resolves.toEqual({
      listingId,
      vault,
      seller,
      remainingUnits: 2_000_000n,
      unitPrice: 900_000n,
      expiresAt: 1_900_000_000n,
      outcomeId: 0n,
      active: true,
      observedAt: 1_800_000_000n,
    });
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

  it("routes creator-bond release and claim to BondEscrow", async () => {
    const bondEscrow = "0x00000000000000000000000000000000000000E1";
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

    await client.settleBond(bondEscrow, vault);
    expect(simulateContract).toHaveBeenLastCalledWith(
      expect.objectContaining({
        address: bondEscrow,
        functionName: "settleBond",
        args: [vault],
      }),
    );
    await client.claimBondFor(bondEscrow, seller);
    expect(simulateContract).toHaveBeenLastCalledWith(
      expect.objectContaining({
        address: bondEscrow,
        functionName: "claimFor",
        args: [seller],
      }),
    );
    await client.claimBond(bondEscrow);
    expect(simulateContract).toHaveBeenLastCalledWith(
      expect.objectContaining({
        address: bondEscrow,
        functionName: "claim",
        args: [],
      }),
    );
  });

  it("reports a bond submission hash before receipt failure without sending twice", async () => {
    const order: string[] = [];
    const publicClient = {
      ...gasRpc(),
      simulateContract: vi.fn(async () => ({})),
      waitForTransactionReceipt: vi.fn(async () => {
        order.push("receipt");
        throw new Error("RPC timeout");
      }),
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
    await expect(
      client.claimBondFor(marketplace, seller, (submitted) => {
        expect(submitted).toBe(hash);
        order.push("hash");
      }),
    ).rejects.toThrow("RPC timeout");
    expect(order).toEqual(["hash", "receipt"]);
    expect(walletClient.sendTransaction).toHaveBeenCalledOnce();
  });

  it("does not let a failing bond observer bypass receipt handling", async () => {
    const publicClient = {
      ...gasRpc(),
      simulateContract: vi.fn(async () => ({})),
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
    await expect(
      client.settleBond(marketplace, vault, () => {
        throw new Error("UI gone");
      }),
    ).resolves.toMatchObject({ hash });
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledOnce();
  });

  it("distinguishes an unknown wallet send from explicit user rejection", async () => {
    const publicClient = {
      ...gasRpc(),
      simulateContract: vi.fn(async () => ({})),
    } as unknown as PublicClient<Transport, Chain>;
    const sendTransaction = vi.fn(async () => {
      throw new Error("wallet response lost");
    });
    const client = new CpredictClient(
      publicClient,
      { chain: mainnet, sendTransaction } as unknown as WalletClient<
        Transport,
        Chain,
        Account
      >,
      privateKeyToAccount(generatePrivateKey()),
    );
    await expect(
      client.claimBondFor(marketplace, seller, () => {}),
    ).rejects.toBeInstanceOf(BondSubmissionUnknownError);
    const rejection = Object.assign(new Error("rejected"), { code: 4001 });
    sendTransaction.mockRejectedValueOnce(rejection);
    await expect(
      client.claimBondFor(marketplace, seller, () => {}),
    ).rejects.toBe(rejection);
    expect(sendTransaction).toHaveBeenCalledTimes(2);
  });
});
