import { orderbookAbi, bidReserve } from "../../sdk/src/orderbook.js";
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
  order?(
    id: bigint,
  ): Promise<{
    market: Address;
    owner: Address;
    side: number;
    outcomeId: number;
    active: boolean;
  }>;
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
  let order:
    | Awaited<ReturnType<NonNullable<AdmissionReader["order"]>>>
    | undefined;
  if (intent.kind.endsWith("-order")) {
    if (d.marketplaceVersion !== "orderbook-v2")
      throw new AppError("orderbook_not_supported", 400);
    if ("orderId" in intent) {
      if (!reader.order)
        throw new AppError("orderbook_reader_unavailable", 503);
      order = await reader.order(BigInt(intent.orderId));
      market = order.market;
      if (!order.active) throw new AppError("order_unavailable", 409);
      if (
        (intent.kind === "cancel-order" || intent.kind === "release-order") &&
        !sameAddress(order.owner, account)
      )
        throw new AppError("order_owner_mismatch", 403);
      if (intent.kind === "fill-order" && sameAddress(order.owner, account))
        throw new AppError("self_trade_not_sponsored");
    }
  }
  if (
    d.marketplaceVersion === "orderbook-v2" &&
    ("listingId" in intent || intent.kind === "create-listing")
  )
    throw new AppError("legacy_listing_not_supported", 400);
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
  const withShares = (vault: Address, action: BusinessCall): BusinessCall[] => [
    call(
      vault,
      encodeFunctionData({
        abi: marketVaultAbi,
        functionName: "setApprovalForAll",
        args: [d.marketplace, true],
      }),
    ),
    action,
    call(
      vault,
      encodeFunctionData({
        abi: marketVaultAbi,
        functionName: "setApprovalForAll",
        args: [d.marketplace, false],
      }),
    ),
  ];
  switch (intent.kind) {
    case "create-order": {
      if (
        BigInt(intent.expiresAt) <= nowSeconds ||
        BigInt(intent.outcomeId) > 31n ||
        BigInt(intent.units) > 2n ** 128n - 1n ||
        BigInt(intent.unitPrice) > 1_000_000_000n
      )
        throw new AppError("invalid_order");
      const action = call(
        d.marketplace,
        encodeFunctionData({
          abi: orderbookAbi,
          functionName: "createOrder",
          args: [
            intent.market,
            Number(intent.outcomeId),
            intent.side === "bid" ? 0 : 1,
            BigInt(intent.units),
            BigInt(intent.unitPrice),
            BigInt(intent.expiresAt),
            intent.autoMatch,
          ],
        }),
      );
      return intent.side === "bid"
        ? withPayment(
            d.marketplace,
            bidReserve(BigInt(intent.units), BigInt(intent.unitPrice)),
            action,
          )
        : withShares(intent.market, action);
    }
    case "fill-order": {
      if (!order) throw new AppError("order_unavailable");
      if (order.side !== (intent.side === "bid" ? 0 : 1))
        throw new AppError("order_side_mismatch", 409);
      const action = call(
        d.marketplace,
        encodeFunctionData({
          abi: orderbookAbi,
          functionName: "fillOrder",
          args: [
            BigInt(intent.orderId),
            BigInt(intent.units),
            BigInt(intent.minUnits),
            BigInt(intent.paymentLimit),
            BigInt(intent.deadline),
          ],
        }),
      );
      return order.side === 1
        ? withPayment(d.marketplace, BigInt(intent.paymentLimit), action)
        : withShares(order.market, action);
    }
    case "cancel-order":
    case "release-order":
      return [
        call(
          d.marketplace,
          encodeFunctionData({
            abi: orderbookAbi,
            functionName:
              intent.kind === "cancel-order" ? "cancelOrder" : "releaseOrder",
            args: [BigInt(intent.orderId)],
          }),
        ),
      ];

    case "revoke-trading-session":
      throw new AppError("session_descriptor_required", 400);
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
    case "settle-bond-and-claim":
      return [
        call(
          d.bondEscrow,
          encodeFunctionData({
            abi: bondEscrowAbi,
            functionName: "settleBond",
            args: [intent.market],
          }),
        ),
        call(
          d.bondEscrow,
          encodeFunctionData({
            abi: bondEscrowAbi,
            functionName: "claimFor",
            args: [account],
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
        platformFees: intent.platformFees,
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
          validated.platformFees
            ? encodeFunctionData({
                abi: marketFactoryAbi,
                functionName: "createMarketWithPlatformFees",
                args: [
                  validated.params,
                  validated.userSalt,
                  validated.platformFees.rakeShareBps,
                  validated.platformFees.c2cFeeBps,
                ],
              })
            : encodeFunctionData({
                abi: marketFactoryAbi,
                functionName: "createMarket",
                args: [validated.params, validated.userSalt],
              }),
        ),
      );
    }
  }
}
