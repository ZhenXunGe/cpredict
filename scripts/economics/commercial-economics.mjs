import { createHash } from "node:crypto";

const BPS = 10_000n;
const WEI_PER_ETH = 10n ** 18n;
const USD_E8 = 10n ** 8n;
const USDC_SCALE = 10n ** 6n;
const UINT_PATTERN = /^(0|[1-9][0-9]*)$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const BASE_CHAIN_IDS = new Set([8453, 84532]);
const MODES = ["FULL", "CLONE"];
const EXIT_OPERATIONS = [
  "RESOLVE",
  "CREATOR_VOID",
  "TIMEOUT_VOID",
  "BOND_SETTLE",
  "WINNER_CLAIM",
  "REFUND_CLAIM",
  "LISTING_CANCEL",
  "TERMINAL_RETURN",
  "TIMEOUT_BONUS_CLAIM",
];
const RECEIPT_OPERATIONS = new Set([...EXIT_OPERATIONS, "PAYMASTER_OVERHEAD"]);
const REQUIRED_DEPLOYMENT_COMPONENTS = [
  "ProtocolConfigV1",
  "MarketFactoryV1",
  "FullMarketVaultV1",
  "CloneMarketVaultV1",
  "MarketplaceV1",
  "BondEscrowV1",
  "SponsorshipPaymasterV1",
  "LaunchExposureGuardV1",
];
const VAULT_RECEIPT_OPERATIONS = new Set([
  "RESOLVE",
  "CREATOR_VOID",
  "TIMEOUT_VOID",
  "WINNER_CLAIM",
  "REFUND_CLAIM",
  "TIMEOUT_BONUS_CLAIM",
]);
const OPERATION_COMPONENTS = Object.freeze({
  BOND_SETTLE: "BondEscrowV1",
  PAYMASTER_OVERHEAD: "SponsorshipPaymasterV1",
  LISTING_CANCEL: "MarketplaceV1",
  TERMINAL_RETURN: "MarketplaceV1",
});
const RAKE_FUNDING_SCOPES = new Set([
  "GROSS_RAKE",
  "PROTOCOL_FEE",
  "CREATOR_NET_AFTER_EARLY_BIRD",
]);
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const CODE_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export const V1_FIXED_PARAMETERS = Object.freeze({
  usdcDecimals: 6,
  minimumCreatorBondAtomic: 10_000_000n,
  creatorBondRateBps: 200n,
  fullMarketCapAtomic: 5_000_000_000n,
  cloneMarketCapAtomic: 500_000_000n,
});

export function floorDiv(numerator, denominator) {
  assertNonNegativeBigInt("numerator", numerator);
  assertPositiveBigInt("denominator", denominator);
  return numerator / denominator;
}

export function ceilDiv(numerator, denominator) {
  assertNonNegativeBigInt("numerator", numerator);
  assertPositiveBigInt("denominator", denominator);
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

export function mulDivFloor(a, b, denominator) {
  return floorDiv(a * b, denominator);
}

export function mulDivCeil(a, b, denominator) {
  return ceilDiv(a * b, denominator);
}

export function nearestRank(values, percentileBps) {
  if (!Array.isArray(values) || values.length === 0)
    throw new RangeError("percentile values must be non-empty");
  assertBigIntRange("percentileBps", percentileBps, 1n, BPS);
  for (const value of values)
    assertNonNegativeBigInt("percentile value", value);
  const sorted = [...values].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const rank = ceilDiv(BigInt(sorted.length) * percentileBps, BPS);
  return sorted[Number(rank - 1n)];
}

export function requiredCreatorBondAtomic(capAtomic) {
  assertNonNegativeBigInt("capAtomic", capAtomic);
  const proportional = mulDivCeil(
    capAtomic,
    V1_FIXED_PARAMETERS.creatorBondRateBps,
    BPS,
  );
  return proportional > V1_FIXED_PARAMETERS.minimumCreatorBondAtomic
    ? proportional
    : V1_FIXED_PARAMETERS.minimumCreatorBondAtomic;
}

export function weiToUsdcAtomicCeil(amountWei, ethUsdE8) {
  assertNonNegativeBigInt("amountWei", amountWei);
  assertPositiveBigInt("ethUsdE8", ethUsdE8);
  return ceilDiv(amountWei * ethUsdE8 * USDC_SCALE, WEI_PER_ETH * USD_E8);
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function sha256Document(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function validateCommercialEconomicsInput(input) {
  requireObject("input", input);
  requireAllowedKeys("input", input, [
    "$schema",
    "schemaVersion",
    "assessmentId",
    "assessmentTime",
    "validUntil",
    "subject",
    "deploymentBinding",
    "configurationEvidence",
    "ethUsdEvidence",
    "baseReceipts",
    "gasPriceEvidence",
    "bondEvidence",
    "microPoolEvidence",
    "marketCapEvidence",
    "earlyBirdEvidence",
    "c2cEvidence",
    "launchGuardEvidence",
  ]);
  requireExact(input.schemaVersion, 1, "input.schemaVersion");
  requireNonEmptyString("input.assessmentId", input.assessmentId);
  if (!ISO_UTC_PATTERN.test(input.assessmentTime))
    throw new TypeError("input.assessmentTime must be an ISO UTC timestamp");
  if (!ISO_UTC_PATTERN.test(input.validUntil))
    throw new TypeError("input.validUntil must be an ISO UTC timestamp");
  if (Date.parse(input.validUntil) < Date.parse(input.assessmentTime))
    throw new RangeError("input.validUntil must not precede assessmentTime");
  requireObject("input.subject", input.subject);
  requireAllowedKeys("input.subject", input.subject, [
    "chainId",
    "usdcDecimals",
    "v1",
  ]);
  if (!BASE_CHAIN_IDS.has(input.subject.chainId))
    throw new RangeError(
      "input.subject.chainId must be Base mainnet or Base Sepolia",
    );
  requireExact(
    input.subject.usdcDecimals,
    V1_FIXED_PARAMETERS.usdcDecimals,
    "input.subject.usdcDecimals",
  );
  requireObject("input.subject.v1", input.subject.v1);
  requireAllowedKeys("input.subject.v1", input.subject.v1, [
    "minimumCreatorBondAtomic",
    "creatorBondRateBps",
    "fullMarketCapAtomic",
    "cloneMarketCapAtomic",
    "creatorRakeBps",
    "protocolShareBps",
    "earlyBirdShareBps",
    "platformC2CFeeBps",
    "creatorC2CFeeBps",
  ]);
  requireFixedUint(
    "minimumCreatorBondAtomic",
    input.subject.v1,
    V1_FIXED_PARAMETERS.minimumCreatorBondAtomic,
  );
  requireFixedUint(
    "creatorBondRateBps",
    input.subject.v1,
    V1_FIXED_PARAMETERS.creatorBondRateBps,
  );
  requireFixedUint(
    "fullMarketCapAtomic",
    input.subject.v1,
    V1_FIXED_PARAMETERS.fullMarketCapAtomic,
  );
  requireFixedUint(
    "cloneMarketCapAtomic",
    input.subject.v1,
    V1_FIXED_PARAMETERS.cloneMarketCapAtomic,
  );
  requireUintRange(
    "creatorRakeBps",
    input.subject.v1.creatorRakeBps,
    0n,
    1_000n,
  );
  requireUintRange(
    "protocolShareBps",
    input.subject.v1.protocolShareBps,
    0n,
    5_000n,
  );
  requireUintRange(
    "earlyBirdShareBps",
    input.subject.v1.earlyBirdShareBps,
    0n,
    5_000n,
  );
  requireUintRange(
    "platformC2CFeeBps",
    input.subject.v1.platformC2CFeeBps,
    0n,
    200n,
  );
  requireUintRange(
    "creatorC2CFeeBps",
    input.subject.v1.creatorC2CFeeBps,
    0n,
    200n,
  );

  requireEvidenceSection("input.deploymentBinding", input.deploymentBinding, [
    "sourceManifestSha256",
    "auditCommit",
    "deployments",
  ]);
  if (
    !SHA256_PATTERN.test(input.deploymentBinding.sourceManifestSha256) &&
    input.deploymentBinding.sourceManifestSha256 !== ""
  ) {
    throw new TypeError(
      "input.deploymentBinding.sourceManifestSha256 must be blank or sha256:<hex>",
    );
  }
  if (
    !COMMIT_PATTERN.test(input.deploymentBinding.auditCommit) &&
    input.deploymentBinding.auditCommit !== ""
  ) {
    throw new TypeError(
      "input.deploymentBinding.auditCommit must be blank or a 40-character lowercase commit",
    );
  }
  requireArray(
    "input.deploymentBinding.deployments",
    input.deploymentBinding.deployments,
  );
  for (const [
    index,
    deployment,
  ] of input.deploymentBinding.deployments.entries()) {
    requireObject(`input.deploymentBinding.deployments[${index}]`, deployment);
    requireAllowedKeys(
      `input.deploymentBinding.deployments[${index}]`,
      deployment,
      ["component", "address", "runtimeCodeHash"],
    );
    requireNonEmptyString(
      `input.deploymentBinding.deployments[${index}].component`,
      deployment.component,
    );
    if (!ADDRESS_PATTERN.test(deployment.address))
      throw new TypeError(
        `input.deploymentBinding.deployments[${index}].address must be 20-byte hex`,
      );
    if (!CODE_HASH_PATTERN.test(deployment.runtimeCodeHash))
      throw new TypeError(
        `input.deploymentBinding.deployments[${index}].runtimeCodeHash must be 32-byte hex`,
      );
  }
  requireUnique(
    input.deploymentBinding.deployments.map(
      (deployment) => deployment.component,
    ),
    "input.deploymentBinding deployment components",
  );
  requireUnique(
    input.deploymentBinding.deployments.map((deployment) =>
      deployment.address.toLowerCase(),
    ),
    "input.deploymentBinding deployment addresses",
  );

  requireEvidenceSection(
    "input.configurationEvidence",
    input.configurationEvidence,
    ["observedBlockNumber", "rpcVerified", "marketSnapshots"],
  );
  requirePositiveUintString(
    "input.configurationEvidence.observedBlockNumber",
    input.configurationEvidence.observedBlockNumber,
  );
  if (
    input.configurationEvidence.rpcVerified !== true &&
    input.configurationEvidence.rpcVerified !== false
  ) {
    throw new TypeError(
      "input.configurationEvidence.rpcVerified must be boolean",
    );
  }
  requireArray(
    "input.configurationEvidence.marketSnapshots",
    input.configurationEvidence.marketSnapshots,
  );
  for (const [
    index,
    snapshot,
  ] of input.configurationEvidence.marketSnapshots.entries()) {
    const prefix = `input.configurationEvidence.marketSnapshots[${index}]`;
    requireObject(prefix, snapshot);
    requireAllowedKeys(prefix, snapshot, [
      "mode",
      "vaultAddress",
      "runtimeCodeHash",
      "marketPrimaryCapAtomic",
      "creatorRakeBps",
      "protocolShareBps",
      "earlyBirdShareBps",
      "platformC2CFeeBps",
      "creatorC2CFeeBps",
    ]);
    validateMode(`${prefix}.mode`, snapshot.mode);
    if (!ADDRESS_PATTERN.test(snapshot.vaultAddress))
      throw new TypeError(`${prefix}.vaultAddress must be 20-byte hex`);
    if (!CODE_HASH_PATTERN.test(snapshot.runtimeCodeHash))
      throw new TypeError(`${prefix}.runtimeCodeHash must be 32-byte hex`);
    for (const key of [
      "marketPrimaryCapAtomic",
      "creatorRakeBps",
      "protocolShareBps",
      "earlyBirdShareBps",
      "platformC2CFeeBps",
      "creatorC2CFeeBps",
    ]) {
      requireUintString(`${prefix}.${key}`, snapshot[key]);
    }
  }
  requireUnique(
    input.configurationEvidence.marketSnapshots.map(
      (snapshot) => snapshot.mode,
    ),
    "input.configurationEvidence snapshot modes",
  );

  requireEvidenceSection("input.ethUsdEvidence", input.ethUsdEvidence, [
    "ethUsdE8",
    "observedAt",
    "validUntil",
  ]);
  requireUintString(
    "input.ethUsdEvidence.ethUsdE8",
    input.ethUsdEvidence.ethUsdE8,
  );
  for (const key of ["observedAt", "validUntil"]) {
    if (typeof input.ethUsdEvidence[key] !== "string")
      throw new TypeError(`input.ethUsdEvidence.${key} must be string`);
    if (
      input.ethUsdEvidence[key] !== "" &&
      !ISO_UTC_PATTERN.test(input.ethUsdEvidence[key])
    )
      throw new TypeError(
        `input.ethUsdEvidence.${key} must be blank or ISO UTC`,
      );
  }

  requireEvidenceSection("input.baseReceipts", input.baseReceipts, [
    "receipts",
  ]);
  requireArray("input.baseReceipts.receipts", input.baseReceipts.receipts);
  for (const [index, receipt] of input.baseReceipts.receipts.entries())
    validateReceipt(receipt, index, input.subject.chainId);
  requireUnique(
    input.baseReceipts.receipts.map(
      (receipt) =>
        `${receipt.transactionHash.toLowerCase()}:${receipt.operation}`,
    ),
    "input.baseReceipts receipt operation keys",
  );

  requireEvidenceSection("input.gasPriceEvidence", input.gasPriceEvidence, [
    "samplesWei",
  ]);
  requireArray(
    "input.gasPriceEvidence.samplesWei",
    input.gasPriceEvidence.samplesWei,
  );
  input.gasPriceEvidence.samplesWei.forEach((value, index) =>
    requirePositiveUintString(`gasPriceEvidence.samplesWei[${index}]`, value),
  );

  requireEvidenceSection("input.bondEvidence", input.bondEvidence, ["cohorts"]);
  requireArray("input.bondEvidence.cohorts", input.bondEvidence.cohorts);
  for (const [index, cohort] of input.bondEvidence.cohorts.entries()) {
    requireObject(`bondEvidence.cohorts[${index}]`, cohort);
    requireAllowedKeys(`bondEvidence.cohorts[${index}]`, cohort, [
      "mode",
      "sampleCount",
      "observedAttackProfitP95Atomic",
      "incidentResponseCostP95Atomic",
    ]);
    validateMode(`bondEvidence.cohorts[${index}].mode`, cohort.mode);
    for (const key of [
      "sampleCount",
      "observedAttackProfitP95Atomic",
      "incidentResponseCostP95Atomic",
    ]) {
      requireUintString(`bondEvidence.cohorts[${index}].${key}`, cohort[key]);
    }
  }
  requireUnique(
    input.bondEvidence.cohorts.map((cohort) => cohort.mode),
    "input.bondEvidence cohort modes",
  );

  requireEvidenceSection("input.microPoolEvidence", input.microPoolEvidence, [
    "mode",
    "principalAtomic",
    "expectedClaimantCount",
    "paymasterSponsoredShareBps",
    "earlyBirdEnabled",
  ]);
  validateMode("microPoolEvidence.mode", input.microPoolEvidence.mode);
  for (const key of [
    "principalAtomic",
    "expectedClaimantCount",
    "paymasterSponsoredShareBps",
  ]) {
    requireUintString(`microPoolEvidence.${key}`, input.microPoolEvidence[key]);
  }
  if (typeof input.microPoolEvidence.earlyBirdEnabled !== "boolean")
    throw new TypeError("microPoolEvidence.earlyBirdEnabled must be boolean");
  requireUintRange(
    "microPoolEvidence.paymasterSponsoredShareBps",
    input.microPoolEvidence.paymasterSponsoredShareBps,
    0n,
    BPS,
  );

  requireEvidenceSection("input.marketCapEvidence", input.marketCapEvidence, [
    "cohorts",
  ]);
  requireArray(
    "input.marketCapEvidence.cohorts",
    input.marketCapEvidence.cohorts,
  );
  for (const [index, cohort] of input.marketCapEvidence.cohorts.entries()) {
    requireObject(`marketCapEvidence.cohorts[${index}]`, cohort);
    requireAllowedKeys(`marketCapEvidence.cohorts[${index}]`, cohort, [
      "mode",
      "sampleCount",
      "p95PeakPrincipalAtomic",
      "capDeniedOrders",
      "eligibleOrders",
      "unrecoveredLossAtomic",
    ]);
    validateMode(`marketCapEvidence.cohorts[${index}].mode`, cohort.mode);
    for (const key of [
      "sampleCount",
      "p95PeakPrincipalAtomic",
      "capDeniedOrders",
      "eligibleOrders",
      "unrecoveredLossAtomic",
    ]) {
      requireUintString(
        `marketCapEvidence.cohorts[${index}].${key}`,
        cohort[key],
      );
    }
  }
  requireUnique(
    input.marketCapEvidence.cohorts.map((cohort) => cohort.mode),
    "input.marketCapEvidence cohort modes",
  );

  requireEvidenceSection("input.earlyBirdEvidence", input.earlyBirdEvidence, [
    "walletCount",
    "flaggedWalletCount",
    "totalEarlyPrincipalAtomic",
    "flaggedEarlyPrincipalAtomic",
    "totalEarlyRewardAtomic",
    "flaggedEarlyRewardAtomic",
  ]);
  for (const key of [
    "walletCount",
    "flaggedWalletCount",
    "totalEarlyPrincipalAtomic",
    "flaggedEarlyPrincipalAtomic",
    "totalEarlyRewardAtomic",
    "flaggedEarlyRewardAtomic",
  ])
    requireUintString(`earlyBirdEvidence.${key}`, input.earlyBirdEvidence[key]);

  requireEvidenceSection("input.c2cEvidence", input.c2cEvidence, [
    "matchedCohorts",
    "baseline",
    "candidate",
  ]);
  if (typeof input.c2cEvidence.matchedCohorts !== "boolean")
    throw new TypeError("c2cEvidence.matchedCohorts must be boolean");
  validateC2cCohort("c2cEvidence.baseline", input.c2cEvidence.baseline);
  validateC2cCohort("c2cEvidence.candidate", input.c2cEvidence.candidate);

  requireEvidenceSection(
    "input.launchGuardEvidence",
    input.launchGuardEvidence,
    [
      "observationDays",
      "marketCount",
      "accountingMismatchCount",
      "guardBypassIncidentCount",
      "unrecoveredIncidentCount",
      "capDeniedOrders",
      "eligibleOrders",
      "p95ExposureUtilizationBps",
    ],
  );
  for (const key of [
    "observationDays",
    "marketCount",
    "accountingMismatchCount",
    "guardBypassIncidentCount",
    "unrecoveredIncidentCount",
    "capDeniedOrders",
    "eligibleOrders",
    "p95ExposureUtilizationBps",
  ])
    requireUintString(
      `launchGuardEvidence.${key}`,
      input.launchGuardEvidence[key],
    );
  requireUintRange(
    "launchGuardEvidence.p95ExposureUtilizationBps",
    input.launchGuardEvidence.p95ExposureUtilizationBps,
    0n,
    BPS,
  );
  return input;
}

export function validateCommercialEconomicsPolicy(policy) {
  requireObject("policy", policy);
  requireExact(policy.schemaVersion, 1, "policy.schemaVersion");
  requireNonEmptyString("policy.policyId", policy.policyId);
  requirePositiveUintString(
    "policy.maximumAssessmentValiditySeconds",
    policy.maximumAssessmentValiditySeconds,
  );
  const definitions = {
    bondDeterrence: ["minimumSamplesPerMode", "minimumCoverageBps"],
    microPoolRake: [
      "minimumReceiptsPerOperation",
      "minimumRakeCoverageBps",
      "committedFundingShareBps",
    ],
    marketCaps: [
      "minimumSamplesPerMode",
      "minimumP95UtilizationBps",
      "maximumCapDenialRateBps",
      "fullRiskBudgetAtomic",
      "cloneRiskBudgetAtomic",
      "maximumUnrecoveredLossAtomic",
    ],
    earlyBirdSybil: [
      "minimumWallets",
      "maximumFlaggedWalletShareBps",
      "maximumFlaggedRewardShareBps",
      "maximumRewardAmplificationBps",
    ],
    c2cLiquidity: [
      "minimumSamplesPerCohort",
      "maximumRelativeFillRateDropBps",
      "maximumMedianTimeIncreaseBps",
      "minimumFillRateRetentionBps",
    ],
    launchGuardRetirement: [
      "minimumObservationDays",
      "minimumMarkets",
      "maximumAccountingMismatches",
      "maximumBypassIncidents",
      "maximumUnrecoveredIncidents",
      "maximumCapDenialRateBps",
      "maximumP95ExposureUtilizationBps",
    ],
    extremeGasExit: [
      "minimumGasPriceSamples",
      "minimumReceiptsPerOperation",
      "gasPricePercentileBps",
      "receiptPercentileBps",
      "gasPriceStressMultiplierBps",
      "l1FeeStressMultiplierBps",
      "maximumUserExitCostAtomic",
      "minimumExitValueAtomic",
      "maximumCostToExitValueBps",
    ],
  };
  requireAllowedKeys("policy", policy, [
    "$schema",
    "schemaVersion",
    "policyId",
    "maximumAssessmentValiditySeconds",
    ...Object.keys(definitions),
  ]);
  for (const [name, numericKeys] of Object.entries(definitions)) {
    const section = policy[name];
    requireObject(`policy.${name}`, section);
    requireAllowedKeys(`policy.${name}`, section, [
      "approved",
      "approvalRef",
      ...numericKeys,
      ...(name === "microPoolRake" ? ["fundingScope"] : []),
      ...(name === "extremeGasExit" ? ["requiredOperations"] : []),
    ]);
    if (typeof section.approved !== "boolean")
      throw new TypeError(`policy.${name}.approved must be boolean`);
    if (typeof section.approvalRef !== "string")
      throw new TypeError(`policy.${name}.approvalRef must be string`);
    for (const key of numericKeys)
      requireUintString(`policy.${name}.${key}`, section[key]);
  }
  if (!RAKE_FUNDING_SCOPES.has(policy.microPoolRake.fundingScope)) {
    throw new RangeError("policy.microPoolRake.fundingScope is unsupported");
  }
  requireArray(
    "policy.extremeGasExit.requiredOperations",
    policy.extremeGasExit.requiredOperations,
  );
  if (policy.extremeGasExit.requiredOperations.length === 0)
    throw new RangeError(
      "policy.extremeGasExit.requiredOperations must be non-empty",
    );
  for (const operation of policy.extremeGasExit.requiredOperations) {
    if (!EXIT_OPERATIONS.includes(operation))
      throw new RangeError(`unsupported exit operation: ${operation}`);
  }
  if (
    new Set(policy.extremeGasExit.requiredOperations).size !==
    policy.extremeGasExit.requiredOperations.length
  ) {
    throw new RangeError(
      "policy.extremeGasExit.requiredOperations must be unique",
    );
  }
  for (const [name, section] of Object.entries(policy)) {
    if (
      name === "$schema" ||
      name === "schemaVersion" ||
      name === "policyId" ||
      name === "maximumAssessmentValiditySeconds"
    )
      continue;
    if (section.approved && section.approvalRef.trim().length === 0) {
      throw new RangeError(
        `policy.${name}.approvalRef is required when approved`,
      );
    }
  }
  requirePositivePolicy(
    policy.bondDeterrence,
    "minimumSamplesPerMode",
    "bondDeterrence",
  );
  requirePositivePolicy(
    policy.bondDeterrence,
    "minimumCoverageBps",
    "bondDeterrence",
  );
  requirePositivePolicy(
    policy.microPoolRake,
    "minimumReceiptsPerOperation",
    "microPoolRake",
  );
  requirePositivePolicy(
    policy.microPoolRake,
    "minimumRakeCoverageBps",
    "microPoolRake",
  );
  requirePolicyRange(
    policy.microPoolRake,
    "committedFundingShareBps",
    "microPoolRake",
    1n,
    BPS,
  );
  requirePositivePolicy(
    policy.marketCaps,
    "minimumSamplesPerMode",
    "marketCaps",
  );
  requirePolicyBps(policy.marketCaps, "minimumP95UtilizationBps", "marketCaps");
  requirePolicyBps(policy.marketCaps, "maximumCapDenialRateBps", "marketCaps");
  requirePositivePolicy(
    policy.marketCaps,
    "fullRiskBudgetAtomic",
    "marketCaps",
  );
  requirePositivePolicy(
    policy.marketCaps,
    "cloneRiskBudgetAtomic",
    "marketCaps",
  );
  requirePositivePolicy(
    policy.earlyBirdSybil,
    "minimumWallets",
    "earlyBirdSybil",
  );
  requirePolicyBps(
    policy.earlyBirdSybil,
    "maximumFlaggedWalletShareBps",
    "earlyBirdSybil",
  );
  requirePolicyBps(
    policy.earlyBirdSybil,
    "maximumFlaggedRewardShareBps",
    "earlyBirdSybil",
  );
  requirePositivePolicy(
    policy.earlyBirdSybil,
    "maximumRewardAmplificationBps",
    "earlyBirdSybil",
  );
  requirePositivePolicy(
    policy.c2cLiquidity,
    "minimumSamplesPerCohort",
    "c2cLiquidity",
  );
  requirePolicyBps(
    policy.c2cLiquidity,
    "maximumRelativeFillRateDropBps",
    "c2cLiquidity",
  );
  requirePositivePolicy(
    policy.c2cLiquidity,
    "maximumMedianTimeIncreaseBps",
    "c2cLiquidity",
  );
  requirePolicyBps(
    policy.c2cLiquidity,
    "minimumFillRateRetentionBps",
    "c2cLiquidity",
  );
  requirePositivePolicy(
    policy.launchGuardRetirement,
    "minimumObservationDays",
    "launchGuardRetirement",
  );
  requirePositivePolicy(
    policy.launchGuardRetirement,
    "minimumMarkets",
    "launchGuardRetirement",
  );
  requirePolicyBps(
    policy.launchGuardRetirement,
    "maximumCapDenialRateBps",
    "launchGuardRetirement",
  );
  requirePolicyBps(
    policy.launchGuardRetirement,
    "maximumP95ExposureUtilizationBps",
    "launchGuardRetirement",
  );
  requirePositivePolicy(
    policy.extremeGasExit,
    "minimumGasPriceSamples",
    "extremeGasExit",
  );
  requirePositivePolicy(
    policy.extremeGasExit,
    "minimumReceiptsPerOperation",
    "extremeGasExit",
  );
  requirePolicyRange(
    policy.extremeGasExit,
    "gasPricePercentileBps",
    "extremeGasExit",
    1n,
    BPS,
  );
  requirePolicyRange(
    policy.extremeGasExit,
    "receiptPercentileBps",
    "extremeGasExit",
    1n,
    BPS,
  );
  requirePolicyRange(
    policy.extremeGasExit,
    "gasPriceStressMultiplierBps",
    "extremeGasExit",
    BPS,
    1_000_000n,
  );
  requirePolicyRange(
    policy.extremeGasExit,
    "l1FeeStressMultiplierBps",
    "extremeGasExit",
    BPS,
    1_000_000n,
  );
  requirePositivePolicy(
    policy.extremeGasExit,
    "maximumUserExitCostAtomic",
    "extremeGasExit",
  );
  requirePositivePolicy(
    policy.extremeGasExit,
    "minimumExitValueAtomic",
    "extremeGasExit",
  );
  requirePolicyBps(
    policy.extremeGasExit,
    "maximumCostToExitValueBps",
    "extremeGasExit",
  );
  return policy;
}

export function evaluateCommercialEconomics(input, policy) {
  validateCommercialEconomicsInput(input);
  validateCommercialEconomicsPolicy(policy);
  const validitySeconds = BigInt(
    Math.ceil(
      (Date.parse(input.validUntil) - Date.parse(input.assessmentTime)) / 1_000,
    ),
  );
  if (validitySeconds > toBigInt(policy.maximumAssessmentValiditySeconds)) {
    throw new RangeError(
      "commercial assessment validity exceeds approved policy",
    );
  }
  const gates = [
    evaluateBond(input, policy.bondDeterrence),
    evaluateMicroPool(input, policy.microPoolRake),
    evaluateCaps(input, policy.marketCaps),
    evaluateEarlyBird(input, policy.earlyBirdSybil),
    evaluateC2c(input, policy.c2cLiquidity),
    evaluateLaunchGuard(input, policy.launchGuardRetirement),
    evaluateExtremeGas(input, policy.extremeGasExit),
  ];
  const overallStatus = gates.some((item) => item.status === "FAIL")
    ? "FAIL"
    : gates.some((item) => item.status === "NOT_VERIFIED")
      ? "NOT_VERIFIED"
      : "PASS";
  return stringifyBigInts({
    $schema: "../../manifests/economics-commercial-result.schema.json",
    schemaVersion: 1,
    generatedBy: "scripts/economics/run-commercial-economics-gate.mjs",
    assessmentId: input.assessmentId,
    assessmentTime: input.assessmentTime,
    validUntil: input.validUntil,
    policyId: policy.policyId,
    inputSha256: sha256Document(input),
    policySha256: sha256Document(policy),
    overallStatus,
    roundingPolicy: {
      revenue: "floor",
      costsAndRequiredCoverage: "ceil",
      percentiles: "nearest-rank with rank=ceil(n*p), sorted ascending",
      ratios: "adverse ratios use ceil; available coverage uses floor",
      arithmetic:
        "BigInt integer fixed-point only; USDC has 6 decimals and ETH/USD has 1e8 scale",
    },
    gates,
    proofBoundary: [
      "PASS requires approved policy and provenance-complete supplied Base/business evidence; estimates never satisfy evidence readiness.",
      "Receipt provenance is validated structurally offline but transaction inclusion is not queried by this tool.",
      "Extreme-gas PASS proves only economic feasibility under the approved stress vector, not sequencer, RPC, bundler, or USDC availability.",
      "LaunchGuard PASS means evidence-backed retirement eligibility only; this tool never sends the irreversible governance transaction.",
    ],
  });
}

function evaluateBond(input, policy) {
  const requirements = boundRequirements(input, policy, input.bondEvidence);
  const minimumSamples = toBigInt(policy.minimumSamplesPerMode);
  const coverage = toBigInt(policy.minimumCoverageBps);
  const cohorts = MODES.map((mode) =>
    input.bondEvidence.cohorts.find((item) => item.mode === mode),
  );
  for (const mode of MODES) {
    const cohort = cohorts.find((item) => item?.mode === mode);
    requireGate(requirements, Boolean(cohort), `missing ${mode} bond cohort`);
    if (cohort)
      requireGate(
        requirements,
        toBigInt(cohort.sampleCount) >= minimumSamples,
        `${mode} bond sample count below approved minimum`,
      );
  }
  const metrics = cohorts.filter(Boolean).map((cohort) => {
    const cap = modeCap(input, cohort.mode);
    const bond = requiredCreatorBondAtomic(cap);
    const adverse =
      toBigInt(cohort.observedAttackProfitP95Atomic) +
      toBigInt(cohort.incidentResponseCostP95Atomic);
    const target = mulDivCeil(adverse, coverage, BPS);
    return {
      mode: cohort.mode,
      capAtomic: cap,
      requiredBondAtomic: bond,
      deterrenceTargetAtomic: target,
      sufficient: bond >= target,
    };
  });
  return finalizeGate(
    "bond_deterrence",
    "V1 creator bond deterrence",
    requirements,
    metrics,
    metrics.length === 2 && metrics.every((item) => item.sufficient),
  );
}

function evaluateMicroPool(input, policy) {
  const requirements = boundRequirements(
    input,
    policy,
    input.microPoolEvidence,
    input.baseReceipts,
    input.ethUsdEvidence,
  );
  requireGate(
    requirements,
    priceEvidenceCurrent(input),
    "ETH/USD evidence is zero, expired, or outside the assessment time",
  );
  requireGate(
    requirements,
    receiptsMatchDeployment(input),
    "one or more Base receipts do not match an attested deployment address and runtime codehash",
  );
  const minimum = Number(toBigInt(policy.minimumReceiptsPerOperation));
  const claims = receiptCostsPerCoveredClaim(
    input,
    "WINNER_CLAIM",
    input.microPoolEvidence.mode,
  );
  const paymaster = receiptCostsPerCoveredClaim(input, "PAYMASTER_OVERHEAD");
  requireGate(
    requirements,
    claims.length >= minimum,
    "insufficient verified WINNER_CLAIM Base receipts",
  );
  requireGate(
    requirements,
    paymaster.length >= minimum,
    "insufficient verified PAYMASTER_OVERHEAD Base receipts",
  );
  const claimantCount = toBigInt(input.microPoolEvidence.expectedClaimantCount);
  requireGate(
    requirements,
    claimantCount > 0n,
    "expected claimant count is zero",
  );
  const sponsored = mulDivCeil(
    claimantCount,
    toBigInt(input.microPoolEvidence.paymasterSponsoredShareBps),
    BPS,
  );
  requireGate(requirements, sponsored > 0n, "sponsored claimant count is zero");
  const claimP95 = claims.length ? nearestRank(claims, 9_500n) : 0n;
  const paymasterP95 = paymaster.length ? nearestRank(paymaster, 9_500n) : 0n;
  const required = sponsored * (claimP95 + paymasterP95);
  const rake = mulDivFloor(
    toBigInt(input.microPoolEvidence.principalAtomic),
    toBigInt(input.subject.v1.creatorRakeBps),
    BPS,
  );
  const protocolFee = mulDivFloor(
    rake,
    toBigInt(input.subject.v1.protocolShareBps),
    BPS,
  );
  const creatorNet = rake - protocolFee;
  const earlyBirdPool = input.microPoolEvidence.earlyBirdEnabled
    ? mulDivFloor(creatorNet, toBigInt(input.subject.v1.earlyBirdShareBps), BPS)
    : 0n;
  const fundingBase =
    policy.fundingScope === "PROTOCOL_FEE"
      ? protocolFee
      : policy.fundingScope === "CREATOR_NET_AFTER_EARLY_BIRD"
        ? creatorNet - earlyBirdPool
        : rake;
  const committedFunding = mulDivFloor(
    fundingBase,
    toBigInt(policy.committedFundingShareBps),
    BPS,
  );
  const coverageBps =
    required === 0n ? 0n : mulDivFloor(committedFunding, BPS, required);
  const metrics = {
    sponsoredClaimants: sponsored,
    claimCostP95AtomicCeil: claimP95,
    paymasterCostP95AtomicCeil: paymasterP95,
    requiredCostAtomicCeil: required,
    grossRakeAtomicFloor: rake,
    protocolFeeAtomicFloor: protocolFee,
    earlyBirdPoolAtomicFloor: earlyBirdPool,
    fundingScope: policy.fundingScope,
    fundingBaseAtomicFloor: fundingBase,
    committedFundingAtomicFloor: committedFunding,
    rakeCoverageBps: coverageBps,
  };
  return finalizeGate(
    "micro_pool_rake",
    "Micro-pool rake covers claim and Paymaster",
    requirements,
    metrics,
    required > 0n && coverageBps >= toBigInt(policy.minimumRakeCoverageBps),
  );
}

function evaluateCaps(input, policy) {
  const requirements = boundRequirements(
    input,
    policy,
    input.marketCapEvidence,
  );
  const minimum = toBigInt(policy.minimumSamplesPerMode);
  const cohorts = MODES.map((mode) =>
    input.marketCapEvidence.cohorts.find((item) => item.mode === mode),
  );
  for (const mode of MODES) {
    const cohort = cohorts.find((item) => item?.mode === mode);
    requireGate(requirements, Boolean(cohort), `missing ${mode} cap cohort`);
    if (cohort) {
      requireGate(
        requirements,
        toBigInt(cohort.sampleCount) >= minimum,
        `${mode} cap sample count below approved minimum`,
      );
      requireGate(
        requirements,
        toBigInt(cohort.eligibleOrders) > 0n,
        `${mode} eligible order count is zero`,
      );
    }
  }
  const metrics = cohorts.filter(Boolean).map((cohort) => {
    const cap = modeCap(input, cohort.mode);
    const utilization = mulDivFloor(
      toBigInt(cohort.p95PeakPrincipalAtomic),
      BPS,
      cap,
    );
    const eligible = toBigInt(cohort.eligibleOrders);
    const denial =
      eligible === 0n
        ? BPS + 1n
        : mulDivCeil(toBigInt(cohort.capDeniedOrders), BPS, eligible);
    const riskBudget = toBigInt(
      cohort.mode === "FULL"
        ? policy.fullRiskBudgetAtomic
        : policy.cloneRiskBudgetAtomic,
    );
    const sufficient =
      cap <= riskBudget &&
      utilization >= toBigInt(policy.minimumP95UtilizationBps) &&
      utilization <= BPS &&
      denial <= toBigInt(policy.maximumCapDenialRateBps) &&
      toBigInt(cohort.unrecoveredLossAtomic) <=
        toBigInt(policy.maximumUnrecoveredLossAtomic);
    return {
      mode: cohort.mode,
      capAtomic: cap,
      riskBudgetAtomic: riskBudget,
      p95UtilizationBps: utilization,
      capDenialRateBps: denial,
      unrecoveredLossAtomic: toBigInt(cohort.unrecoveredLossAtomic),
      sufficient,
    };
  });
  return finalizeGate(
    "full_clone_caps",
    "Full 5,000 / Clone 500 cap suitability",
    requirements,
    metrics,
    metrics.length === 2 && metrics.every((item) => item.sufficient),
  );
}

function evaluateEarlyBird(input, policy) {
  const data = input.earlyBirdEvidence;
  const requirements = boundRequirements(input, policy, data);
  const wallets = toBigInt(data.walletCount);
  const principal = toBigInt(data.totalEarlyPrincipalAtomic);
  const reward = toBigInt(data.totalEarlyRewardAtomic);
  requireGate(
    requirements,
    wallets >= toBigInt(policy.minimumWallets),
    "wallet sample below approved minimum",
  );
  requireGate(requirements, principal > 0n, "total early principal is zero");
  requireGate(requirements, reward > 0n, "total early reward is zero");
  requireGate(
    requirements,
    toBigInt(data.flaggedWalletCount) <= wallets,
    "flagged wallet count exceeds total",
  );
  requireGate(
    requirements,
    toBigInt(data.flaggedEarlyPrincipalAtomic) <= principal,
    "flagged principal exceeds total",
  );
  requireGate(
    requirements,
    toBigInt(data.flaggedEarlyRewardAtomic) <= reward,
    "flagged reward exceeds total",
  );
  const walletShare =
    wallets === 0n
      ? BPS + 1n
      : mulDivCeil(toBigInt(data.flaggedWalletCount), BPS, wallets);
  const principalShare =
    principal === 0n
      ? 0n
      : mulDivCeil(toBigInt(data.flaggedEarlyPrincipalAtomic), BPS, principal);
  const rewardShare =
    reward === 0n
      ? BPS + 1n
      : mulDivCeil(toBigInt(data.flaggedEarlyRewardAtomic), BPS, reward);
  const amplification =
    principalShare === 0n
      ? rewardShare === 0n
        ? 0n
        : BPS + 1n
      : mulDivCeil(rewardShare, BPS, principalShare);
  const metrics = {
    flaggedWalletShareBps: walletShare,
    flaggedPrincipalShareBps: principalShare,
    flaggedRewardShareBps: rewardShare,
    rewardAmplificationBps: amplification,
  };
  const pass =
    walletShare <= toBigInt(policy.maximumFlaggedWalletShareBps) &&
    rewardShare <= toBigInt(policy.maximumFlaggedRewardShareBps) &&
    amplification <= toBigInt(policy.maximumRewardAmplificationBps);
  return finalizeGate(
    "early_bird_sybil",
    "Early-bird Sybil concentration",
    requirements,
    metrics,
    pass,
  );
}

function evaluateC2c(input, policy) {
  const data = input.c2cEvidence;
  const requirements = boundRequirements(input, policy, data);
  requireGate(
    requirements,
    data.matchedCohorts,
    "baseline and candidate cohorts are not matched",
  );
  const baseline = data.baseline;
  const candidate = data.candidate;
  const minimum = toBigInt(policy.minimumSamplesPerCohort);
  requireGate(
    requirements,
    toBigInt(baseline.sampleCount) >= minimum,
    "baseline sample below approved minimum",
  );
  requireGate(
    requirements,
    toBigInt(candidate.sampleCount) >= minimum,
    "candidate sample below approved minimum",
  );
  requireGate(
    requirements,
    toBigInt(baseline.feeBps) === 0n,
    "baseline fee is not zero",
  );
  const configuredFee =
    toBigInt(input.subject.v1.platformC2CFeeBps) +
    toBigInt(input.subject.v1.creatorC2CFeeBps);
  requireGate(
    requirements,
    toBigInt(candidate.feeBps) === configuredFee,
    "candidate fee does not match configured C2C fee",
  );
  requireGate(
    requirements,
    toBigInt(baseline.quotedUnits) > 0n && toBigInt(candidate.quotedUnits) > 0n,
    "quoted units are zero",
  );
  requireGate(
    requirements,
    toBigInt(baseline.medianTimeToFillSeconds) > 0n,
    "baseline median fill time is zero",
  );
  const baselineFill =
    toBigInt(baseline.quotedUnits) === 0n
      ? 0n
      : mulDivFloor(
          toBigInt(baseline.filledUnits),
          BPS,
          toBigInt(baseline.quotedUnits),
        );
  const candidateFill =
    toBigInt(candidate.quotedUnits) === 0n
      ? 0n
      : mulDivFloor(
          toBigInt(candidate.filledUnits),
          BPS,
          toBigInt(candidate.quotedUnits),
        );
  requireGate(requirements, baselineFill > 0n, "baseline fill rate is zero");
  const fillDrop =
    candidateFill >= baselineFill || baselineFill === 0n
      ? 0n
      : mulDivCeil(baselineFill - candidateFill, BPS, baselineFill);
  const retention =
    baselineFill === 0n ? 0n : mulDivFloor(candidateFill, BPS, baselineFill);
  const baselineTime = toBigInt(baseline.medianTimeToFillSeconds);
  const candidateTime = toBigInt(candidate.medianTimeToFillSeconds);
  const timeIncrease =
    candidateTime <= baselineTime || baselineTime === 0n
      ? 0n
      : mulDivCeil(candidateTime - baselineTime, BPS, baselineTime);
  const metrics = {
    configuredFeeBps: configuredFee,
    baselineFillRateBps: baselineFill,
    candidateFillRateBps: candidateFill,
    relativeFillRateDropBps: fillDrop,
    fillRateRetentionBps: retention,
    medianTimeIncreaseBps: timeIncrease,
  };
  const pass =
    fillDrop <= toBigInt(policy.maximumRelativeFillRateDropBps) &&
    retention >= toBigInt(policy.minimumFillRateRetentionBps) &&
    timeIncrease <= toBigInt(policy.maximumMedianTimeIncreaseBps);
  return finalizeGate(
    "c2c_fee_liquidity",
    "C2C fee and liquidity sensitivity",
    requirements,
    metrics,
    pass,
  );
}

function evaluateLaunchGuard(input, policy) {
  const data = input.launchGuardEvidence;
  const requirements = boundRequirements(input, policy, data);
  const eligible = toBigInt(data.eligibleOrders);
  requireGate(
    requirements,
    toBigInt(data.observationDays) >= toBigInt(policy.minimumObservationDays),
    "observation window below approved minimum",
  );
  requireGate(
    requirements,
    toBigInt(data.marketCount) >= toBigInt(policy.minimumMarkets),
    "market sample below approved minimum",
  );
  requireGate(requirements, eligible > 0n, "eligible order count is zero");
  const denial =
    eligible === 0n
      ? BPS + 1n
      : mulDivCeil(toBigInt(data.capDeniedOrders), BPS, eligible);
  const metrics = {
    observationDays: toBigInt(data.observationDays),
    marketCount: toBigInt(data.marketCount),
    accountingMismatchCount: toBigInt(data.accountingMismatchCount),
    guardBypassIncidentCount: toBigInt(data.guardBypassIncidentCount),
    unrecoveredIncidentCount: toBigInt(data.unrecoveredIncidentCount),
    capDenialRateBps: denial,
    p95ExposureUtilizationBps: toBigInt(data.p95ExposureUtilizationBps),
  };
  const pass =
    metrics.accountingMismatchCount <=
      toBigInt(policy.maximumAccountingMismatches) &&
    metrics.guardBypassIncidentCount <=
      toBigInt(policy.maximumBypassIncidents) &&
    metrics.unrecoveredIncidentCount <=
      toBigInt(policy.maximumUnrecoveredIncidents) &&
    metrics.capDenialRateBps <= toBigInt(policy.maximumCapDenialRateBps) &&
    metrics.p95ExposureUtilizationBps <=
      toBigInt(policy.maximumP95ExposureUtilizationBps);
  return finalizeGate(
    "launch_guard_retirement",
    "LaunchGuard retirement eligibility",
    requirements,
    metrics,
    pass,
  );
}

function evaluateExtremeGas(input, policy) {
  const requirements = boundRequirements(
    input,
    policy,
    input.baseReceipts,
    input.gasPriceEvidence,
    input.ethUsdEvidence,
  );
  requireGate(
    requirements,
    priceEvidenceCurrent(input),
    "ETH/USD evidence is zero, expired, or outside the assessment time",
  );
  requireGate(
    requirements,
    receiptsMatchDeployment(input),
    "one or more Base receipts do not match an attested deployment address and runtime codehash",
  );
  const prices = input.gasPriceEvidence.samplesWei.map(toBigInt);
  requireGate(
    requirements,
    prices.length >= Number(toBigInt(policy.minimumGasPriceSamples)),
    "insufficient verified gas-price samples",
  );
  const priceP = prices.length
    ? nearestRank(prices, toBigInt(policy.gasPricePercentileBps))
    : 0n;
  const stressedPrice = mulDivCeil(
    priceP,
    toBigInt(policy.gasPriceStressMultiplierBps),
    BPS,
  );
  const minimumReceipts = Number(toBigInt(policy.minimumReceiptsPerOperation));
  const operations = [];
  for (const operation of policy.requiredOperations) {
    const receipts = input.baseReceipts.receipts.filter(
      (item) => item.operation === operation,
    );
    requireGate(
      requirements,
      receipts.length >= minimumReceipts,
      `insufficient verified ${operation} Base receipts`,
    );
    if (VAULT_RECEIPT_OPERATIONS.has(operation)) {
      for (const mode of MODES) {
        requireGate(
          requirements,
          receipts.filter((receipt) => receipt.deploymentMode === mode)
            .length >= minimumReceipts,
          `insufficient verified ${operation} ${mode} Base receipts`,
        );
      }
    }
    const gasP = receipts.length
      ? nearestRank(
          receipts.map((item) => toBigInt(item.gasUsed)),
          toBigInt(policy.receiptPercentileBps),
        )
      : 0n;
    const l1P = receipts.length
      ? nearestRank(
          receipts.map((item) => toBigInt(item.l1FeeWei)),
          toBigInt(policy.receiptPercentileBps),
        )
      : 0n;
    const stressedL1 = mulDivCeil(
      l1P,
      toBigInt(policy.l1FeeStressMultiplierBps),
      BPS,
    );
    const ethUsd = toBigInt(input.ethUsdEvidence.ethUsdE8);
    const cost =
      ethUsd === 0n
        ? 0n
        : weiToUsdcAtomicCeil(gasP * stressedPrice + stressedL1, ethUsd);
    const minimumExit = toBigInt(policy.minimumExitValueAtomic);
    const ratio =
      minimumExit === 0n ? BPS + 1n : mulDivCeil(cost, BPS, minimumExit);
    const evidenceReady =
      receipts.length >= minimumReceipts &&
      priceEvidenceCurrent(input) &&
      receiptsMatchDeployment(input);
    operations.push({
      operation,
      receiptGasPercentile: gasP,
      l1FeeWeiPercentile: l1P,
      stressedCostAtomicCeil: cost,
      costToMinimumExitValueBps: ratio,
      sufficient:
        evidenceReady &&
        cost <= toBigInt(policy.maximumUserExitCostAtomic) &&
        ratio <= toBigInt(policy.maximumCostToExitValueBps),
    });
  }
  requireGate(
    requirements,
    toBigInt(policy.minimumExitValueAtomic) > 0n,
    "minimum exit value is zero",
  );
  const metrics = {
    gasPricePercentileWei: priceP,
    stressedGasPriceWeiCeil: stressedPrice,
    operations,
  };
  return finalizeGate(
    "extreme_gas_exit",
    "Extreme-gas exit economic feasibility",
    requirements,
    metrics,
    operations.length > 0 && operations.every((item) => item.sufficient),
  );
}

function commonRequirements(policy, ...evidenceSections) {
  const reasons = [];
  requireGate(reasons, policy.approved, "policy threshold is not approved");
  requireGate(
    reasons,
    policy.approvalRef.trim().length > 0,
    "policy approval reference is missing",
  );
  for (const section of evidenceSections) {
    requireGate(
      reasons,
      section.evidenceStatus === "PROVIDED",
      "required evidence is marked MISSING",
    );
    requireGate(
      reasons,
      validProvenance(section.provenance),
      "evidence provenance or independent verification is incomplete",
    );
  }
  return reasons;
}

function boundRequirements(input, policy, ...evidenceSections) {
  const reasons = commonRequirements(
    policy,
    input.deploymentBinding,
    input.configurationEvidence,
    ...evidenceSections,
  );
  const assessment = Date.parse(input.assessmentTime);
  for (const section of [
    input.deploymentBinding,
    input.configurationEvidence,
    ...evidenceSections,
  ]) {
    const collectionEnd = Date.parse(section.provenance.collectionEnd);
    requireGate(
      reasons,
      !Number.isFinite(collectionEnd) || collectionEnd <= assessment,
      "evidence collection ends after the assessment time",
    );
  }
  requireGate(
    reasons,
    deploymentBindingComplete(input),
    "source manifest, audit commit, or required deployment address/codehash binding is incomplete",
  );
  requireGate(
    reasons,
    configurationMatchesSubject(input),
    "RPC-verified Full/Clone market configuration does not match the assessed V1 parameters",
  );
  return reasons;
}

function finalizeGate(id, title, requirements, metrics, thresholdSatisfied) {
  if (requirements.length > 0)
    return {
      id,
      title,
      status: "NOT_VERIFIED",
      reasons: [...new Set(requirements)],
      metrics,
    };
  return {
    id,
    title,
    status: thresholdSatisfied ? "PASS" : "FAIL",
    reasons: thresholdSatisfied
      ? []
      : ["complete evidence does not meet the approved threshold"],
    metrics,
  };
}

function requireGate(reasons, condition, reason) {
  if (!condition) reasons.push(reason);
}

function receiptCostsPerCoveredClaim(input, operation, deploymentMode) {
  const ethUsd = toBigInt(input.ethUsdEvidence.ethUsdE8);
  if (ethUsd === 0n) return [];
  return input.baseReceipts.receipts
    .filter(
      (item) =>
        item.operation === operation &&
        (deploymentMode === undefined ||
          item.deploymentMode === deploymentMode),
    )
    .map((item) => {
      const feeWei =
        toBigInt(item.gasUsed) * toBigInt(item.effectiveGasPriceWei) +
        toBigInt(item.l1FeeWei);
      return ceilDiv(
        weiToUsdcAtomicCeil(feeWei, ethUsd) +
          toBigInt(item.externalChargeAtomic),
        toBigInt(item.coveredClaims),
      );
    });
}

function modeCap(input, mode) {
  return toBigInt(
    mode === "FULL"
      ? input.subject.v1.fullMarketCapAtomic
      : input.subject.v1.cloneMarketCapAtomic,
  );
}

function validProvenance(value) {
  if (!value) return false;
  const start = Date.parse(value.collectionStart);
  const end = Date.parse(value.collectionEnd);
  return (
    SHA256_PATTERN.test(value.datasetSha256) &&
    ISO_UTC_PATTERN.test(value.collectionStart) &&
    ISO_UTC_PATTERN.test(value.collectionEnd) &&
    typeof value.verifier === "string" &&
    value.verifier.trim().length > 0 &&
    typeof value.verificationRef === "string" &&
    value.verificationRef.trim().length > 0 &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start <= end
  );
}

function deploymentBindingComplete(input) {
  const binding = input.deploymentBinding;
  if (
    binding.evidenceStatus !== "PROVIDED" ||
    !SHA256_PATTERN.test(binding.sourceManifestSha256) ||
    !COMMIT_PATTERN.test(binding.auditCommit)
  )
    return false;
  const components = new Set(binding.deployments.map((item) => item.component));
  return (
    binding.deployments.length === REQUIRED_DEPLOYMENT_COMPONENTS.length &&
    components.size === REQUIRED_DEPLOYMENT_COMPONENTS.length &&
    REQUIRED_DEPLOYMENT_COMPONENTS.every((component) =>
      components.has(component),
    )
  );
}

function receiptsMatchDeployment(input) {
  const bindings = new Map(
    input.deploymentBinding.deployments.map((item) => [
      `${item.address.toLowerCase()}:${item.runtimeCodeHash.toLowerCase()}`,
      item.component,
    ]),
  );
  return input.baseReceipts.receipts.every((receipt) => {
    const component = bindings.get(
      `${receipt.contractAddress.toLowerCase()}:${receipt.runtimeCodeHash.toLowerCase()}`,
    );
    if (component === undefined) return false;
    if (VAULT_RECEIPT_OPERATIONS.has(receipt.operation)) {
      return (
        component ===
        `${receipt.deploymentMode === "FULL" ? "Full" : "Clone"}MarketVaultV1`
      );
    }
    return (
      receipt.deploymentMode === "NA" &&
      component === OPERATION_COMPONENTS[receipt.operation]
    );
  });
}

function configurationMatchesSubject(input) {
  const evidence = input.configurationEvidence;
  if (evidence.evidenceStatus !== "PROVIDED" || evidence.rpcVerified !== true)
    return false;
  if (evidence.marketSnapshots.length !== MODES.length) return false;
  const bindings = new Map(
    input.deploymentBinding.deployments.map((deployment) => [
      deployment.component,
      deployment,
    ]),
  );
  return MODES.every((mode) => {
    const snapshot = evidence.marketSnapshots.find(
      (item) => item.mode === mode,
    );
    const component = `${mode === "FULL" ? "Full" : "Clone"}MarketVaultV1`;
    const binding = bindings.get(component);
    if (snapshot === undefined || binding === undefined) return false;
    const expectedCap =
      mode === "FULL"
        ? input.subject.v1.fullMarketCapAtomic
        : input.subject.v1.cloneMarketCapAtomic;
    return (
      snapshot.vaultAddress.toLowerCase() === binding.address.toLowerCase() &&
      snapshot.runtimeCodeHash.toLowerCase() ===
        binding.runtimeCodeHash.toLowerCase() &&
      snapshot.marketPrimaryCapAtomic === expectedCap &&
      snapshot.creatorRakeBps === input.subject.v1.creatorRakeBps &&
      snapshot.protocolShareBps === input.subject.v1.protocolShareBps &&
      snapshot.earlyBirdShareBps === input.subject.v1.earlyBirdShareBps &&
      snapshot.platformC2CFeeBps === input.subject.v1.platformC2CFeeBps &&
      snapshot.creatorC2CFeeBps === input.subject.v1.creatorC2CFeeBps
    );
  });
}

function priceEvidenceCurrent(input) {
  const evidence = input.ethUsdEvidence;
  if (
    evidence.evidenceStatus !== "PROVIDED" ||
    toBigInt(evidence.ethUsdE8) === 0n
  )
    return false;
  const assessment = Date.parse(input.assessmentTime);
  const observed = Date.parse(evidence.observedAt);
  const validUntil = Date.parse(evidence.validUntil);
  return (
    Number.isFinite(assessment) &&
    Number.isFinite(observed) &&
    Number.isFinite(validUntil) &&
    observed <= assessment &&
    assessment <= validUntil
  );
}

function validateReceipt(receipt, index, expectedChainId) {
  const prefix = `input.baseReceipts.receipts[${index}]`;
  requireObject(prefix, receipt);
  requireAllowedKeys(prefix, receipt, [
    "transactionHash",
    "contractAddress",
    "runtimeCodeHash",
    "chainId",
    "blockNumber",
    "operation",
    "deploymentMode",
    "gasUsed",
    "effectiveGasPriceWei",
    "l1FeeWei",
    "externalChargeAtomic",
    "coveredClaims",
    "success",
    "synthetic",
    "rpcVerified",
  ]);
  if (!TX_HASH_PATTERN.test(receipt.transactionHash))
    throw new TypeError(`${prefix}.transactionHash must be 32-byte hex`);
  if (!ADDRESS_PATTERN.test(receipt.contractAddress))
    throw new TypeError(`${prefix}.contractAddress must be 20-byte hex`);
  if (!CODE_HASH_PATTERN.test(receipt.runtimeCodeHash))
    throw new TypeError(`${prefix}.runtimeCodeHash must be 32-byte hex`);
  requireExact(receipt.chainId, expectedChainId, `${prefix}.chainId`);
  if (!RECEIPT_OPERATIONS.has(receipt.operation))
    throw new RangeError(`${prefix}.operation is unsupported`);
  const expectedModes = VAULT_RECEIPT_OPERATIONS.has(receipt.operation)
    ? MODES
    : ["NA"];
  if (!expectedModes.includes(receipt.deploymentMode))
    throw new RangeError(
      `${prefix}.deploymentMode is invalid for ${receipt.operation}`,
    );
  for (const key of [
    "blockNumber",
    "gasUsed",
    "effectiveGasPriceWei",
    "l1FeeWei",
    "externalChargeAtomic",
    "coveredClaims",
  ])
    requireUintString(`${prefix}.${key}`, receipt[key]);
  if (
    toBigInt(receipt.blockNumber) === 0n ||
    toBigInt(receipt.gasUsed) === 0n ||
    toBigInt(receipt.effectiveGasPriceWei) === 0n ||
    toBigInt(receipt.coveredClaims) === 0n
  ) {
    throw new RangeError(`${prefix} contains a zero required receipt value`);
  }
  if (
    receipt.success !== true ||
    receipt.synthetic !== false ||
    receipt.rpcVerified !== true
  ) {
    throw new RangeError(
      `${prefix} must be successful, non-synthetic, and RPC-verified`,
    );
  }
}

function validateC2cCohort(name, cohort) {
  requireObject(name, cohort);
  requireAllowedKeys(name, cohort, [
    "feeBps",
    "sampleCount",
    "quotedUnits",
    "filledUnits",
    "medianTimeToFillSeconds",
  ]);
  for (const key of [
    "feeBps",
    "sampleCount",
    "quotedUnits",
    "filledUnits",
    "medianTimeToFillSeconds",
  ])
    requireUintString(`${name}.${key}`, cohort[key]);
  if (toBigInt(cohort.filledUnits) > toBigInt(cohort.quotedUnits))
    throw new RangeError(`${name}.filledUnits exceeds quotedUnits`);
}

function requireEvidenceSection(name, section, fields) {
  requireObject(name, section);
  requireAllowedKeys(name, section, [
    "evidenceStatus",
    "provenance",
    ...fields,
  ]);
  if (
    section.evidenceStatus !== "MISSING" &&
    section.evidenceStatus !== "PROVIDED"
  )
    throw new RangeError(`${name}.evidenceStatus must be MISSING or PROVIDED`);
  requireObject(`${name}.provenance`, section.provenance);
  requireAllowedKeys(`${name}.provenance`, section.provenance, [
    "datasetSha256",
    "collectionStart",
    "collectionEnd",
    "verifier",
    "verificationRef",
  ]);
  for (const key of [
    "datasetSha256",
    "collectionStart",
    "collectionEnd",
    "verifier",
    "verificationRef",
  ]) {
    if (typeof section.provenance[key] !== "string")
      throw new TypeError(`${name}.provenance.${key} must be string`);
  }
}

function requireFixedUint(key, object, expected) {
  requireUintString(`input.subject.v1.${key}`, object[key]);
  if (toBigInt(object[key]) !== expected)
    throw new RangeError(
      `input.subject.v1.${key} must match immutable V1 assessment value ${expected}`,
    );
}

function requireUintRange(name, value, minimum, maximum) {
  requireUintString(name, value);
  assertBigIntRange(name, toBigInt(value), minimum, maximum);
}

function requirePositivePolicy(section, key, name) {
  if (toBigInt(section[key]) === 0n)
    throw new RangeError(`policy.${name}.${key} must be positive`);
}

function requirePolicyBps(section, key, name) {
  requirePolicyRange(section, key, name, 0n, BPS);
}

function requirePolicyRange(section, key, name, minimum, maximum) {
  const value = toBigInt(section[key]);
  if (value < minimum || value > maximum)
    throw new RangeError(
      `policy.${name}.${key} must be in [${minimum}, ${maximum}]`,
    );
}

function requirePositiveUintString(name, value) {
  requireUintString(name, value);
  if (toBigInt(value) === 0n) throw new RangeError(`${name} must be positive`);
}

function requireUintString(name, value) {
  if (typeof value !== "string" || !UINT_PATTERN.test(value))
    throw new TypeError(`${name} must be a canonical unsigned integer string`);
}

function requireArray(name, value) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
}

function requireUnique(values, name) {
  if (new Set(values).size !== values.length)
    throw new RangeError(`${name} must be unique`);
}

function requireObject(name, value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
}

function requireAllowedKeys(name, value, allowed) {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key))
      throw new TypeError(`${name} contains unsupported field ${key}`);
  }
}

function requireNonEmptyString(name, value) {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new TypeError(`${name} must be a non-empty string`);
}

function requireExact(actual, expected, name) {
  if (actual !== expected)
    throw new RangeError(`${name} must equal ${expected}`);
}

function validateMode(name, value) {
  if (!MODES.includes(value))
    throw new RangeError(`${name} must be FULL or CLONE`);
}

function toBigInt(value) {
  return BigInt(value);
}

function assertNonNegativeBigInt(name, value) {
  if (typeof value !== "bigint" || value < 0n)
    throw new RangeError(`${name} must be a non-negative bigint`);
}

function assertPositiveBigInt(name, value) {
  if (typeof value !== "bigint" || value <= 0n)
    throw new RangeError(`${name} must be a positive bigint`);
}

function assertBigIntRange(name, value, minimum, maximum) {
  if (value < minimum || value > maximum)
    throw new RangeError(`${name} must be in [${minimum}, ${maximum}]`);
}

export function stringifyBigInts(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stringifyBigInts);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, stringifyBigInts(item)]),
    );
  return value;
}
