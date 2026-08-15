import type { Address, PublicClient, WalletClient } from "viem";

const bondAbi = [
  {
    type: "function",
    name: "settleBond",
    stateMutability: "nonpayable",
    inputs: [{ name: "market", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
] as const;

const guardAbi = [
  {
    type: "function",
    name: "sync",
    stateMutability: "nonpayable",
    inputs: [{ name: "market", type: "address" }],
    outputs: [
      { name: "previousExposure", type: "uint256" },
      { name: "currentExposure", type: "uint256" },
    ],
  },
] as const;

export type MaintenanceOperation = "settle-bond" | "sync-exposure";
export type MaintenanceOutcome =
  | "success"
  | "simulation-rejected"
  | "submission-failed"
  | "receipt-failed"
  | "transaction-reverted";

export interface MaintenanceResult {
  market: Address;
  operation: MaintenanceOperation;
  outcome: MaintenanceOutcome;
  blockNumber: bigint;
  hash?: `0x${string}`;
  reason?: string;
}

export interface TerminalMarketSource {
  terminalMarkets(blockNumber: bigint): Promise<readonly Address[]>;
}

export interface TerminalWorkerState {
  lastAttemptBlock(market: Address): Promise<bigint | undefined>;
  recordAttempt(
    market: Address,
    blockNumber: bigint,
    results: readonly MaintenanceResult[],
  ): Promise<void>;
}

export interface TerminalWorkerTelemetry {
  record(result: MaintenanceResult): void;
  unexpected(error: unknown, market?: Address): void;
}

export class InMemoryTerminalWorkerState implements TerminalWorkerState {
  private readonly attempts = new Map<Address, bigint>();

  async lastAttemptBlock(market: Address): Promise<bigint | undefined> {
    return this.attempts.get(market);
  }

  async recordAttempt(market: Address, blockNumber: bigint): Promise<void> {
    this.attempts.set(market, blockNumber);
  }
}

/**
 * Permissionless terminal maintenance with per-market fault isolation.
 * A market is attempted at most once per observed block; every rejection is returned and observable.
 */
export class TerminalWorker {
  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly account: Address,
    private readonly bondEscrow: Address,
    private readonly exposureGuard: Address,
    private readonly source: TerminalMarketSource,
    private readonly state: TerminalWorkerState,
    private readonly telemetry: TerminalWorkerTelemetry,
  ) {}

  async runBlock(blockNumber: bigint): Promise<readonly MaintenanceResult[]> {
    const markets = await this.source.terminalMarkets(blockNumber);
    const unique = [
      ...new Set(markets.map((market) => market.toLowerCase() as Address)),
    ];
    const all: MaintenanceResult[] = [];
    for (const market of unique) {
      if ((await this.state.lastAttemptBlock(market)) === blockNumber) continue;
      try {
        const results = await settleTerminalMarket(
          this.publicClient,
          this.walletClient,
          this.account,
          this.bondEscrow,
          this.exposureGuard,
          market,
          blockNumber,
        );
        await this.state.recordAttempt(market, blockNumber, results);
        for (const result of results) this.telemetry.record(result);
        all.push(...results);
      } catch (error: unknown) {
        this.telemetry.unexpected(error, market);
      }
    }
    return all;
  }
}

/** Drainable new-block scheduler. All blocks share one queue and therefore one signer nonce lane. */
export class TerminalWorkerScheduler {
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly publicClient: PublicClient,
    private readonly worker: TerminalWorker,
    private readonly telemetry: TerminalWorkerTelemetry,
  ) {}

  isRunning(): boolean {
    return this.unsubscribe !== undefined;
  }

  start(): void {
    if (this.unsubscribe !== undefined)
      throw new Error("terminal worker scheduler already started");
    this.unsubscribe = this.publicClient.watchBlockNumber({
      emitMissed: true,
      onBlockNumber: (blockNumber) => this.enqueue(blockNumber),
      onError: (error) => this.telemetry.unexpected(error),
    });
  }

  async stop(): Promise<void> {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    unsubscribe?.();
    await this.queue;
  }

  private enqueue(blockNumber: bigint): void {
    if (this.unsubscribe === undefined) return;
    this.queue = this.queue
      .then(async () => this.worker.runBlock(blockNumber))
      .then(() => undefined)
      .catch((error: unknown) => this.telemetry.unexpected(error));
  }
}

/** Compatibility wrapper for embedded callers that do not need an awaited drain. */
export function startTerminalWorker(
  publicClient: PublicClient,
  worker: TerminalWorker,
  telemetry: TerminalWorkerTelemetry,
): () => void {
  const scheduler = new TerminalWorkerScheduler(
    publicClient,
    worker,
    telemetry,
  );
  scheduler.start();
  return () => {
    void scheduler.stop();
  };
}

export async function settleTerminalMarket(
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: Address,
  bondEscrow: Address,
  exposureGuard: Address,
  market: Address,
  blockNumber: bigint,
): Promise<readonly MaintenanceResult[]> {
  // A dedicated EOA worker has a single nonce lane. Keep these independent maintenance writes
  // sequential so two simultaneous wallet submissions cannot race on the same nonce.
  const bond = await executeMaintenance(
    publicClient,
    walletClient,
    account,
    market,
    blockNumber,
    "settle-bond",
    bondEscrow,
    bondAbi,
    "settleBond",
    [market],
  );
  const guard = await executeMaintenance(
    publicClient,
    walletClient,
    account,
    market,
    blockNumber,
    "sync-exposure",
    exposureGuard,
    guardAbi,
    "sync",
    [market],
  );
  return [bond, guard];
}

async function executeMaintenance(
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: Address,
  market: Address,
  blockNumber: bigint,
  operation: MaintenanceOperation,
  target: Address,
  abi: typeof bondAbi | typeof guardAbi,
  functionName: "settleBond" | "sync",
  args: readonly [Address],
): Promise<MaintenanceResult> {
  try {
    await publicClient.simulateContract({
      account,
      address: target,
      abi,
      functionName,
      args,
    });
  } catch (error: unknown) {
    return {
      market,
      operation,
      outcome: "simulation-rejected",
      blockNumber,
      reason: safeReason(error),
    };
  }

  let hash: `0x${string}`;
  try {
    hash = await walletClient.writeContract({
      account,
      address: target,
      abi,
      functionName,
      args,
      chain: walletClient.chain,
    });
  } catch (error: unknown) {
    return {
      market,
      operation,
      outcome: "submission-failed",
      blockNumber,
      reason: safeReason(error),
    };
  }
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      return {
        market,
        operation,
        outcome: "transaction-reverted",
        blockNumber,
        hash,
      };
    }
  } catch (error: unknown) {
    return {
      market,
      operation,
      outcome: "receipt-failed",
      blockNumber,
      hash,
      reason: safeReason(error),
    };
  }
  return { market, operation, outcome: "success", blockNumber, hash };
}

function safeReason(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "simulation rejected";
  return message
    .replace(/0x[0-9a-fA-F]{64,}/g, "[redacted-data]")
    .slice(0, 256);
}
