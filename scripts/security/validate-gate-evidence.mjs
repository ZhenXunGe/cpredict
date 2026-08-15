import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_HALMOS_TESTS = [
  "check_C2CConservation(uint128,uint128,uint16,uint16)",
  "check_RakeConservation(uint128,uint16,uint16,uint16,bool)",
  "check_RemainingPoolStep(uint128,uint128,uint128)",
];

const EXPECTED_ECHIDNA_PROPERTIES = [
  "echidna_fee_and_bond_vaults_are_solvent",
  "echidna_guard_is_conservative",
  "echidna_supply_is_conserved",
  "echidna_vault_assets_cover_liabilities",
];

const EXPECTED_MEDUSA_TESTS = [
  "Assertion Test: EchidnaMarketAccounting.bondEscrow()",
  "Assertion Test: EchidnaMarketAccounting.burnLosing(uint256,uint256)",
  "Assertion Test: EchidnaMarketAccounting.buy(uint256,uint256,uint256)",
  "Assertion Test: EchidnaMarketAccounting.claimCreatorBond()",
  "Assertion Test: EchidnaMarketAccounting.claimCreatorFee()",
  "Assertion Test: EchidnaMarketAccounting.claimEarlyBird(uint256)",
  "Assertion Test: EchidnaMarketAccounting.claimTimeoutBonus(uint256)",
  "Assertion Test: EchidnaMarketAccounting.claimWinner(uint256)",
  "Assertion Test: EchidnaMarketAccounting.creatorResolve(uint256)",
  "Assertion Test: EchidnaMarketAccounting.creatorVoid()",
  "Assertion Test: EchidnaMarketAccounting.echidna_fee_and_bond_vaults_are_solvent()",
  "Assertion Test: EchidnaMarketAccounting.echidna_guard_is_conservative()",
  "Assertion Test: EchidnaMarketAccounting.echidna_supply_is_conserved()",
  "Assertion Test: EchidnaMarketAccounting.echidna_vault_assets_cover_liabilities()",
  "Assertion Test: EchidnaMarketAccounting.feeVault()",
  "Assertion Test: EchidnaMarketAccounting.guard()",
  "Assertion Test: EchidnaMarketAccounting.market()",
  "Assertion Test: EchidnaMarketAccounting.refund(uint256)",
  "Assertion Test: EchidnaMarketAccounting.settleBond()",
  "Assertion Test: EchidnaMarketAccounting.syncGuard()",
  "Assertion Test: EchidnaMarketAccounting.timeoutVoid()",
  "Assertion Test: EchidnaMarketAccounting.transfer(uint256,uint256,uint256,uint256)",
  "Assertion Test: EchidnaMarketAccounting.usdc()",
  "Property Test: EchidnaMarketAccounting.property_fee_and_bond_vaults_are_solvent()",
  "Property Test: EchidnaMarketAccounting.property_guard_is_conservative()",
  "Property Test: EchidnaMarketAccounting.property_supply_is_conserved()",
  "Property Test: EchidnaMarketAccounting.property_vault_assets_cover_liabilities()",
];

const EXPECTED_ADERYN_HIGH = [
  "contract-locks-ether|src/paymaster/SponsorshipPaymasterV1.sol:25",
  "reentrancy-state-change|src/core/BondEscrowV1.sol:73",
  "reentrancy-state-change|src/core/BondEscrowV1.sol:88",
  "reentrancy-state-change|src/core/BondEscrowV1.sol:96",
  "reentrancy-state-change|src/core/FeeVaultV1.sol:73",
  "reentrancy-state-change|src/core/LaunchExposureGuardV1.sol:88",
  "reentrancy-state-change|src/core/MarketFactoryV1.sol:107",
  "reentrancy-state-change|src/core/MarketFactoryV1.sol:129",
  "reentrancy-state-change|src/core/MarketFactoryV1.sol:152",
  "reentrancy-state-change|src/core/MarketFactoryV1.sol:153",
  "reentrancy-state-change|src/core/MarketFactoryV1.sol:156",
  "reentrancy-state-change|src/core/ProtocolConfigV1.sol:53",
  "reentrancy-state-change|src/marketplace/FixedPriceMarketplaceV1.sol:140",
  "reentrancy-state-change|src/marketplace/FixedPriceMarketplaceV1.sol:143",
  "reentrancy-state-change|src/marketplace/FixedPriceMarketplaceV1.sol:145",
  "reentrancy-state-change|src/marketplace/FixedPriceMarketplaceV1.sol:146",
  "reentrancy-state-change|src/marketplace/FixedPriceMarketplaceV1.sol:147",
  "reentrancy-state-change|src/marketplace/FixedPriceMarketplaceV1.sol:149",
  "reentrancy-state-change|src/marketplace/FixedPriceMarketplaceV1.sol:150",
  "reentrancy-state-change|src/marketplace/FixedPriceMarketplaceV1.sol:171",
  "reentrancy-state-change|src/marketplace/FixedPriceMarketplaceV1.sol:287",
];

const EXPECTED_ADERYN_LOW_COUNTS = {
  "costly-loop": 1,
  "large-numeric-literal": 5,
  "literal-instead-of-constant": 19,
  "local-variable-shadowing": 2,
  "missing-inheritance": 4,
  "modifier-used-only-once": 2,
  "non-reentrant-not-first": 1,
  "require-revert-in-loop": 1,
};

const EXPECTED_SLITHER_HIGH_MEDIUM = [
  "High|reentrancy-balance|src/market/MarketVaultCoreV1.sol|function|_pullWithPermit2",
  "High|reentrancy-balance|src/marketplace/FixedPriceMarketplaceV1.sol|function|_pullWithPermit2",
];

const LOAD_STAGE_STATUS_KEYS = [
  "toolchain",
  "preflight",
  "preflightEvidence",
  "harnessReadiness",
  "api",
  "apiLog",
  "apiEvidence",
  "websocket",
  "websocketLog",
  "websocketEvidence",
  "typescript",
  "indexer",
  "indexerEvidence",
  "anvilReadiness",
  "chain",
  "chainEvidence",
  "manifestEvidence",
];

export function validateAderyn(report) {
  assertObject(report, "Aderyn report");
  assert(
    Array.isArray(report.detectors_used),
    "Aderyn detectors_used must be an array",
  );
  assert(
    report.detectors_used.length === 88,
    "Aderyn must report the pinned 88-detector inventory",
  );
  assert(
    new Set(report.detectors_used).size === report.detectors_used.length,
    "Aderyn detector inventory contains duplicates",
  );
  assertObject(report.files_summary, "Aderyn files_summary");
  assertPositiveInteger(
    report.files_summary.total_source_units,
    "Aderyn total_source_units",
  );
  assertPositiveInteger(report.files_summary.total_sloc, "Aderyn total_sloc");
  assertObject(report.issue_count, "Aderyn issue_count");
  assertIssueGroup(
    report.high_issues,
    report.issue_count.high,
    "Aderyn high issues",
  );
  assertIssueGroup(
    report.low_issues,
    report.issue_count.low,
    "Aderyn low issues",
  );

  const high = report.high_issues.issues.flatMap((issue) =>
    issue.instances.map(
      (instance) =>
        `${issue.detector_name}|${instance.contract_path}:${instance.line_no}`,
    ),
  );
  assertSameStrings(
    high,
    EXPECTED_ADERYN_HIGH,
    "Aderyn reviewed High baseline changed",
  );

  const lowCounts = Object.fromEntries(
    report.low_issues.issues.map((issue) => [
      issue.detector_name,
      issue.instances.length,
    ]),
  );
  assertDeepEqual(
    lowCounts,
    EXPECTED_ADERYN_LOW_COUNTS,
    "Aderyn reviewed Low baseline changed",
  );
}

export function validateHalmos(report, log) {
  assertObject(report, "Halmos JSON report");
  assert(report.exitcode === 0, "Halmos JSON exitcode must be zero");
  assertObject(report.test_results, "Halmos test_results");
  const contracts = Object.keys(report.test_results);
  assertSameStrings(
    contracts,
    ["test/security/ProtocolMath.smt.sol:ProtocolMathSmt"],
    "Halmos contract inventory changed",
  );
  const results = report.test_results[contracts[0]];
  assert(Array.isArray(results), "Halmos contract result must be an array");
  assertSameStrings(
    results.map((result) => result.name),
    EXPECTED_HALMOS_TESTS,
    "Halmos property inventory changed",
  );
  for (const result of results) {
    assert(result.exitcode === 0, `Halmos property failed: ${result.name}`);
    assert(
      result.num_models === 0,
      `Halmos counterexample model reported: ${result.name}`,
    );
    assert(
      Array.isArray(result.models) && result.models.length === 0,
      `Halmos models not empty: ${result.name}`,
    );
    assert(
      Array.isArray(result.num_paths) &&
        Number.isInteger(result.num_paths[0]) &&
        result.num_paths[0] > 0,
      `Halmos property explored zero paths: ${result.name}`,
    );
  }
  assert(
    /Symbolic test result:\s*3 passed;\s*0 failed/.test(log),
    "Halmos log must report exactly 3 passed and 0 failed",
  );
}

export function validateEchidna(log) {
  assert(
    !/(?:Crashed:|panic|Internal error|uncaught exception)/i.test(log),
    "Echidna crash marker found",
  );
  const calls = numericMatches(log, /Total calls:\s*([0-9]+)/g);
  assert(
    calls.length > 0 && Math.max(...calls) >= 1_000_000,
    "Echidna executed fewer than 1,000,000 calls",
  );
  const instructions = numericMatches(log, /Unique instructions:\s*([0-9]+)/g);
  assert(
    instructions.length > 0 && Math.max(...instructions) > 0,
    "Echidna reported zero unique instructions",
  );
  const results = [
    ...log.matchAll(
      /^(echidna_[A-Za-z0-9_]+):\s+(passing|failed|falsified)\s*$/gim,
    ),
  ];
  assertSameStrings(
    results.map((match) => match[1]),
    EXPECTED_ECHIDNA_PROPERTIES,
    "Echidna property inventory changed",
  );
  assert(
    results.every((match) => match[2].toLowerCase() === "passing"),
    "Echidna property failure reported",
  );
  assert(/Seed:\s*[0-9]+/.test(log), "Echidna seed is missing");
}

export function validateMedusa(log, coverage) {
  assert(
    !/(?:Crashed:|panic|Failed to initialize|Failed to compile)/i.test(log),
    "Medusa crash marker found",
  );
  const calls = numericMatches(log, /calls:\s*([0-9]+)/g);
  assert(
    calls.length > 0 && Math.max(...calls) >= 1_000_000,
    "Medusa executed fewer than 1,000,000 calls",
  );
  const summaries = [
    ...log.matchAll(
      /Test summary:\s*([0-9]+) test\(s\) passed,\s*([0-9]+) test\(s\) failed/g,
    ),
  ];
  assert(
    summaries.length === 1,
    "Medusa must emit exactly one final test summary",
  );
  assert(
    Number(summaries[0][1]) === 27 && Number(summaries[0][2]) === 0,
    "Medusa summary must be 27 passed, 0 failed",
  );
  const results = [
    ...log.matchAll(
      /\[(PASSED|FAILED)\]\s+((?:Assertion|Property) Test:\s*[^\r\n]+)/g,
    ),
  ];
  assertSameStrings(
    results.map((match) => match[2]),
    EXPECTED_MEDUSA_TESTS,
    "Medusa test inventory changed",
  );
  assert(
    results.every((match) => match[1] === "PASSED"),
    "Medusa test failure reported",
  );
  assert(
    /(?:^|\n)SF:/.test(coverage) && /(?:^|\n)DA:/.test(coverage),
    "Medusa LCOV evidence is empty or malformed",
  );
}

export function validateSmt(stdout, stderr) {
  const output = `${stdout}\n${stderr}`;
  assert(
    !/(?:CHC analysis was not possible|BMC analysis was not possible|Solver .* was not found|Counterexample|Warning:\s*(?:CHC|BMC):\s*Assertion violation)/i.test(
      output,
    ),
    "SMTChecker reported an unavailable engine, violation, or counterexample",
  );
  const expectedLines = [27, 28, 29, 30, 47, 48, 49, 50, 68, 69];
  const proved = new Map([
    ["CHC", []],
    ["BMC", []],
  ]);
  for (const match of output.matchAll(
    /Info:\s*(CHC|BMC):\s*Assertion violation check is safe!\s*-->\s*test\/security\/ProtocolMath\.smt\.sol:([0-9]+):[0-9]+/g,
  )) {
    proved.get(match[1]).push(Number(match[2]));
  }
  for (const engine of ["CHC", "BMC"]) {
    assertDeepEqual(
      [...new Set(proved.get(engine))].sort((left, right) => left - right),
      expectedLines,
      `SMTChecker ${engine} assertion inventory changed`,
    );
  }
}

export function validateSlither(report) {
  assertObject(report, "Slither report");
  assert(report.success === true, "Slither report success must be true");
  assertObject(report.results, "Slither results");
  assert(
    Array.isArray(report.results.detectors),
    "Slither detectors must be an array",
  );
  const highMedium = report.results.detectors
    .filter(
      (detector) => detector.impact === "High" || detector.impact === "Medium",
    )
    .map((detector) => {
      const element = detector.elements?.[0];
      assertObject(element, `Slither ${detector.check} primary element`);
      const path = element.source_mapping?.filename_relative;
      assert(
        typeof path === "string" && path.startsWith("src/"),
        `Slither ${detector.check} path is invalid`,
      );
      return `${detector.impact}|${detector.check}|${path}|${element.type}|${element.name}`;
    });
  assertSameStrings(
    highMedium,
    EXPECTED_SLITHER_HIGH_MEDIUM,
    "Slither High/Medium findings differ from the reviewed baseline",
  );
}

export function validateK6Api(summary) {
  assertObject(summary, "k6 API summary");
  const iterations = metric(summary, "iterations");
  const requests = metric(summary, "http_reqs");
  const checks = metric(summary, "checks");
  const duration = metric(summary, "http_req_duration");
  const dropped = metric(summary, "dropped_iterations");
  const serverErrors = metric(summary, "cpredict_server_errors");
  const transportErrors = metric(summary, "cpredict_transport_errors");
  assertNonnegativeInteger(iterations.count, "k6 API iterations");
  assertNonnegativeInteger(dropped.count, "k6 API dropped iterations");
  const scheduled = iterations.count + dropped.count;
  assert(
    scheduled >= 270_000 && scheduled <= 270_002,
    "k6 API full profile must schedule 270,000 iterations (at most two executor-boundary iterations tolerated)",
  );
  assert(
    requests.count === iterations.count,
    "k6 API request count does not match iterations",
  );
  assertNonnegativeInteger(checks.passes, "k6 API passed checks");
  assertNonnegativeInteger(checks.fails, "k6 API failed checks");
  assert(
    checks.passes + checks.fails === iterations.count,
    "k6 API checks do not match iterations",
  );
  assert(
    checks.fails / iterations.count < 0.005,
    "k6 API successful-response rate is below 99.5%",
  );
  const apiNamedChecks = assertNamedChecks(
    summary,
    ["HTTP response is 2xx"],
    iterations.count,
    "k6 API",
  );
  assert(
    apiNamedChecks.passes === checks.passes &&
      apiNamedChecks.fails === checks.fails,
    "k6 API aggregate checks differ from named checks",
  );
  assertFinite(duration["p(95)"], "k6 API p95");
  assertFinite(duration["p(99)"], "k6 API p99");
  assert(duration["p(95)"] < 300, "k6 API p95 must be below 300 ms");
  assert(duration["p(99)"] < 750, "k6 API p99 must be below 750 ms");
  assert(dropped.count === 0, "k6 API dropped iterations must be zero");
  assertFinite(serverErrors.value, "k6 API server-error rate");
  assertFinite(transportErrors.value, "k6 API transport-error rate");
  assert(
    serverErrors.value < 0.005,
    "k6 API server-error rate must be below 0.5%",
  );
  assert(
    transportErrors.value < 0.005,
    "k6 API transport-error rate must be below 0.5%",
  );
  assertThresholds(
    duration,
    ["p(95)<300", "p(99)<750"],
    "k6 API duration thresholds",
  );
  assertThresholds(dropped, ["count==0"], "k6 API dropped-iteration threshold");
  assertThresholds(
    serverErrors,
    ["rate<0.005"],
    "k6 API server-error threshold",
  );
  assertThresholds(
    transportErrors,
    ["rate<0.005"],
    "k6 API transport-error threshold",
  );
}

export function validateK6Websocket(summary) {
  assertObject(summary, "k6 WebSocket summary");
  const iterations = metric(summary, "iterations");
  const checks = metric(summary, "checks");
  const connecting = metric(summary, "ws_connecting");
  const upgradeFailures = metric(summary, "cpredict_ws_upgrade_failures");
  const holdFailures = metric(summary, "cpredict_ws_hold_failures");
  assert(
    iterations.count === 10_000,
    "k6 WebSocket full profile must execute exactly 10,000 sessions",
  );
  assertNonnegativeInteger(checks.passes, "k6 WebSocket passed checks");
  assertNonnegativeInteger(checks.fails, "k6 WebSocket failed checks");
  assert(
    checks.passes + checks.fails === iterations.count * 2,
    "k6 WebSocket checks must contain upgrade and full-hold results for every session",
  );
  const websocketNamedChecks = assertNamedChecks(
    summary,
    ["WebSocket upgrade is 101", "WebSocket connection held target duration"],
    iterations.count,
    "k6 WebSocket",
  );
  assert(
    websocketNamedChecks.passes === checks.passes &&
      websocketNamedChecks.fails === checks.fails,
    "k6 WebSocket aggregate checks differ from named checks",
  );
  assertFailureRateMatchesCheck(
    upgradeFailures,
    summary.root_group.checks["WebSocket upgrade is 101"],
    iterations.count,
    "k6 WebSocket upgrade",
  );
  assertFailureRateMatchesCheck(
    holdFailures,
    summary.root_group.checks["WebSocket connection held target duration"],
    iterations.count,
    "k6 WebSocket hold",
  );
  assertFinite(connecting["p(95)"], "k6 WebSocket connect p95");
  assertFinite(connecting["p(99)"], "k6 WebSocket connect p99");
  assertFinite(upgradeFailures.value, "k6 WebSocket upgrade-failure rate");
  assertFinite(holdFailures.value, "k6 WebSocket hold-failure rate");
  assert(
    upgradeFailures.value < 0.005,
    "k6 WebSocket upgrade-failure rate must be below 0.5%",
  );
  assert(
    holdFailures.value < 0.005,
    "k6 WebSocket hold-failure rate must be below 0.5%",
  );
  assertThresholds(
    upgradeFailures,
    ["rate<0.005"],
    "k6 WebSocket upgrade threshold",
  );
  assertThresholds(holdFailures, ["rate<0.005"], "k6 WebSocket hold threshold");
}

export function validateLoadPreflight(report) {
  assertObject(report, "load preflight report");
  assertObject(report.commands, "load preflight commands");
  for (const command of ["k6", "anvil", "node"]) {
    assert(
      typeof report.commands[command] === "string" &&
        report.commands[command].length > 0,
      `preflight ${command} version is missing`,
    );
  }
  assertObject(report.fullProfileReadiness, "load preflight readiness");
  assertSameStrings(
    Object.keys(report.fullProfileReadiness),
    [
      "k6Present",
      "anvilPresent",
      "logicalCpuAtLeast8",
      "totalMemoryAtLeast16GiB",
      "systemMemoryFreePercentAtLeast20",
      "cpuCapacityAvailable",
      "fileDescriptorLimitAtLeast20000",
      "safeToStartFullProfile",
    ],
    "load preflight readiness inventory changed",
  );
  assert(
    Object.values(report.fullProfileReadiness).every((value) => value === true),
    "load preflight contains a failed readiness condition",
  );
  assert(
    report.fullProfileReadiness.safeToStartFullProfile === true,
    "load preflight is not safe for the full profile",
  );
}

export function validateLoadIndexer(report) {
  assertObject(report, "Indexer load report");
  assert(
    report.lane === "real-ChainIndexer-synthetic-client-counting-store",
    "Indexer lane changed",
  );
  assert(report.profile === "full", "Indexer report is not the full profile");
  assert(
    report.markets === 100 && report.listings === 100_000,
    "Indexer dataset inventory changed",
  );
  assert(
    report.totalEvents === 100_100 &&
      report.ingestedEvents === report.totalEvents,
    "Indexer event accounting mismatch",
  );
  assert(report.batches === 11, "Indexer batch inventory changed");
  assert(
    report.integrity?.exactEventCount === true,
    "Indexer exact-event-count gate failed",
  );
  assert(
    report.integrity?.lagAtMostTwoBlocks === true,
    "Indexer lag gate failed",
  );
  assert(
    report.syntheticProvisionalLagBlocks >= 0 &&
      report.syntheticProvisionalLagBlocks <= 2,
    "Indexer lag value is invalid",
  );
  assertFinite(report.elapsedSeconds, "Indexer elapsed time");
  assert(report.elapsedSeconds > 0, "Indexer elapsed time must be positive");
  assertFinite(report.eventsPerSecond, "Indexer events per second");
  assert(
    report.eventsPerSecond > 0,
    "Indexer events per second must be positive",
  );
  assertFinite(report.batchLatencyMs?.p50, "Indexer batch p50");
  assertFinite(report.batchLatencyMs?.p95, "Indexer batch p95");
  assertFinite(report.batchLatencyMs?.p99, "Indexer batch p99");
  assertFinite(report.batchLatencyMs?.max, "Indexer batch max");
}

export function validateLoadChain(report) {
  assertObject(report, "chain load report");
  assert(
    report.lane === "real-current-protocol-artifacts-on-fresh-local-anvil",
    "chain load lane changed",
  );
  assert(
    report.profile === "full" && report.deploymentMode === "FULL",
    "chain load profile or mode changed",
  );
  assert(
    report.targetTps === 50 && report.durationSeconds === 600,
    "chain load target inventory changed",
  );
  const classifications = report.classifications;
  assertObject(classifications, "chain load classifications");
  for (const key of [
    "planned",
    "submitted",
    "included",
    "success",
    "expectedRevert",
    "rejectedSubmission",
    "unexpectedRevert",
    "unexpectedSuccess",
    "missingReceipt",
  ]) {
    assertNonnegativeInteger(classifications[key], `chain load ${key}`);
  }
  assert(
    classifications.planned === 30_000,
    "chain load planned transaction count changed",
  );
  assert(
    classifications.submitted + classifications.rejectedSubmission ===
      classifications.planned,
    "chain load submission accounting mismatch",
  );
  assert(
    classifications.included + classifications.missingReceipt ===
      classifications.submitted,
    "chain load receipt accounting mismatch",
  );
  assert(
    classifications.success +
      classifications.expectedRevert +
      classifications.unexpectedRevert +
      classifications.unexpectedSuccess ===
      classifications.included,
    "chain load outcome accounting mismatch",
  );
  assert(
    classifications.rejectedSubmission === 0,
    "chain load rejected a planned submission",
  );
  assert(
    classifications.missingReceipt === 0,
    "chain load has a missing receipt",
  );
  assert(
    classifications.unexpectedRevert === 0,
    "chain load has an unexpected revert",
  );
  assert(
    classifications.unexpectedSuccess === 0,
    "chain load has an unexpected success",
  );
  assert(
    report.expectedRevertPercent === 5 &&
      classifications.expectedRevert === 1_500,
    "chain load expected-revert inventory changed",
  );
  assert(
    classifications.success === 28_500,
    "chain load successful transaction inventory changed",
  );
  assertFinite(report.elapsedSeconds, "chain load elapsed time");
  assert(
    report.elapsedSeconds >= 600,
    "chain load did not sustain the target for 600 seconds",
  );
  assertFinite(report.achievedSubmittedTps, "chain load submitted TPS");
  assertFinite(report.achievedIncludedTps, "chain load included TPS");
  assert(
    report.achievedSubmittedTps >= 49.5 && report.achievedIncludedTps >= 49.5,
    "chain load achieved less than 99% of 50 TPS",
  );
  for (const [name, latency] of [
    ["submission RPC", report.submissionRpcLatencyMs],
    ["inclusion", report.inclusionLatencyMs],
  ]) {
    assertObject(latency, `chain load ${name} latency`);
    assertSameStrings(
      Object.keys(latency),
      ["p50", "p95", "p99", "max"],
      `chain load ${name} latency inventory changed`,
    );
    for (const key of ["p50", "p95", "p99", "max"]) {
      assertFinite(latency[key], `chain load ${name} latency ${key}`);
      assert(
        latency[key] >= 0,
        `chain load ${name} latency ${key} must be nonnegative`,
      );
    }
    assert(
      latency.p50 <= latency.p95 &&
        latency.p95 <= latency.p99 &&
        latency.p99 <= latency.max,
      `chain load ${name} latency quantiles are not ordered`,
    );
  }
  assertObject(report.thresholds, "chain load thresholds");
  assertSameStrings(
    Object.keys(report.thresholds),
    [
      "allSubmissionsIncluded",
      "noUnexpectedOutcome",
      "achievedAtLeast95PercentOfTarget",
    ],
    "chain load threshold inventory changed",
  );
  assert(
    Object.values(report.thresholds).every((value) => value === true),
    "chain load threshold failed",
  );
}

export function validateLoadStageManifest(report) {
  validateLoadStageManifestStructure(report);
  assert(
    report.runStatus === "completed",
    "load stage manifest is not completed",
  );
  assert(
    report.overall === 0,
    "load stage manifest contains a nonzero stage result",
  );
}

export function validateLoadStageManifestStructure(report) {
  assertObject(report, "load stage manifest");
  assertSameStrings(
    Object.keys(report),
    [
      "schemaVersion",
      "runId",
      "runStatus",
      "runnerExit",
      ...LOAD_STAGE_STATUS_KEYS,
      "overall",
    ],
    "load stage manifest inventory changed",
  );
  assert(
    report.schemaVersion === 2,
    "load stage manifest schemaVersion must be 2",
  );
  assert(
    typeof report.runId === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(report.runId),
    "load stage manifest runId is invalid",
  );
  assert(
    report.runStatus === "running" ||
      report.runStatus === "aborted" ||
      report.runStatus === "completed",
    "load stage manifest runStatus is invalid",
  );
  assert(
    Number.isInteger(report.overall) &&
      (report.overall === 0 || report.overall === 1),
    "load stage manifest overall must be 0 or 1",
  );
  for (const key of LOAD_STAGE_STATUS_KEYS)
    assertLoadStageStatus(report[key], `load stage manifest ${key}`);

  if (report.runStatus === "running") {
    assert(
      report.runnerExit === "not_run",
      "running load stage manifest runnerExit must be not_run",
    );
    assert(
      report.overall === 1,
      "running load stage manifest must remain fail-closed",
    );
  } else {
    assertNonnegativeInteger(
      report.runnerExit,
      "load stage manifest runnerExit",
    );
  }

  if (report.runStatus === "aborted") {
    assert(
      report.runnerExit !== 0,
      "aborted load stage manifest runnerExit must be nonzero",
    );
    assert(
      report.overall === 1,
      "aborted load stage manifest overall must be one",
    );
  }

  if (report.runStatus === "completed") {
    const statuses = LOAD_STAGE_STATUS_KEYS.map((key) => report[key]);
    assert(
      statuses.every(Number.isInteger),
      "completed load stage manifest cannot contain not_run",
    );
    const expectedOverall = statuses.some((status) => status !== 0) ? 1 : 0;
    assert(
      report.overall === expectedOverall,
      "completed load stage manifest overall does not match stage results",
    );
    assert(
      report.runnerExit === report.overall,
      "completed load stage manifest runnerExit does not match overall",
    );
  }
}

async function main([mode, ...paths]) {
  switch (mode) {
    case "aderyn":
      requirePathCount(mode, paths, 1);
      validateAderyn(await readJson(paths[0]));
      break;
    case "halmos":
      requirePathCount(mode, paths, 2);
      validateHalmos(
        await readJson(paths[0]),
        await readFile(paths[1], "utf8"),
      );
      break;
    case "echidna":
      requirePathCount(mode, paths, 1);
      validateEchidna(await readFile(paths[0], "utf8"));
      break;
    case "medusa":
      requirePathCount(mode, paths, 2);
      validateMedusa(
        await readFile(paths[0], "utf8"),
        await readFile(paths[1], "utf8"),
      );
      break;
    case "smt":
      requirePathCount(mode, paths, 2);
      validateSmt(
        await readFile(paths[0], "utf8"),
        await readFile(paths[1], "utf8"),
      );
      break;
    case "slither":
      requirePathCount(mode, paths, 1);
      validateSlither(await readJson(paths[0]));
      break;
    case "k6-api":
      requirePathCount(mode, paths, 1);
      validateK6Api(await readJson(paths[0]));
      break;
    case "k6-websocket":
      requirePathCount(mode, paths, 1);
      validateK6Websocket(await readJson(paths[0]));
      break;
    case "load-preflight":
      requirePathCount(mode, paths, 1);
      validateLoadPreflight(await readJson(paths[0]));
      break;
    case "load-indexer":
      requirePathCount(mode, paths, 1);
      validateLoadIndexer(await readJson(paths[0]));
      break;
    case "load-chain":
      requirePathCount(mode, paths, 1);
      validateLoadChain(await readJson(paths[0]));
      break;
    case "load-stage-manifest":
      requirePathCount(mode, paths, 1);
      validateLoadStageManifest(await readJson(paths[0]));
      break;
    case "load-stage-manifest-structure":
      requirePathCount(mode, paths, 1);
      validateLoadStageManifestStructure(await readJson(paths[0]));
      break;
    default:
      throw new Error(`unknown evidence mode: ${mode ?? "<missing>"}`);
  }
  process.stdout.write(`validated ${mode} evidence\n`);
}

function metric(summary, name) {
  const value = summary.metrics?.[name];
  assertObject(value, `k6 metric ${name}`);
  return value;
}

function assertThresholds(metricValue, expectedNames, label) {
  assertObject(metricValue.thresholds, label);
  assertSameStrings(
    Object.keys(metricValue.thresholds),
    expectedNames,
    `${label} inventory changed`,
  );
  const values = Object.values(metricValue.thresholds);
  // k6 summary JSON stores whether a threshold was breached: false means pass, true means fail.
  assert(
    values.every((value) => value === false),
    `${label} contain a failed condition`,
  );
}

function assertNamedChecks(summary, expectedNames, iterations, label) {
  assertObject(summary.root_group, `${label} root group`);
  assertObject(summary.root_group.checks, `${label} named checks`);
  assertSameStrings(
    Object.keys(summary.root_group.checks),
    expectedNames,
    `${label} named-check inventory changed`,
  );
  const totals = { passes: 0, fails: 0 };
  for (const name of expectedNames) {
    const result = summary.root_group.checks[name];
    assertObject(result, `${label} check ${name}`);
    assert(result.name === name, `${label} check name changed: ${name}`);
    assertNonnegativeInteger(result.passes, `${label} check passes: ${name}`);
    assertNonnegativeInteger(result.fails, `${label} check fails: ${name}`);
    assert(
      result.passes + result.fails === iterations,
      `${label} check does not cover every session: ${name}`,
    );
    assert(
      result.fails / iterations < 0.005,
      `${label} check success rate is below 99.5%: ${name}`,
    );
    totals.passes += result.passes;
    totals.fails += result.fails;
  }
  return totals;
}

function assertLoadStageStatus(value, label) {
  assert(
    value === "not_run" || (Number.isInteger(value) && value >= 0),
    `${label} must be a nonnegative integer or not_run`,
  );
}

function assertFailureRateMatchesCheck(
  rateMetric,
  namedCheck,
  iterations,
  label,
) {
  assertNonnegativeInteger(rateMetric.passes, `${label} failure samples`);
  assertNonnegativeInteger(rateMetric.fails, `${label} success samples`);
  assert(
    rateMetric.passes + rateMetric.fails === iterations,
    `${label} rate does not cover every session`,
  );
  assert(
    rateMetric.passes === namedCheck.fails,
    `${label} rate failures differ from its named check`,
  );
  assert(
    rateMetric.fails === namedCheck.passes,
    `${label} rate successes differ from its named check`,
  );
  assert(
    Math.abs(rateMetric.value - namedCheck.fails / iterations) < 1e-12,
    `${label} rate value differs from its named check`,
  );
}

function assertIssueGroup(group, expectedCount, label) {
  assertObject(group, label);
  assert(Array.isArray(group.issues), `${label}.issues must be an array`);
  assertNonnegativeInteger(expectedCount, `${label} count`);
  assert(
    group.issues.length === expectedCount,
    `${label} count does not match issue_count`,
  );
  for (const issue of group.issues) {
    assert(
      typeof issue.detector_name === "string" && issue.detector_name.length > 0,
      `${label} detector name is missing`,
    );
    assert(
      Array.isArray(issue.instances) && issue.instances.length > 0,
      `${label} detector has zero instances`,
    );
    for (const instance of issue.instances) {
      assert(
        typeof instance.contract_path === "string" &&
          instance.contract_path.startsWith("src/"),
        `${label} instance path is invalid`,
      );
      assertPositiveInteger(instance.line_no, `${label} instance line`);
    }
  }
}

function numericMatches(value, expression) {
  return [...value.matchAll(expression)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
}

function requirePathCount(mode, paths, expected) {
  assert(
    paths.length === expected,
    `${mode} expects ${expected} evidence path(s), got ${paths.length}`,
  );
}

function assertSameStrings(actual, expected, message) {
  assertDeepEqual([...actual].sort(), [...expected].sort(), message);
}

function assertDeepEqual(actual, expected, message) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: got ${JSON.stringify(actual)}`,
  );
}

function assertObject(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function assertPositiveInteger(value, label) {
  assert(
    Number.isInteger(value) && value > 0,
    `${label} must be a positive integer`,
  );
}

function assertNonnegativeInteger(value, label) {
  assert(
    Number.isInteger(value) && value >= 0,
    `${label} must be a nonnegative integer`,
  );
}

function assertFinite(value, label) {
  assert(Number.isFinite(value), `${label} must be a finite number`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`evidence validation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
