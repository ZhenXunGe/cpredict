import {
  BaseError,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type ContractFunctionArgs,
  type ContractFunctionName,
  encodeFunctionData,
  type Hex,
  type Log,
  parseEventLogs,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import {
  bondEscrowAbi,
  erc20Abi,
  exposureGuardAbi,
  marketFactoryAbi,
  marketVaultAbi,
  marketplaceAbi,
} from "./abis.js";
import {
  buyInputSchema,
  buyWithPermit2InputSchema,
  createListingInputSchema,
  createMarketInputSchema,
  fillListingInputSchema,
  fillListingWithPermit2InputSchema,
  addressSchema,
  bytes32Schema,
  type BuyInput,
  type BuyWithPermit2Input,
  type CreateListingInput,
  type CreateMarketInput,
  type FillListingInput,
  type FillListingWithPermit2Input,
} from "./schemas.js";
import { normalizeEvidenceHash, ZERO_EVIDENCE_HASH } from "./evidence.js";
import {
  sendTransactionWithGasPolicy,
  GasPolicyError,
  type GasPolicyOperation,
} from "./transaction-policy.js";

export interface TransactionResult {
  hash: `0x${string}`;
  blockNumber: bigint;
  gasUsed: bigint;
}

/** Submission transport failed without a hash; absence of a hash is not proof of no broadcast. */
export class BondSubmissionUnknownError extends Error {
  constructor(cause: unknown) {
    super("钱包提交结果未知，未取得交易哈希；请核对钱包记录，不要重复提交。", {
      cause,
    });
    this.name = "BondSubmissionUnknownError";
  }
}

export interface CreateMarketResult extends TransactionResult {
  market: Address;
}

export interface CreateListingResult extends TransactionResult {
  listingId: Hex;
}

export interface ListingSnapshot {
  listingId: Hex;
  vault: Address;
  seller: Address;
  remainingUnits: bigint;
  unitPrice: bigint;
  expiresAt: bigint;
  outcomeId: bigint;
  active: boolean;
  observedAt: bigint;
}

type MutableFunction<TAbi extends Abi> = ContractFunctionName<
  TAbi,
  "nonpayable"
>;

/**
 * Transaction SDK with a single invariant for every economic write:
 * validate -> simulate -> bound gas/fees -> submit once -> receipt -> require success.
 */
export class CpredictClient {
  constructor(
    private readonly publicClient: PublicClient<Transport, Chain>,
    private readonly walletClient: WalletClient<Transport, Chain, Account>,
    private readonly account: Account,
  ) {}

  async approvePaymentToken(
    token: Address,
    spender: Address,
    amount: bigint,
  ): Promise<TransactionResult> {
    if (amount < 0n) throw new RangeError("approval amount cannot be negative");
    return this.execute("token-approval", token, erc20Abi, "approve", [
      spender,
      amount,
    ]);
  }

  async setMarketplaceApproval(
    vault: Address,
    marketplace: Address,
    approved = true,
  ): Promise<TransactionResult> {
    return this.execute(
      "operator-approval",
      vault,
      marketVaultAbi,
      "setApprovalForAll",
      [marketplace, approved],
    );
  }

  async createMarket(input: CreateMarketInput): Promise<CreateMarketResult> {
    const value = createMarketInputSchema.parse(input);
    const execution = await this.executeWithReceipt(
      value.params.deploymentMode === 0
        ? "market-create-full"
        : "market-create-clone",
      value.factory,
      marketFactoryAbi,
      "createMarket",
      [value.params, value.userSalt],
    );
    const events = parseEventLogs({
      abi: marketFactoryAbi,
      eventName: "MarketCreated",
      logs: execution.logs,
      strict: true,
    });
    const created = events[0];
    if (created === undefined)
      throw new Error(
        "successful createMarket receipt has no MarketCreated event",
      );
    return { ...execution.result, market: created.args.market };
  }

  async readCreationTiming(
    factory: Address,
  ): Promise<{ observedAt: bigint; resolutionWindow: bigint }> {
    const block = await this.publicClient.getBlock({ blockTag: "latest" });
    const resolutionWindow = await this.publicClient.readContract({
      address: factory,
      abi: marketFactoryAbi,
      functionName: "resolutionWindow",
      blockNumber: block.number,
    });
    return { observedAt: block.timestamp, resolutionWindow };
  }

  async buy(input: BuyInput): Promise<TransactionResult> {
    const value = buyInputSchema.parse(input);
    return this.execute("primary-buy", value.vault, marketVaultAbi, "buy", [
      value.outcomeId,
      value.desiredUnits,
      value.minimumUnits,
      value.maximumPayment,
      value.deadline,
    ]);
  }

  async buyWithPermit2(input: BuyWithPermit2Input): Promise<TransactionResult> {
    const value = buyWithPermit2InputSchema.parse(input);
    return this.execute(
      "primary-buy-permit2",
      value.vault,
      marketVaultAbi,
      "buyWithPermit2",
      [
        value.owner,
        value.outcomeId,
        value.desiredUnits,
        value.minimumUnits,
        value.maximumPayment,
        value.deadline,
        value.permit,
        value.signature,
      ],
    );
  }

  async updateBeforeFirstBuy(
    vault: Address,
    input: {
      rulesHash: `0x${string}`;
      metadataURI: string;
      resolutionSourceHash: `0x${string}`;
      resolutionSourceURI: string;
      closeAt: bigint;
      eventStartsAt: bigint;
      outcomeDeadlineAt: bigint;
      creatorTreasury: Address;
      featureFlags: bigint;
    },
  ): Promise<TransactionResult> {
    return this.execute(
      "market-update",
      vault,
      marketVaultAbi,
      "updateBeforeFirstBuy",
      [input],
    );
  }

  async resolve(
    vault: Address,
    outcomeId: bigint,
    evidenceHash: `0x${string}` = ZERO_EVIDENCE_HASH,
  ): Promise<TransactionResult> {
    if (outcomeId < 0n) throw new RangeError("outcomeId cannot be negative");
    return this.execute("market-resolve", vault, marketVaultAbi, "resolve", [
      outcomeId,
      normalizeEvidenceHash(evidenceHash),
    ]);
  }

  async creatorVoid(
    vault: Address,
    evidenceHash: `0x${string}` = ZERO_EVIDENCE_HASH,
  ): Promise<TransactionResult> {
    return this.execute("market-void", vault, marketVaultAbi, "creatorVoid", [
      normalizeEvidenceHash(evidenceHash),
    ]);
  }

  async voidAfterDeadline(vault: Address): Promise<TransactionResult> {
    return this.execute(
      "market-void",
      vault,
      marketVaultAbi,
      "voidAfterDeadline",
      [],
    );
  }

  async readListing(
    marketplace: Address,
    listingId: Hex,
  ): Promise<ListingSnapshot> {
    const address = addressSchema.parse(marketplace);
    const id = bytes32Schema.parse(listingId);
    const [listing, block] = await Promise.all([
      this.publicClient.readContract({
        address,
        abi: marketplaceAbi,
        functionName: "listings",
        args: [id],
      }),
      this.publicClient.getBlock({ blockTag: "latest" }),
    ]);
    return {
      listingId: id,
      vault: listing[0],
      seller: listing[1],
      remainingUnits: listing[2],
      unitPrice: listing[3],
      expiresAt: listing[4],
      outcomeId: BigInt(listing[5]),
      active: listing[6],
      observedAt: block.timestamp,
    };
  }

  async createListing(input: CreateListingInput): Promise<CreateListingResult> {
    const value = createListingInputSchema.parse(input);
    const execution = await this.executeWithReceipt(
      "listing-create",
      value.marketplace,
      marketplaceAbi,
      "createListing",
      [
        value.vault,
        value.outcomeId,
        value.amount,
        value.unitPrice,
        value.expiresAt,
      ],
    );
    const events = parseEventLogs({
      abi: marketplaceAbi,
      eventName: "ListingCreated",
      logs: execution.logs,
      strict: true,
    });
    const created = events[0];
    if (created === undefined)
      throw new Error(
        "successful createListing receipt has no ListingCreated event",
      );
    return { ...execution.result, listingId: created.args.listingId };
  }

  async fillListing(input: FillListingInput): Promise<TransactionResult> {
    const value = fillListingInputSchema.parse(input);
    return this.execute(
      "listing-fill",
      value.marketplace,
      marketplaceAbi,
      "fillListing",
      [
        value.listingId,
        value.desiredUnits,
        value.minimumUnits,
        value.maximumGross,
        value.deadline,
      ],
    );
  }

  async fillListingWithPermit2(
    input: FillListingWithPermit2Input,
  ): Promise<TransactionResult> {
    const value = fillListingWithPermit2InputSchema.parse(input);
    return this.execute(
      "listing-fill-permit2",
      value.marketplace,
      marketplaceAbi,
      "fillListingWithPermit2",
      [
        value.listingId,
        value.buyer,
        value.desiredUnits,
        value.minimumUnits,
        value.maximumGross,
        value.deadline,
        value.permit,
        value.signature,
      ],
    );
  }

  async cancelListing(
    marketplace: Address,
    listingId: `0x${string}`,
  ): Promise<TransactionResult> {
    return this.execute(
      "listing-maintenance",
      marketplace,
      marketplaceAbi,
      "cancelListing",
      [listingId],
    );
  }

  async returnTerminalListing(
    marketplace: Address,
    listingId: `0x${string}`,
  ): Promise<TransactionResult> {
    return this.execute(
      "listing-maintenance",
      marketplace,
      marketplaceAbi,
      "returnTerminalListing",
      [listingId],
    );
  }

  async claimWinner(
    vault: Address,
    owner: Address,
  ): Promise<TransactionResult> {
    return this.execute("claim", vault, marketVaultAbi, "claimWinningsFor", [
      owner,
    ]);
  }

  async refund(vault: Address, owner: Address): Promise<TransactionResult> {
    return this.execute("claim", vault, marketVaultAbi, "refundFor", [owner]);
  }

  async claimEarlyBird(
    vault: Address,
    owner: Address,
  ): Promise<TransactionResult> {
    return this.execute("claim", vault, marketVaultAbi, "claimEarlyBirdFor", [
      owner,
    ]);
  }

  async claimTimeoutBonus(
    vault: Address,
    owner: Address,
  ): Promise<TransactionResult> {
    return this.execute(
      "claim",
      vault,
      marketVaultAbi,
      "claimTimeoutBonusFor",
      [owner],
    );
  }

  async settleBond(
    bondEscrow: Address,
    market: Address,
    onSubmitted?: (hash: Hex) => void,
  ): Promise<TransactionResult> {
    return this.execute(
      "bond-settlement",
      bondEscrow,
      bondEscrowAbi,
      "settleBond",
      [market],
      onSubmitted,
    );
  }

  async claimBond(bondEscrow: Address): Promise<TransactionResult> {
    return this.execute("claim", bondEscrow, bondEscrowAbi, "claim", []);
  }

  async claimBondFor(
    bondEscrow: Address,
    creator: Address,
    onSubmitted?: (hash: Hex) => void,
  ): Promise<TransactionResult> {
    return this.execute(
      "claim",
      bondEscrow,
      bondEscrowAbi,
      "claimFor",
      [creator],
      onSubmitted,
    );
  }

  async syncExposure(
    exposureGuard: Address,
    market: Address,
  ): Promise<TransactionResult> {
    return this.execute(
      "exposure-sync",
      exposureGuard,
      exposureGuardAbi,
      "sync",
      [market],
    );
  }

  private async execute<
    const TAbi extends Abi,
    const TFunctionName extends MutableFunction<TAbi>,
  >(
    operation: GasPolicyOperation,
    address: Address,
    abi: TAbi,
    functionName: TFunctionName,
    args: ContractFunctionArgs<TAbi, "nonpayable", TFunctionName>,
    onSubmitted?: (hash: Hex) => void,
  ): Promise<TransactionResult> {
    const execution = await this.executeWithReceipt(
      operation,
      address,
      abi,
      functionName,
      args,
      onSubmitted,
    );
    return execution.result;
  }

  private async executeWithReceipt<
    const TAbi extends Abi,
    const TFunctionName extends MutableFunction<TAbi>,
  >(
    operation: GasPolicyOperation,
    address: Address,
    abi: TAbi,
    functionName: TFunctionName,
    args: ContractFunctionArgs<TAbi, "nonpayable", TFunctionName>,
    onSubmitted?: (hash: Hex) => void,
  ): Promise<{ result: TransactionResult; logs: Log[] }> {
    await this.publicClient.simulateContract({
      account: this.account,
      address,
      abi,
      functionName,
      args,
    });
    // viem cannot retain the correlated ABI/function/args generic through this private helper;
    // the public call sites above remain fully typed and this is the single encoding boundary.
    const data = encodeFunctionData({ abi, functionName, args } as never);
    const hash = await sendTransactionWithGasPolicy(
      this.publicClient,
      this.walletClient,
      operation,
      {
        account: this.account,
        to: address,
        data,
      },
    ).catch((cause: unknown) => {
      const rejected =
        cause instanceof BaseError
          ? cause.walk(
              (error) =>
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === 4001,
            )
          : cause;
      const userRejected =
        typeof rejected === "object" &&
        rejected !== null &&
        "code" in rejected &&
        rejected.code === 4001;
      if (
        onSubmitted !== undefined &&
        !(cause instanceof GasPolicyError) &&
        !userRejected
      ) {
        throw new BondSubmissionUnknownError(cause);
      }
      throw cause;
    });
    // A UI observer can retain the submitted identity, but cannot change receipt handling.
    try {
      onSubmitted?.(hash);
    } catch {
      // Continue waiting for the actual transaction even if its UI observer failed.
    }
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });
    if (receipt.status !== "success")
      throw new Error(`transaction reverted: ${hash}`);
    return {
      result: {
        hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      },
      logs: receipt.logs,
    };
  }
}
