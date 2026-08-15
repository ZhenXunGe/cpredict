export const FORMAL_GATE_UPPER_BOUND_GAS = Object.freeze({
  fullMarketCreate: 7_999_999n,
  cloneMarketCreate: 599_999n,
  primaryBuy: 299_999n,
  listingCreate: 229_999n,
  listingFill: 349_999n,
  winnerClaim: 249_999n,
  refundClaim: 249_999n,
  paymasterValidationPostOpPerBatch: 149_999n,
});

// No executable gas gate currently covers terminal finalize. This is a trial acceptance ceiling,
// deliberately isolated from FORMAL_GATE_UPPER_BOUND_GAS so it cannot be mistaken for evidence.
export const UNVERIFIED_TRIAL_FINALIZE_GAS = Object.freeze({
  resolve: 249_999n,
  voidFinalize: 249_999n,
  timeoutVoidFinalize: 249_999n,
  bondSettlement: 249_999n,
  timeoutBonusClaim: 249_999n,
});

const common = {
  gasUnits: {
    ...FORMAL_GATE_UPPER_BOUND_GAS,
    ...UNVERIFIED_TRIAL_FINALIZE_GAS,
  },
  gasPriceWei: 10_000_000n, // 0.01 gwei, sensitivity input only; not a Base price claim.
  ethUsdE8: 3000n * 100_000_000n, // 3,000 USD, sensitivity input only; not a forecast.
  usdcDecimals: 6,
  rakeBps: 500n,
  sponsorShareBps: 10_000n,
  aaBatchSize: 32n,
  sponsorFinalization: true,
};

export const trialScenarios = Object.freeze([
  {
    ...common,
    id: "trial-full-5000",
    marketMode: "FULL",
    poolPrincipalAtomic: 5_000_000_000n,
    sponsorBudgetAtomic: 100_000_000n,
    counts: {
      primaryBuys: 100n,
      listings: 20n,
      fills: 20n,
      winnerClaimants: 50n,
      voidClaimants: 100n,
      timeoutBonusClaimants: 100n,
    },
  },
  {
    ...common,
    id: "trial-clone-500",
    marketMode: "CLONE",
    poolPrincipalAtomic: 500_000_000n,
    sponsorBudgetAtomic: 25_000_000n,
    counts: {
      primaryBuys: 20n,
      listings: 5n,
      fills: 5n,
      winnerClaimants: 10n,
      voidClaimants: 20n,
      timeoutBonusClaimants: 20n,
    },
  },
]);

export const sensitivityGasPricesWei = Object.freeze([
  1_000_000n,
  10_000_000n,
  100_000_000n,
]);
export const sensitivityEthUsdE8 = Object.freeze([
  1000n * 100_000_000n,
  3000n * 100_000_000n,
  6000n * 100_000_000n,
]);
