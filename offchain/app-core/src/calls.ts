import {
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  bondEscrowAbi,
  marketFactoryAbi,
  marketplaceAbi,
  marketVaultAbi,
} from "../../sdk/src/abis.js";
import { createMarketInputSchema } from "../../sdk/src/schemas.js";
import {
  AppError,
  budgetLane,
  sameAddress,
  type BusinessCall,
  type BusinessIntent,
  type Environment,
} from "./contracts.js";
import { receiveCall } from "./usdc.js";

const mintAbi = parseAbi(["function mint(address to,uint256 amount)"]);
const feeAbi = parseAbi([
  "function claimFor(address beneficiary) returns (uint256)",
]);
export const FAUCET_AMOUNT = 1_000_000_000n;
export interface AdmissionReader {
  registeredMarket(market: Address): Promise<boolean>;
  verifiedRules(market: Address): Promise<boolean>;
  listing(
    id: Hex,
  ): Promise<{ market: Address; seller: Address; active: boolean }>;
  creationPayment(
    params: Extract<BusinessIntent, { kind: "create-market" }>["params"],
  ): Promise<bigint>;
}

/** Business intent is the allowlist. Raw caller-supplied contracts/methods are never admitted. */
export async function buildBusinessCalls(
  environment: Environment,
  account: Address,
  intent: BusinessIntent,
  reader: AdmissionReader,
  nowSeconds: bigint,
): Promise<BusinessCall[]> {
  const d = environment.deployment;
  if (
    intent.kind !== "faucet" &&
    budgetLane(intent.kind) === "exposure" &&
    !environment.features.newExposure
  )
    throw new AppError("new_exposure_disabled", 503);
  const call = (to: Address, data: Hex): BusinessCall => ({
    to,
    data,
    value: "0",
  });
  const withPayment = (
    spender: Address,
    amount: bigint,
    action: BusinessCall,
  ): BusinessCall[] => [
    call(
      d.paymentToken,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, 0n],
      }),
    ),
    call(
      d.paymentToken,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, amount],
      }),
    ),
    action,
    call(
      d.paymentToken,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, 0n],
      }),
    ),
  ];
  let market: Address | undefined =
    "market" in intent ? intent.market : undefined;
  let listing: Awaited<ReturnType<AdmissionReader["listing"]>> | undefined;
  if ("listingId" in intent) {
    listing = await reader.listing(intent.listingId);
    market = listing.market;
    if (!listing.active) throw new AppError("listing_unavailable", 409);
    if (
      (intent.kind === "cancel-listing" || intent.kind === "return-listing") &&
      !sameAddress(listing.seller, account)
    )
      throw new AppError("listing_owner_mismatch", 403);
  }
  if (market !== undefined) {
    if (!(await reader.registeredMarket(market)))
      throw new AppError("market_not_registered", 400);
    if (
      budgetLane(intent.kind) === "exposure" &&
      !(await reader.verifiedRules(market))
    )
      throw new AppError("rules_unverified", 409);
  }
  if (
    "deadline" in intent &&
    (BigInt(intent.deadline) <= nowSeconds ||
      BigInt(intent.deadline) > nowSeconds + 900n)
  )
    throw new AppError("invalid_deadline");
  if ("minUnits" in intent && BigInt(intent.minUnits) > BigInt(intent.units))
    throw new AppError("invalid_minimum_units");
  switch (intent.kind) {
    case "deposit-usdc":
      if (
        environment.asset !== "USDC" ||
        !environment.features.gaslessDeposit ||
        environment.account.index !== "1002"
      )
        throw new AppError("gasless_deposit_disabled", 503);
      if (
        !sameAddress(intent.authorization.to, account) ||
        sameAddress(intent.authorization.from, account)
      )
        throw new AppError("deposit_recipient_mismatch", 403);
      if (
        BigInt(intent.authorization.validAfter) >= nowSeconds ||
        BigInt(intent.authorization.validBefore) <= nowSeconds
      )
        throw new AppError("deposit_authorization_expired", 409);
      return [receiveCall(intent.authorization, intent.signature)];
    case "faucet":
      if (environment.asset !== "ctUSD" || !environment.features.faucet)
        throw new AppError("faucet_disabled", 503);
      return [
        call(
          d.paymentToken,
          encodeFunctionData({
            abi: mintAbi,
            functionName: "mint",
            args: [account, FAUCET_AMOUNT],
          }),
        ),
      ];
    case "buy":
      return withPayment(
        intent.market,
        BigInt(intent.maxPayment),
        call(
          intent.market,
          encodeFunctionData({
            abi: marketVaultAbi,
            functionName: "buy",
            args: [
              BigInt(intent.outcomeId),
              BigInt(intent.units),
              BigInt(intent.minUnits),
              BigInt(intent.maxPayment),
              BigInt(intent.deadline),
            ],
          }),
        ),
      );
    case "fill-listing":
      if (listing && sameAddress(listing.seller, account))
        throw new AppError("self_trade_not_sponsored");
      return withPayment(
        d.marketplace,
        BigInt(intent.maxPayment),
        call(
          d.marketplace,
          encodeFunctionData({
            abi: marketplaceAbi,
            functionName: "fillListing",
            args: [
              intent.listingId,
              BigInt(intent.units),
              BigInt(intent.minUnits),
              BigInt(intent.maxPayment),
              BigInt(intent.deadline),
            ],
          }),
        ),
      );
    case "create-listing":
      if (BigInt(intent.expiresAt) <= nowSeconds)
        throw new AppError("invalid_deadline");
      return [
        call(
          intent.market,
          encodeFunctionData({
            abi: marketVaultAbi,
            functionName: "setApprovalForAll",
            args: [d.marketplace, true],
          }),
        ),
        call(
          d.marketplace,
          encodeFunctionData({
            abi: marketplaceAbi,
            functionName: "createListing",
            args: [
              intent.market,
              BigInt(intent.outcomeId),
              BigInt(intent.units),
              BigInt(intent.unitPrice),
              BigInt(intent.expiresAt),
            ],
          }),
        ),
        call(
          intent.market,
          encodeFunctionData({
            abi: marketVaultAbi,
            functionName: "setApprovalForAll",
            args: [d.marketplace, false],
          }),
        ),
      ];
    case "cancel-listing":
      return [
        call(
          d.marketplace,
          encodeFunctionData({
            abi: marketplaceAbi,
            functionName: "cancelListing",
            args: [intent.listingId],
          }),
        ),
      ];
    case "return-listing":
      return [
        call(
          d.marketplace,
          encodeFunctionData({
            abi: marketplaceAbi,
            functionName: "returnTerminalListing",
            args: [intent.listingId],
          }),
        ),
      ];
    case "resolve":
      return [
        call(
          intent.market,
          encodeFunctionData({
            abi: marketVaultAbi,
            functionName: "resolve",
            args: [BigInt(intent.outcomeId), intent.evidenceHash],
          }),
        ),
      ];
    case "creator-void":
      return [
        call(
          intent.market,
          encodeFunctionData({
            abi: marketVaultAbi,
            functionName: "creatorVoid",
            args: [intent.evidenceHash],
          }),
        ),
      ];
    case "void-timeout":
      return [
        call(
          intent.market,
          encodeFunctionData({
            abi: marketVaultAbi,
            functionName: "voidAfterDeadline",
          }),
        ),
      ];
    case "claim-winner":
      return [
        call(
          intent.market,
          encodeFunctionData({
            abi: marketVaultAbi,
            functionName: "claimWinningsFor",
            args: [account],
          }),
        ),
      ];
    case "claim-early-bird":
      return [
        call(
          intent.market,
          encodeFunctionData({
            abi: marketVaultAbi,
            functionName: "claimEarlyBirdFor",
            args: [account],
          }),
        ),
      ];
    case "refund":
      return [
        call(
          intent.market,
          encodeFunctionData({
            abi: marketVaultAbi,
            functionName: "refundFor",
            args: [account],
          }),
        ),
      ];
    case "claim-timeout-bonus":
      return [
        call(
          intent.market,
          encodeFunctionData({
            abi: marketVaultAbi,
            functionName: "claimTimeoutBonusFor",
            args: [account],
          }),
        ),
      ];
    case "settle-bond":
      return [
        call(
          d.bondEscrow,
          encodeFunctionData({
            abi: bondEscrowAbi,
            functionName: "settleBond",
            args: [intent.market],
          }),
        ),
      ];
    case "claim-bond":
      return [
        call(
          d.bondEscrow,
          encodeFunctionData({
            abi: bondEscrowAbi,
            functionName: "claimFor",
            args: [account],
          }),
        ),
      ];
    case "claim-fees":
      return [
        call(
          d.feeVault,
          encodeFunctionData({
            abi: feeAbi,
            functionName: "claimFor",
            args: [account],
          }),
        ),
      ];
    case "transfer":
      if (sameAddress(intent.recipient, account))
        throw new AppError("self_transfer_not_sponsored");
      return [
        call(
          d.paymentToken,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [intent.recipient, BigInt(intent.amount)],
          }),
        ),
      ];
    case "create-market": {
      const p = intent.params;
      const validated = createMarketInputSchema.parse({
        factory: d.factory,
        userSalt: intent.userSalt,
        params: {
          ...p,
          closeAt: BigInt(p.closeAt),
          eventStartsAt: BigInt(p.eventStartsAt),
          outcomeDeadlineAt: BigInt(p.outcomeDeadlineAt),
          featureFlags: BigInt(p.featureFlags),
          perUserPrimaryCap: BigInt(p.perUserPrimaryCap),
          marketPrimaryCap: BigInt(p.marketPrimaryCap),
          minimumPrimaryUnits: BigInt(p.minimumPrimaryUnits),
          minimumC2CUnits: BigInt(p.minimumC2CUnits),
          creatorBond: BigInt(p.creatorBond),
        },
      });
      const payment = await reader.creationPayment(p);
      if (payment > BigInt(intent.maxPayment))
        throw new AppError("creation_payment_changed", 409);
      return withPayment(
        d.factory,
        payment,
        call(
          d.factory,
          encodeFunctionData({
            abi: marketFactoryAbi,
            functionName: "createMarket",
            args: [validated.params, validated.userSalt],
          }),
        ),
      );
    }
  }
}
