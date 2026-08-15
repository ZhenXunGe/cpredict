import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  evaluateCommercialEconomics,
  nearestRank,
  requiredCreatorBondAtomic,
  sha256Document,
  validateCommercialEconomicsInput,
  weiToUsdcAtomicCeil,
} from "./commercial-economics.mjs";
import { runCommercialEconomicsGate } from "./run-commercial-economics-gate.mjs";

const inputUrl = new URL(
  "./inputs/commercial-input.template.json",
  import.meta.url,
);
const policyUrl = new URL(
  "./inputs/commercial-policy.template.json",
  import.meta.url,
);

async function templates() {
  const [input, policy] = await Promise.all([
    readFile(inputUrl, "utf8").then(JSON.parse),
    readFile(policyUrl, "utf8").then(JSON.parse),
  ]);
  return { input, policy };
}

test("missing real evidence and unapproved policy fail closed for all seven gates", async () => {
  const { input, policy } = await templates();
  const result = evaluateCommercialEconomics(input, policy);
  assert.equal(result.overallStatus, "NOT_VERIFIED");
  assert.equal(result.gates.length, 7);
  assert.deepEqual(
    new Set(result.gates.map((gate) => gate.status)),
    new Set(["NOT_VERIFIED"]),
  );
  assert.ok(
    result.gates.every((gate) =>
      gate.reasons.some((reason) => reason.includes("policy")),
    ),
  );
});

test("test-only complete fixtures exercise all seven PASS paths without creating a formal report", async () => {
  const { input, policy } = await completeTestFixture();
  const result = evaluateCommercialEconomics(input, policy);
  assert.equal(result.overallStatus, "PASS");
  assert.deepEqual(
    result.gates.map((gate) => gate.status),
    Array(7).fill("PASS"),
  );
  assert.equal(
    result.gates.find((gate) => gate.id === "bond_deterrence").metrics[0]
      .requiredBondAtomic,
    "100000000",
  );
  assert.equal(
    result.gates.find((gate) => gate.id === "c2c_fee_liquidity").metrics
      .fillRateRetentionBps,
    "9500",
  );
  assert.equal(
    result.gates.find((gate) => gate.id === "micro_pool_rake").metrics
      .fundingScope,
    "PROTOCOL_FEE",
  );
});

test("complete but adverse business evidence is FAIL rather than NOT_VERIFIED", async () => {
  const { input, policy } = await completeTestFixture();
  input.bondEvidence.cohorts[1].observedAttackProfitP95Atomic = "20000000";
  const result = evaluateCommercialEconomics(input, policy);
  const bond = result.gates.find((gate) => gate.id === "bond_deterrence");
  assert.equal(bond.status, "FAIL");
  assert.equal(result.overallStatus, "FAIL");
});

test("provided label without provenance remains NOT_VERIFIED", async () => {
  const { input, policy } = await completeTestFixture();
  input.baseReceipts.provenance.verificationRef = "";
  const result = evaluateCommercialEconomics(input, policy);
  assert.equal(
    result.gates.find((gate) => gate.id === "micro_pool_rake").status,
    "NOT_VERIFIED",
  );
  assert.equal(
    result.gates.find((gate) => gate.id === "extreme_gas_exit").status,
    "NOT_VERIFIED",
  );
});

test("future-dated cohorts and uncommitted gross rake cannot close commercial gates", async () => {
  const { input, policy } = await completeTestFixture();
  input.bondEvidence.provenance.collectionEnd = "2026-04-01T00:00:01Z";
  let result = evaluateCommercialEconomics(input, policy);
  assert.equal(
    result.gates.find((gate) => gate.id === "bond_deterrence").status,
    "NOT_VERIFIED",
  );

  input.bondEvidence.provenance.collectionEnd = "2026-03-31T00:00:00Z";
  policy.microPoolRake.committedFundingShareBps = "1";
  result = evaluateCommercialEconomics(input, policy);
  assert.equal(
    result.gates.find((gate) => gate.id === "micro_pool_rake").status,
    "FAIL",
  );
});

test("stale ETH/USD evidence and receipt/codehash mismatch cannot close cost gates", async () => {
  const { input, policy } = await completeTestFixture();
  input.ethUsdEvidence.validUntil = "2026-03-01T00:00:00Z";
  input.baseReceipts.receipts[0].runtimeCodeHash = `0x${"f".repeat(64)}`;
  const result = evaluateCommercialEconomics(input, policy);
  for (const id of ["micro_pool_rake", "extreme_gas_exit"]) {
    const gate = result.gates.find((item) => item.id === id);
    assert.equal(gate.status, "NOT_VERIFIED");
  }
});

test("missing source manifest binding keeps every business gate NOT_VERIFIED", async () => {
  const { input, policy } = await completeTestFixture();
  input.deploymentBinding.sourceManifestSha256 = "";
  const result = evaluateCommercialEconomics(input, policy);
  assert.equal(result.overallStatus, "NOT_VERIFIED");
  assert.ok(result.gates.every((gate) => gate.status === "NOT_VERIFIED"));
});

test("unverified or mismatched onchain market configuration keeps every gate NOT_VERIFIED", async () => {
  const { input, policy } = await completeTestFixture();
  input.configurationEvidence.rpcVerified = false;
  let result = evaluateCommercialEconomics(input, policy);
  assert.ok(result.gates.every((gate) => gate.status === "NOT_VERIFIED"));

  input.configurationEvidence.rpcVerified = true;
  input.configurationEvidence.marketSnapshots[0].creatorRakeBps = "499";
  result = evaluateCommercialEconomics(input, policy);
  assert.ok(result.gates.every((gate) => gate.status === "NOT_VERIFIED"));
});

test("receipt validation rejects estimates and synthetic fixtures at the formal input boundary", async () => {
  const { input } = await completeTestFixture();
  input.baseReceipts.receipts[0].synthetic = true;
  assert.throws(() => validateCommercialEconomicsInput(input), /non-synthetic/);
  input.baseReceipts.receipts[0].synthetic = false;
  input.baseReceipts.receipts[0].gasUsed = "1.5";
  assert.throws(
    () => validateCommercialEconomicsInput(input),
    /canonical unsigned integer string/,
  );
});

test("formal input and policy reject ambiguous unknown fields", async () => {
  const { input, policy } = await completeTestFixture();
  input.microPoolEvidence.estimatedGasUsd = "1.00";
  assert.throws(
    () => evaluateCommercialEconomics(input, policy),
    /unsupported field estimatedGasUsd/,
  );
  delete input.microPoolEvidence.estimatedGasUsd;
  policy.microPoolRake.assumeAllRakeAvailable = true;
  assert.throws(
    () => evaluateCommercialEconomics(input, policy),
    /unsupported field assumeAllRakeAvailable/,
  );
});

test("integer math locks V1 bond, nearest-rank, and conservative USD rounding", () => {
  assert.equal(requiredCreatorBondAtomic(1n), 10_000_000n);
  assert.equal(requiredCreatorBondAtomic(500_000_001n), 10_000_001n);
  assert.equal(requiredCreatorBondAtomic(5_000_000_000n), 100_000_000n);
  assert.equal(nearestRank([1n, 2n, 3n, 4n], 9_500n), 4n);
  assert.equal(weiToUsdcAtomicCeil(1n, 1n), 1n);
});

test("canonical hash is independent of object key insertion order", () => {
  assert.equal(
    sha256Document({ b: "2", a: { d: "4", c: "3" } }),
    sha256Document({ a: { c: "3", d: "4" }, b: "2" }),
  );
});

test("report generator is deterministic and preserves NOT_VERIFIED exit evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpredict-economics-"));
  try {
    const outputJsonPath = join(directory, "gate.json");
    const outputMarkdownPath = join(directory, "gate.md");
    const first = await runCommercialEconomicsGate({
      outputJsonPath,
      outputMarkdownPath,
    });
    const json1 = await readFile(outputJsonPath, "utf8");
    const md1 = await readFile(outputMarkdownPath, "utf8");
    const second = await runCommercialEconomicsGate({
      outputJsonPath,
      outputMarkdownPath,
    });
    assert.equal(first.result.overallStatus, "NOT_VERIFIED");
    assert.equal(second.result.inputSha256, first.result.inputSha256);
    assert.equal(await readFile(outputJsonPath, "utf8"), json1);
    assert.equal(await readFile(outputMarkdownPath, "utf8"), md1);
    assert.match(md1, /估算值不能得到 `PASS`/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("machine-readable schemas parse and expose the required top-level contracts", async () => {
  for (const url of [
    new URL(
      "../../manifests/economics-commercial-input.schema.json",
      import.meta.url,
    ),
    new URL(
      "../../manifests/economics-commercial-policy.schema.json",
      import.meta.url,
    ),
    new URL(
      "../../manifests/economics-commercial-result.schema.json",
      import.meta.url,
    ),
  ]) {
    const schema = JSON.parse(await readFile(url, "utf8"));
    assert.equal(
      schema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.ok(schema.required.length > 0);
  }
});

async function completeTestFixture() {
  const { input, policy } = await templates();
  input.assessmentId = "TEST-ONLY-commercial-economics-model";
  input.assessmentTime = "2026-03-31T00:00:00Z";
  input.validUntil = "2026-04-01T00:00:00Z";
  const provenance = {
    datasetSha256: `sha256:${"a".repeat(64)}`,
    collectionStart: "2026-01-01T00:00:00Z",
    collectionEnd: "2026-03-31T00:00:00Z",
    verifier: "TEST-ONLY independent fixture verifier",
    verificationRef: "TEST-ONLY: no production claim",
  };
  for (const key of [
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
  ]) {
    input[key].evidenceStatus = "PROVIDED";
    input[key].provenance = { ...provenance };
  }
  input.deploymentBinding.sourceManifestSha256 = `sha256:${"b".repeat(64)}`;
  input.deploymentBinding.auditCommit = "c".repeat(40);
  input.deploymentBinding.deployments = [
    "ProtocolConfigV1",
    "MarketFactoryV1",
    "FullMarketVaultV1",
    "CloneMarketVaultV1",
    "MarketplaceV1",
    "BondEscrowV1",
    "SponsorshipPaymasterV1",
    "LaunchExposureGuardV1",
  ].map((component, index) => ({
    component,
    address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    runtimeCodeHash: `0x${(index + 11).toString(16).padStart(64, "0")}`,
  }));
  input.configurationEvidence.observedBlockNumber = "1000";
  input.configurationEvidence.rpcVerified = true;
  input.configurationEvidence.marketSnapshots = ["FULL", "CLONE"].map(
    (mode) => {
      const component = `${mode === "FULL" ? "Full" : "Clone"}MarketVaultV1`;
      const deployment = input.deploymentBinding.deployments.find(
        (item) => item.component === component,
      );
      return {
        mode,
        vaultAddress: deployment.address,
        runtimeCodeHash: deployment.runtimeCodeHash,
        marketPrimaryCapAtomic:
          mode === "FULL"
            ? input.subject.v1.fullMarketCapAtomic
            : input.subject.v1.cloneMarketCapAtomic,
        creatorRakeBps: input.subject.v1.creatorRakeBps,
        protocolShareBps: input.subject.v1.protocolShareBps,
        earlyBirdShareBps: input.subject.v1.earlyBirdShareBps,
        platformC2CFeeBps: input.subject.v1.platformC2CFeeBps,
        creatorC2CFeeBps: input.subject.v1.creatorC2CFeeBps,
      };
    },
  );
  Object.assign(input.ethUsdEvidence, {
    ethUsdE8: "300000000000",
    observedAt: "2026-03-30T00:00:00Z",
    validUntil: "2026-04-01T00:00:00Z",
  });
  input.gasPriceEvidence.samplesWei = ["10000000"];
  const operationComponents = {
    PAYMASTER_OVERHEAD: "SponsorshipPaymasterV1",
    BOND_SETTLE: "BondEscrowV1",
    LISTING_CANCEL: "MarketplaceV1",
    TERMINAL_RETURN: "MarketplaceV1",
  };
  const operations = [
    "RESOLVE",
    "CREATOR_VOID",
    "TIMEOUT_VOID",
    "BOND_SETTLE",
    "WINNER_CLAIM",
    "PAYMASTER_OVERHEAD",
    "REFUND_CLAIM",
    "LISTING_CANCEL",
    "TERMINAL_RETURN",
    "TIMEOUT_BONUS_CLAIM",
  ];
  const receipts = operations.flatMap((operation) =>
    (operationComponents[operation] === undefined
      ? ["FULL", "CLONE"]
      : ["NA"]
    ).map((deploymentMode) => ({ operation, deploymentMode })),
  );
  input.baseReceipts.receipts = receipts.map(
    ({ operation, deploymentMode }, index) => {
      const component =
        operationComponents[operation] ??
        `${deploymentMode === "FULL" ? "Full" : "Clone"}MarketVaultV1`;
      const deployment = input.deploymentBinding.deployments.find(
        (item) => item.component === component,
      );
      return {
        transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
        contractAddress: deployment.address,
        runtimeCodeHash: deployment.runtimeCodeHash,
        chainId: 8453,
        blockNumber: String(1_000 + index),
        operation,
        deploymentMode,
        gasUsed: operation === "PAYMASTER_OVERHEAD" ? "50000" : "100000",
        effectiveGasPriceWei: "10000000",
        l1FeeWei: "100000000000",
        externalChargeAtomic: "0",
        coveredClaims: "1",
        success: true,
        synthetic: false,
        rpcVerified: true,
      };
    },
  );
  input.bondEvidence.cohorts = [
    {
      mode: "FULL",
      sampleCount: "30",
      observedAttackProfitP95Atomic: "50000000",
      incidentResponseCostP95Atomic: "10000000",
    },
    {
      mode: "CLONE",
      sampleCount: "30",
      observedAttackProfitP95Atomic: "5000000",
      incidentResponseCostP95Atomic: "1000000",
    },
  ];
  Object.assign(input.microPoolEvidence, {
    mode: "CLONE",
    principalAtomic: "500000000",
    expectedClaimantCount: "10",
    paymasterSponsoredShareBps: "10000",
    earlyBirdEnabled: true,
  });
  input.marketCapEvidence.cohorts = [
    {
      mode: "FULL",
      sampleCount: "30",
      p95PeakPrincipalAtomic: "3000000000",
      capDeniedOrders: "0",
      eligibleOrders: "1000",
      unrecoveredLossAtomic: "0",
    },
    {
      mode: "CLONE",
      sampleCount: "30",
      p95PeakPrincipalAtomic: "300000000",
      capDeniedOrders: "0",
      eligibleOrders: "1000",
      unrecoveredLossAtomic: "0",
    },
  ];
  Object.assign(input.earlyBirdEvidence, {
    walletCount: "100",
    flaggedWalletCount: "5",
    totalEarlyPrincipalAtomic: "1000000000",
    flaggedEarlyPrincipalAtomic: "40000000",
    totalEarlyRewardAtomic: "100000000",
    flaggedEarlyRewardAtomic: "4000000",
  });
  input.c2cEvidence.matchedCohorts = true;
  input.c2cEvidence.baseline = {
    feeBps: "0",
    sampleCount: "100",
    quotedUnits: "1000000",
    filledUnits: "800000",
    medianTimeToFillSeconds: "100",
  };
  input.c2cEvidence.candidate = {
    feeBps: "200",
    sampleCount: "100",
    quotedUnits: "1000000",
    filledUnits: "760000",
    medianTimeToFillSeconds: "110",
  };
  Object.assign(input.launchGuardEvidence, {
    observationDays: "90",
    marketCount: "1000",
    accountingMismatchCount: "0",
    guardBypassIncidentCount: "0",
    unrecoveredIncidentCount: "0",
    capDeniedOrders: "5",
    eligibleOrders: "10000",
    p95ExposureUtilizationBps: "6000",
  });
  for (const [key, section] of Object.entries(policy)) {
    if (
      key === "$schema" ||
      key === "schemaVersion" ||
      key === "policyId" ||
      key === "maximumAssessmentValiditySeconds"
    )
      continue;
    section.approved = true;
    section.approvalRef = "TEST-ONLY policy fixture";
  }
  policy.bondDeterrence.minimumSamplesPerMode = "30";
  policy.microPoolRake.minimumReceiptsPerOperation = "1";
  policy.marketCaps.minimumSamplesPerMode = "30";
  policy.earlyBirdSybil.minimumWallets = "100";
  policy.c2cLiquidity.minimumSamplesPerCohort = "100";
  policy.launchGuardRetirement.minimumObservationDays = "90";
  policy.launchGuardRetirement.minimumMarkets = "1000";
  policy.extremeGasExit.minimumGasPriceSamples = "1";
  policy.extremeGasExit.minimumReceiptsPerOperation = "1";
  return { input, policy };
}
