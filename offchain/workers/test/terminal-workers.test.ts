import { describe, expect, it, vi } from "vitest";
import type { PublicClient, WalletClient } from "viem";
import {
  InMemoryTerminalWorkerState,
  TerminalWorker,
  TerminalWorkerScheduler,
  type MaintenanceResult,
} from "../src/terminal-workers.js";

const market = "0x00000000000000000000000000000000000000A1";
const bond = "0x00000000000000000000000000000000000000B1";
const guard = "0x00000000000000000000000000000000000000C1";
const account = "0x00000000000000000000000000000000000000D1";
const txHash = `0x${"12".repeat(32)}` as const;

describe("TerminalWorker", () => {
  it("records each operation and retries a rejected market only on a new block", async () => {
    let rejectBond = true;
    const publicClient = {
      simulateContract: vi.fn(
        async ({ functionName }: { functionName: string }) => {
          if (functionName === "settleBond" && rejectBond)
            throw new Error("AlreadySettled");
        },
      ),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
    } as unknown as PublicClient;
    const walletClient = {
      chain: undefined,
      writeContract: vi.fn(async () => txHash),
    } as unknown as WalletClient;
    const recorded: MaintenanceResult[] = [];
    const worker = new TerminalWorker(
      publicClient,
      walletClient,
      account,
      bond,
      guard,
      {
        async terminalMarkets() {
          return [market, market];
        },
      },
      new InMemoryTerminalWorkerState(),
      {
        record(result) {
          recorded.push(result);
        },
        unexpected: vi.fn(),
      },
    );

    const first = await worker.runBlock(100n);
    expect(first.map((result) => result.outcome)).toEqual([
      "simulation-rejected",
      "success",
    ]);
    expect(await worker.runBlock(100n)).toEqual([]);
    rejectBond = false;
    const next = await worker.runBlock(101n);
    expect(next.every((result) => result.outcome === "success")).toBe(true);
    expect(recorded).toHaveLength(4);
  });

  it("redacts long calldata from observable rejection reasons", async () => {
    const publicClient = {
      simulateContract: vi.fn(async () => {
        throw new Error(`revert 0x${"ab".repeat(100)}`);
      }),
    } as unknown as PublicClient;
    const worker = new TerminalWorker(
      publicClient,
      {} as WalletClient,
      account,
      bond,
      guard,
      {
        async terminalMarkets() {
          return [market];
        },
      },
      new InMemoryTerminalWorkerState(),
      { record: vi.fn(), unexpected: vi.fn() },
    );
    const results = await worker.runBlock(1n);
    expect(results[0]?.reason).toContain("[redacted-data]");
    expect(results[0]?.reason).not.toContain("abababababababab");
  });

  it("serializes wallet submissions for a single EOA nonce lane", async () => {
    let submissionInFlight = false;
    const walletClient = {
      chain: undefined,
      writeContract: vi.fn(async () => {
        if (submissionInFlight) throw new Error("concurrent nonce lane");
        submissionInFlight = true;
        await new Promise((resolve) => setTimeout(resolve, 1));
        submissionInFlight = false;
        return txHash;
      }),
    } as unknown as WalletClient;
    const worker = new TerminalWorker(
      {
        simulateContract: vi.fn(),
        waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
      } as unknown as PublicClient,
      walletClient,
      account,
      bond,
      guard,
      {
        async terminalMarkets() {
          return [market];
        },
      },
      new InMemoryTerminalWorkerState(),
      { record: vi.fn(), unexpected: vi.fn() },
    );

    const results = await worker.runBlock(2n);
    expect(results.map((result) => result.outcome)).toEqual([
      "success",
      "success",
    ]);
    expect(walletClient.writeContract).toHaveBeenCalledTimes(2);
  });

  it("returns structured submission and receipt failures", async () => {
    const submitFailure = new TerminalWorker(
      { simulateContract: vi.fn() } as unknown as PublicClient,
      {
        chain: undefined,
        writeContract: vi.fn(async () => {
          throw new Error("RPC unavailable");
        }),
      } as unknown as WalletClient,
      account,
      bond,
      guard,
      {
        async terminalMarkets() {
          return [market];
        },
      },
      new InMemoryTerminalWorkerState(),
      { record: vi.fn(), unexpected: vi.fn() },
    );
    expect(
      (await submitFailure.runBlock(3n)).map((result) => result.outcome),
    ).toEqual(["submission-failed", "submission-failed"]);

    const receiptFailure = new TerminalWorker(
      {
        simulateContract: vi.fn(),
        waitForTransactionReceipt: vi.fn(async () => {
          throw new Error("receipt timeout");
        }),
      } as unknown as PublicClient,
      {
        chain: undefined,
        writeContract: vi.fn(async () => txHash),
      } as unknown as WalletClient,
      account,
      bond,
      guard,
      {
        async terminalMarkets() {
          return [market];
        },
      },
      new InMemoryTerminalWorkerState(),
      { record: vi.fn(), unexpected: vi.fn() },
    );
    expect(
      (await receiptFailure.runBlock(4n)).map((result) => result.outcome),
    ).toEqual(["receipt-failed", "receipt-failed"]);
  });

  it("drains queued blocks before releasing the single nonce lane", async () => {
    let onBlock: ((blockNumber: bigint) => void) | undefined;
    const unsubscribe = vi.fn();
    const publicClient = {
      watchBlockNumber: vi.fn(
        (options: { onBlockNumber(blockNumber: bigint): void }) => {
          onBlock = options.onBlockNumber;
          return unsubscribe;
        },
      ),
    } as unknown as PublicClient;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = {
      runBlock: vi.fn(async () => blocked),
    } as unknown as TerminalWorker;
    const scheduler = new TerminalWorkerScheduler(publicClient, worker, {
      record: vi.fn(),
      unexpected: vi.fn(),
    });
    scheduler.start();
    onBlock?.(10n);
    onBlock?.(11n);
    await vi.waitFor(() => expect(worker.runBlock).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    expect(worker.runBlock).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledOnce();

    onBlock?.(12n);
    await Promise.resolve();
    expect(worker.runBlock).toHaveBeenCalledTimes(2);
  });
});
