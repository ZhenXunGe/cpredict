import { orderbookAbi } from "../../sdk/src/orderbook.js";
import { publicMarketState } from "../../sdk/src/legacy-protocol.js";
import { parseAbi, type Address, type Hex, type PublicClient } from "viem";
import type { Environment } from "../../app-core/src/contracts.js";
import { sameAddress } from "../../app-core/src/contracts.js";
import type {
  MarketRights,
  RightsReader,
} from "../../app-core/src/entitlements.js";
import { marketplaceAbi } from "../../sdk/src/abis.js";
export const rightsAbi = parseAbi([
  "function marketState() view returns (uint8)",
  "function voidReason() view returns (uint8)",
  "function winningOutcome() view returns (uint8)",
  "function outcomeCount() view returns (uint8)",
  "function remainingWinningUnits() view returns (uint256)",
  "function remainingWinnerPool() view returns (uint256)",
  "function remainingEarlyBirdScore() view returns (uint256)",
  "function remainingEarlyBirdPool() view returns (uint256)",
  "function remainingTimeoutBonusUnits() view returns (uint256)",
  "function remainingTimeoutBonusPool() view returns (uint256)",
  "function timeoutBonusFunded() view returns (bool)",
  "function earlyBirdScore(address) view returns (uint256)",
  "function timeoutBonusUnits(address) view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
  "function balanceOf(address,uint256) view returns (uint256)",
  "function bondOf(address) view returns (address creator,uint128 amount,bool settled)",
  "function creditOf(address) view returns (uint256)",
]);
export class OnchainRightsReader implements RightsReader {
  constructor(
    private readonly client: PublicClient,
    private readonly environment: Environment,
    private readonly blockNumber: bigint,
    private readonly automatic = false,
  ) {}
  async market(address: Address, owner: Address): Promise<MarketRights> {
    if (this.automatic) return this.automaticMarket(address, owner);
    const shared = { address, abi: rightsAbi, blockNumber: this.blockNumber };
    const [
      state,
      voidReason,
      winningOutcome,
      outcomes,
      winnerPool,
      winningUnits,
      earlyPool,
      earlyScore,
      ownerEarlyScore,
      timeoutFunded,
      timeoutPool,
      timeoutTotalUnits,
      ownerTimeoutUnits,
    ] = await Promise.all([
      this.client.readContract({ ...shared, functionName: "marketState" }),
      this.environment.deployment.protocolVersion === "legacy-v1"
        ? Promise.resolve(0)
        : this.client.readContract({ ...shared, functionName: "voidReason" }),
      this.client.readContract({ ...shared, functionName: "winningOutcome" }),
      this.client.readContract({ ...shared, functionName: "outcomeCount" }),
      this.client.readContract({
        ...shared,
        functionName: "remainingWinnerPool",
      }),
      this.client.readContract({
        ...shared,
        functionName: "remainingWinningUnits",
      }),
      this.client.readContract({
        ...shared,
        functionName: "remainingEarlyBirdPool",
      }),
      this.client.readContract({
        ...shared,
        functionName: "remainingEarlyBirdScore",
      }),
      this.client.readContract({
        ...shared,
        functionName: "earlyBirdScore",
        args: [owner],
      }),
      this.client.readContract({
        ...shared,
        functionName: "timeoutBonusFunded",
      }),
      this.client.readContract({
        ...shared,
        functionName: "remainingTimeoutBonusPool",
      }),
      this.client.readContract({
        ...shared,
        functionName: "remainingTimeoutBonusUnits",
      }),
      this.client.readContract({
        ...shared,
        functionName: "timeoutBonusUnits",
        args: [owner],
      }),
    ]);
    if (outcomes < 2 || outcomes > 32)
      throw new Error("invalid market outcome count");
    const balances: bigint[] = [];
    for (let offset = 0; offset < outcomes; offset += 4)
      balances.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(4, outcomes - offset) }, (_, i) =>
            this.client.readContract({
              ...shared,
              functionName: "balanceOf",
              args: [owner, BigInt(offset + i)],
            }),
          ),
        )),
      );
    return {
      ...publicMarketState(
        this.environment.deployment.protocolVersion,
        state,
        voidReason,
      ),
      winningOutcome: BigInt(winningOutcome),
      balances,
      winnerPool,
      winningUnits,
      earlyPool,
      earlyScore,
      ownerEarlyScore,
      timeoutFunded,
      timeoutPool,
      timeoutTotalUnits,
      ownerTimeoutUnits,
    };
  }
  /** Same rights contract with state-specific reads, used only by the claims worker. */
  private async automaticMarket(
    address: Address,
    owner: Address,
  ): Promise<MarketRights> {
    const read = (functionName: string, args?: readonly unknown[]) =>
      this.client.readContract({
        address,
        abi: rightsAbi,
        blockNumber: this.blockNumber,
        functionName,
        ...(args ? { args } : {}),
      } as never) as Promise<bigint>;
    const state = Number(await read("marketState"));
    const voidReason =
      this.environment.deployment.protocolVersion === "legacy-v1"
        ? 0
        : Number(await read("voidReason"));
    const normalized = publicMarketState(
      this.environment.deployment.protocolVersion,
      state,
      voidReason,
    );
    const outcomes = Number(await read("outcomeCount"));
    if (outcomes < 2 || outcomes > 32)
      throw new Error("invalid market outcome count");
    const balances = await Promise.all(
      Array.from({ length: outcomes }, (_, i) =>
        read("balanceOf", [owner, BigInt(i)]),
      ),
    );
    const [ownerEarlyScore, ownerTimeoutUnits] = await Promise.all([
      read("earlyBirdScore", [owner]),
      read("timeoutBonusUnits", [owner]),
    ]);
    const result: MarketRights = {
      ...normalized,
      winningOutcome: 0n,
      balances,
      ownerEarlyScore,
      ownerTimeoutUnits,
      winnerPool: 0n,
      winningUnits: 0n,
      earlyPool: 0n,
      earlyScore: 0n,
      timeoutFunded: false,
      timeoutPool: 0n,
      timeoutTotalUnits: 0n,
    };
    if (normalized.state === 1) {
      result.winningOutcome = BigInt(await read("winningOutcome"));
      if ((balances[Number(result.winningOutcome)] ?? 0n) > 0n)
        [result.winnerPool, result.winningUnits] = await Promise.all([
          read("remainingWinnerPool"),
          read("remainingWinningUnits"),
        ]);
      if (ownerEarlyScore > 0n)
        [result.earlyPool, result.earlyScore] = await Promise.all([
          read("remainingEarlyBirdPool"),
          read("remainingEarlyBirdScore"),
        ]);
    } else if (normalized.state === 2 && normalized.voidReason === 3) {
      result.timeoutFunded = Boolean(await read("timeoutBonusFunded"));
      if (result.timeoutFunded)
        [result.timeoutPool, result.timeoutTotalUnits] = await Promise.all([
          read("remainingTimeoutBonusPool"),
          read("remainingTimeoutBonusUnits"),
        ]);
    }
    return result;
  }
  async listing(listingId: Hex, owner: Address) {
    if (this.environment.deployment.marketplaceVersion === "orderbook-v2") {
      const o = await this.client.readContract({
        address: this.environment.deployment.marketplace,
        abi: orderbookAbi,
        functionName: "orders",
        args: [BigInt(listingId)],
        blockNumber: this.blockNumber,
      });
      if (!sameAddress(o[1], owner) || o[6] !== 1)
        throw new Error("order owner mismatch");
      const state = await this.client.readContract({
        address: o[0],
        abi: rightsAbi,
        functionName: "marketState",
        blockNumber: this.blockNumber,
      });
      const pending = this.environment.deployment.orderbookReceiverRecovery
        ? await this.client.readContract({
            address: this.environment.deployment.marketplace,
            abi: orderbookAbi,
            functionName: "pendingShares",
            args: [BigInt(listingId)],
            blockNumber: this.blockNumber,
          })
        : 0n;
      return {
        units: o[2] + pending,
        terminal: state !== 0,
        active: o[8],
        pending: pending > 0n,
      };
    }
    const listing = await this.client.readContract({
      address: this.environment.deployment.marketplace,
      abi: marketplaceAbi,
      functionName: "listings",
      args: [listingId],
      blockNumber: this.blockNumber,
    });
    if (!sameAddress(listing[1], owner))
      throw new Error("listing owner mismatch");
    const state = await this.client.readContract({
      address: listing[0],
      abi: rightsAbi,
      functionName: "marketState",
      blockNumber: this.blockNumber,
    });
    return { units: listing[2], terminal: state !== 0, active: listing[6] };
  }
  async bond(market: Address, owner: Address) {
    const [bond, state, voidReason, totalPrincipal] = await Promise.all([
      this.client.readContract({
        address: this.environment.deployment.bondEscrow,
        abi: rightsAbi,
        functionName: "bondOf",
        args: [market],
        blockNumber: this.blockNumber,
      }),
      this.client.readContract({
        address: market,
        abi: rightsAbi,
        functionName: "marketState",
        blockNumber: this.blockNumber,
      }),
      this.environment.deployment.protocolVersion === "legacy-v1"
        ? Promise.resolve(0)
        : this.client.readContract({
            address: market,
            abi: rightsAbi,
            functionName: "voidReason",
            blockNumber: this.blockNumber,
          }),
      this.client.readContract({
        address: market,
        abi: rightsAbi,
        functionName: "totalPrincipal",
        blockNumber: this.blockNumber,
      }),
    ]);
    if (!sameAddress(bond[0], owner)) throw new Error("bond owner mismatch");
    const normalized = publicMarketState(
      this.environment.deployment.protocolVersion,
      state,
      voidReason,
    );
    const terminal = normalized.state !== 0;
    return {
      amount: bond[1],
      settled: bond[2],
      terminal,
      // A timeout bond with participants belongs to the compensation pool.
      // All other terminal outcomes credit the creator and can be claimed atomically.
      returnable:
        terminal &&
        !(
          normalized.state === 2 &&
          normalized.voidReason === 3 &&
          totalPrincipal > 0n
        ),
    };
  }
  async credit(kind: "fees" | "bond", owner: Address) {
    return this.client.readContract({
      address:
        kind === "fees"
          ? this.environment.deployment.feeVault
          : this.environment.deployment.bondEscrow,
      abi: rightsAbi,
      functionName: "creditOf",
      args: [owner],
      blockNumber: this.blockNumber,
    });
  }
}
