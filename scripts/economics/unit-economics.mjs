const BPS = 10_000n;
const WEI_PER_ETH = 10n ** 18n;
const USD_PRICE_SCALE = 10n ** 8n;
const MAX_UINT256 = (1n << 256n) - 1n;

export function floorDiv(numerator, denominator) {
  assertNonNegative("numerator", numerator);
  assertPositive("denominator", denominator);
  return numerator / denominator;
}

export function ceilDiv(numerator, denominator) {
  assertNonNegative("numerator", numerator);
  assertPositive("denominator", denominator);
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

export function gasCostAtomic(gasUnits, gasPriceWei, ethUsdE8, usdcDecimals) {
  assertUint256("gasUnits", gasUnits);
  assertUint256("gasPriceWei", gasPriceWei);
  assertUint256("ethUsdE8", ethUsdE8);
  assertIntegerInRange("usdcDecimals", usdcDecimals, 0, 18);

  const numerator =
    gasUnits * gasPriceWei * ethUsdE8 * 10n ** BigInt(usdcDecimals);
  const denominator = WEI_PER_ETH * USD_PRICE_SCALE;
  return {
    floor: floorDiv(numerator, denominator),
    ceil: ceilDiv(numerator, denominator),
    exactNumerator: numerator,
    exactDenominator: denominator,
  };
}

export function calculateScenario(input) {
  validateInput(input);
  const unitCost = (gas) =>
    gasCostAtomic(gas, input.gasPriceWei, input.ethUsdE8, input.usdcDecimals);
  const ceilCost = (gas) => unitCost(gas).ceil;
  const floorCost = (gas) => unitCost(gas).floor;

  const gas = input.gasUnits;
  const counts = input.counts;
  const marketCreateGas =
    input.marketMode === "FULL" ? gas.fullMarketCreate : gas.cloneMarketCreate;
  const lifecycleNonTerminalGas =
    marketCreateGas +
    gas.primaryBuy * counts.primaryBuys +
    gas.listingCreate * counts.listings +
    gas.listingFill * counts.fills;

  const resolved = calculateTerminalPath({
    claimantCount: counts.winnerClaimants,
    claimGas: gas.winnerClaim,
    terminalGas: gas.resolve,
    paymasterBatchGas: gas.paymasterValidationPostOpPerBatch,
    input,
    unitCost,
  });
  const voided = calculateTerminalPath({
    claimantCount: counts.voidClaimants,
    claimGas: gas.refundClaim,
    terminalGas: gas.voidFinalize,
    paymasterBatchGas: gas.paymasterValidationPostOpPerBatch,
    input,
    unitCost,
  });
  const timeoutRefunds = calculateTerminalPath({
    claimantCount: counts.voidClaimants,
    claimGas: gas.refundClaim,
    terminalGas: gas.timeoutVoidFinalize + gas.bondSettlement,
    paymasterBatchGas: gas.paymasterValidationPostOpPerBatch,
    input,
    unitCost,
  });
  const timeoutBonuses = calculateTerminalPath({
    claimantCount: counts.timeoutBonusClaimants,
    claimGas: gas.timeoutBonusClaim,
    terminalGas: 0n,
    paymasterBatchGas: gas.paymasterValidationPostOpPerBatch,
    input,
    unitCost,
  });
  const timeoutVoided = combineTimeoutPaths(
    timeoutRefunds,
    timeoutBonuses,
    input.sponsorBudgetAtomic,
  );

  const rakeAtomic = floorDiv(input.poolPrincipalAtomic * input.rakeBps, BPS);
  const resolvedSettlementCostCeil =
    resolved.totalCostAtomic.budgetedComponentCeil;
  const resolvedLifecycleCostCeil =
    ceilCost(lifecycleNonTerminalGas) + resolvedSettlementCostCeil;
  const voidLifecycleCostCeil =
    ceilCost(lifecycleNonTerminalGas) +
    voided.totalCostAtomic.budgetedComponentCeil;
  const timeoutLifecycleCostCeil =
    ceilCost(lifecycleNonTerminalGas) +
    timeoutVoided.totalCostAtomic.budgetedComponentCeil;
  const minBreakEvenSettlementPool = minimumPrincipalForRake(
    resolvedSettlementCostCeil,
    input.rakeBps,
  );
  const minBreakEvenLifecyclePool = minimumPrincipalForRake(
    resolvedLifecycleCostCeil,
    input.rakeBps,
  );

  return {
    id: input.id,
    marketMode: input.marketMode,
    assumptions: {
      gasPriceWei: input.gasPriceWei,
      ethUsdE8: input.ethUsdE8,
      usdcDecimals: input.usdcDecimals,
      poolPrincipalAtomic: input.poolPrincipalAtomic,
      rakeBps: input.rakeBps,
      sponsorShareBps: input.sponsorShareBps,
      sponsorBudgetAtomic: input.sponsorBudgetAtomic,
      aaBatchSize: input.aaBatchSize,
      sponsorFinalization: input.sponsorFinalization,
    },
    rakeAtomic,
    lifecycleNonTerminal: {
      gasUnits: lifecycleNonTerminalGas,
      costAtomic: unitCost(lifecycleNonTerminalGas),
    },
    resolved,
    voided,
    timeoutVoided,
    economics: {
      resolvedSettlementRakeCoverageBps: coverageBps(
        rakeAtomic,
        resolvedSettlementCostCeil,
      ),
      resolvedLifecycleRakeCoverageBps: coverageBps(
        rakeAtomic,
        resolvedLifecycleCostCeil,
      ),
      minimumBreakEvenSettlementPoolAtomic: minBreakEvenSettlementPool,
      minimumBreakEvenLifecyclePoolAtomic: minBreakEvenLifecyclePool,
      resolvedLifecycleCostAtomicCeil: resolvedLifecycleCostCeil,
      voidLifecycleCostAtomicCeil: voidLifecycleCostCeil,
      timeoutVoidLifecycleCostAtomicCeil: timeoutLifecycleCostCeil,
      resolvedNetAfterSettlementAtomic: rakeAtomic - resolvedSettlementCostCeil,
      resolvedNetAfterLifecycleAtomic: rakeAtomic - resolvedLifecycleCostCeil,
    },
  };
}

function calculateTerminalPath({
  claimantCount,
  claimGas,
  terminalGas,
  paymasterBatchGas,
  input,
  unitCost,
}) {
  const sponsoredClaims = ceilDiv(claimantCount * input.sponsorShareBps, BPS);
  const userPaidClaims = claimantCount - sponsoredClaims;
  const sponsoredBatches = ceilDiv(sponsoredClaims, input.aaBatchSize);
  const allClaimsGas = claimantCount * claimGas;
  const paymasterGas = sponsoredBatches * paymasterBatchGas;
  const totalGas = terminalGas + allClaimsGas + paymasterGas;
  const terminalCostCeil = unitCost(terminalGas).ceil;
  const sponsoredClaimCostCeil = unitCost(sponsoredClaims * claimGas).ceil;
  const paymasterCostCeil = unitCost(paymasterGas).ceil;
  const sponsorFinalizationCostCeil = input.sponsorFinalization
    ? terminalCostCeil
    : 0n;
  const sponsorCostCeil =
    sponsorFinalizationCostCeil + sponsoredClaimCostCeil + paymasterCostCeil;
  const operatorCostCeil = input.sponsorFinalization ? 0n : terminalCostCeil;
  const userCostCeil = unitCost(userPaidClaims * claimGas).ceil;
  const budgetedComponentCeil =
    sponsorCostCeil + operatorCostCeil + userCostCeil;
  const aggregateCost = unitCost(totalGas);
  const maxSubsidizedClaimCount = maximumClaimsWithinBudget({
    budgetAtomic: input.sponsorBudgetAtomic,
    fixedCostAtomic: sponsorFinalizationCostCeil,
    claimGas,
    paymasterBatchGas,
    aaBatchSize: input.aaBatchSize,
    unitCost,
  });

  return {
    claimantCount,
    sponsoredClaims,
    userPaidClaims,
    sponsoredBatches,
    gasUnits: {
      terminalFinalize: terminalGas,
      claims: allClaimsGas,
      paymasterBatches: paymasterGas,
      total: totalGas,
    },
    perClaimCostAtomic: unitCost(claimGas),
    totalCostAtomic: {
      aggregateFloor: aggregateCost.floor,
      aggregateCeil: aggregateCost.ceil,
      budgetedComponentCeil,
    },
    payerCostAtomicCeil: {
      sponsor: sponsorCostCeil,
      operator: operatorCostCeil,
      users: userCostCeil,
    },
    sponsorBudget: {
      requiredAtomicCeil: sponsorCostCeil,
      availableAtomic: input.sponsorBudgetAtomic,
      sufficient: sponsorCostCeil <= input.sponsorBudgetAtomic,
      maximumFullySubsidizedClaims: maxSubsidizedClaimCount,
    },
  };
}

function combineTimeoutPaths(refunds, bonuses, sponsorBudgetAtomic) {
  const sponsor =
    refunds.payerCostAtomicCeil.sponsor + bonuses.payerCostAtomicCeil.sponsor;
  const operator =
    refunds.payerCostAtomicCeil.operator + bonuses.payerCostAtomicCeil.operator;
  const users =
    refunds.payerCostAtomicCeil.users + bonuses.payerCostAtomicCeil.users;
  return {
    refunds,
    bonuses,
    gasUnits: refunds.gasUnits.total + bonuses.gasUnits.total,
    totalCostAtomic: {
      aggregateFloor:
        refunds.totalCostAtomic.aggregateFloor +
        bonuses.totalCostAtomic.aggregateFloor,
      aggregateCeil:
        refunds.totalCostAtomic.aggregateCeil +
        bonuses.totalCostAtomic.aggregateCeil,
      budgetedComponentCeil: sponsor + operator + users,
    },
    payerCostAtomicCeil: { sponsor, operator, users },
    sponsorBudget: {
      requiredAtomicCeil: sponsor,
      availableAtomic: sponsorBudgetAtomic,
      sufficient: sponsor <= sponsorBudgetAtomic,
      maximumRefundClaimsIfExclusivelyFunded:
        refunds.sponsorBudget.maximumFullySubsidizedClaims,
      maximumBonusClaimsIfExclusivelyFunded:
        bonuses.sponsorBudget.maximumFullySubsidizedClaims,
    },
  };
}

export function maximumClaimsWithinBudget({
  budgetAtomic,
  fixedCostAtomic,
  claimGas,
  paymasterBatchGas,
  aaBatchSize,
  unitCost,
}) {
  assertUint256("budgetAtomic", budgetAtomic);
  assertUint256("fixedCostAtomic", fixedCostAtomic);
  assertUint256("claimGas", claimGas);
  assertUint256("paymasterBatchGas", paymasterBatchGas);
  assertPositive("aaBatchSize", aaBatchSize);
  if (fixedCostAtomic > budgetAtomic || claimGas === 0n) return 0n;

  const cost = (claimCount) => {
    const batches = ceilDiv(claimCount, aaBatchSize);
    return (
      fixedCostAtomic +
      unitCost(claimCount * claimGas).ceil +
      unitCost(batches * paymasterBatchGas).ceil
    );
  };

  let low = 0n;
  let high = 1n;
  while (cost(high) <= budgetAtomic) {
    low = high;
    high *= 2n;
    if (high > MAX_UINT256) {
      high = MAX_UINT256;
      break;
    }
  }
  while (low + 1n < high) {
    const mid = low + (high - low) / 2n;
    if (cost(mid) <= budgetAtomic) low = mid;
    else high = mid;
  }
  return cost(high) <= budgetAtomic ? high : low;
}

export function minimumPrincipalForRake(costAtomic, rakeBps) {
  assertUint256("costAtomic", costAtomic);
  assertIntegerBigIntInRange("rakeBps", rakeBps, 1n, BPS);
  return ceilDiv(costAtomic * BPS, rakeBps);
}

export function coverageBps(availableAtomic, costAtomic) {
  assertUint256("availableAtomic", availableAtomic);
  assertUint256("costAtomic", costAtomic);
  return costAtomic === 0n ? BPS : floorDiv(availableAtomic * BPS, costAtomic);
}

export function stringifyBigInts(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stringifyBigInts);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, stringifyBigInts(item)]),
    );
  }
  return value;
}

function validateInput(input) {
  if (!input || typeof input !== "object")
    throw new TypeError("input must be an object");
  if (typeof input.id !== "string" || input.id.length === 0)
    throw new TypeError("id must be non-empty");
  if (input.marketMode !== "FULL" && input.marketMode !== "CLONE")
    throw new RangeError("marketMode must be FULL or CLONE");
  assertIntegerInRange("usdcDecimals", input.usdcDecimals, 0, 18);
  for (const key of [
    "gasPriceWei",
    "ethUsdE8",
    "poolPrincipalAtomic",
    "sponsorBudgetAtomic",
  ]) {
    assertUint256(key, input[key]);
  }
  assertIntegerBigIntInRange("rakeBps", input.rakeBps, 1n, BPS);
  assertIntegerBigIntInRange("sponsorShareBps", input.sponsorShareBps, 0n, BPS);
  assertPositive("aaBatchSize", input.aaBatchSize);
  if (typeof input.sponsorFinalization !== "boolean")
    throw new TypeError("sponsorFinalization must be boolean");
  const gasKeys = [
    "fullMarketCreate",
    "cloneMarketCreate",
    "primaryBuy",
    "listingCreate",
    "listingFill",
    "resolve",
    "voidFinalize",
    "timeoutVoidFinalize",
    "bondSettlement",
    "winnerClaim",
    "refundClaim",
    "timeoutBonusClaim",
    "paymasterValidationPostOpPerBatch",
  ];
  for (const key of gasKeys)
    assertUint256(`gasUnits.${key}`, input.gasUnits?.[key]);
  const countKeys = [
    "primaryBuys",
    "listings",
    "fills",
    "winnerClaimants",
    "voidClaimants",
    "timeoutBonusClaimants",
  ];
  for (const key of countKeys)
    assertUint256(`counts.${key}`, input.counts?.[key]);
}

function assertUint256(name, value) {
  if (typeof value !== "bigint") throw new TypeError(`${name} must be bigint`);
  if (value < 0n || value > MAX_UINT256)
    throw new RangeError(`${name} must fit uint256`);
}

function assertNonNegative(name, value) {
  if (typeof value !== "bigint" || value < 0n)
    throw new RangeError(`${name} must be a non-negative bigint`);
}

function assertPositive(name, value) {
  if (typeof value !== "bigint" || value <= 0n)
    throw new RangeError(`${name} must be a positive bigint`);
}

function assertIntegerInRange(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer in [${minimum}, ${maximum}]`,
    );
  }
}

function assertIntegerBigIntInRange(name, value, minimum, maximum) {
  if (typeof value !== "bigint" || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be a bigint in [${minimum}, ${maximum}]`,
    );
  }
}
