import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateLoadStageManifestStructure as validateLegacyManifestStructure } from "../security/validate-gate-evidence.mjs";

export const PRODUCTION_LOAD_STAGE_KEYS = [
  "toolchain",
  "preflight",
  "preflightEvidence",
  "postgresStart",
  "seed",
  "seedLog",
  "seedEvidence",
  "anvilReadiness",
  "typescript",
  "productionApiReadiness",
  "productionApiSmoke",
  "productionApiSmokeLog",
  "productionApiSmokeEvidence",
  "api",
  "apiLog",
  "apiEvidence",
  "websocket",
  "websocketLog",
  "websocketEvidence",
  "productionApiShutdown",
  "postgresShutdown",
  "postgresShutdownEvidence",
  "syntheticIndexer",
  "syntheticIndexerEvidence",
  "chain",
  "chainEvidence",
  "anvilShutdown",
  "manifestEvidence",
];
const STAGES = PRODUCTION_LOAD_STAGE_KEYS;

export function validateSeed(report) {
  object(report, "seed report");
  equal(report.schemaVersion, 1, "seed schemaVersion");
  equal(report.lane, "production-Fastify-PostgreSQL17-seed", "seed lane");
  validRunId(report.runId);
  equal(report.chainId, 31_337, "seed chainId");
  object(report.postgres, "seed postgres identity");
  equal(report.postgres.serverVersion, "17.10", "seed PostgreSQL version");
  equal(
    report.postgres.listenAddresses,
    "127.0.0.1",
    "seed PostgreSQL listen address",
  );
  equal(
    report.postgres.checkpointTimeout,
    "10min",
    "seed PostgreSQL checkpoint timeout",
  );
  assert(
    Number.isInteger(report.postgres.port) && report.postgres.port > 0,
    "seed PostgreSQL port is invalid",
  );
  assert(
    typeof report.postgres.systemIdentifier === "string" &&
      /^\d+$/.test(report.postgres.systemIdentifier),
    "seed PostgreSQL system identifier is invalid",
  );
  assert(
    !Number.isNaN(Date.parse(report.postgres.postmasterStartTime)),
    "seed PostgreSQL start time is invalid",
  );
  assert(
    Array.isArray(report.migrations) && report.migrations.length === 3,
    "seed migration inventory changed",
  );
  deepEqual(
    report.migrations.map((entry) => entry.name),
    [
      "001_indexer.sql",
      "002_settlement_evidence.sql",
      "003_read_api_indexes.sql",
    ],
    "seed migration order changed",
  );
  for (const entry of report.migrations) {
    assert(
      /^[0-9a-f]{64}$/.test(entry.sha256),
      `seed migration hash is invalid: ${entry.name}`,
    );
  }
  deepEqual(
    report.dataset,
    { markets: 100, listings: 100_000, listingsPerMarket: 1_000 },
    "seed dataset changed",
  );
  deepEqual(
    report.availableIndexes,
    [
      "fills_listing_block_idx",
      "listings_chain_active_updated_idx",
      "listings_vault_active_idx",
      "markets_chain_created_idx",
      "positions_owner_updated_idx",
    ],
    "seed required read-index inventory changed",
  );
  object(report.representativeQueryIndexes, "seed representative indexes");
  assert(
    Array.isArray(report.representativeQueryIndexes.listings) &&
      report.representativeQueryIndexes.listings.length > 0,
    "seed 100k listing query used no index",
  );
  allTrue(report.thresholds, "seed thresholds");
}

export function validateApiSmoke(report) {
  object(report, "production API smoke report");
  equal(report.schemaVersion, 1, "production API smoke schemaVersion");
  equal(
    report.lane,
    "production-indexer-Fastify-PostgreSQL-smoke",
    "production API smoke lane",
  );
  validRunId(report.runId);
  equal(report.chainId, 31_337, "production API smoke chainId");
  equal(
    report.datasetChecks?.marketsReturned,
    20,
    "production API market page size",
  );
  equal(
    report.datasetChecks?.listingsReturned,
    20,
    "production API listing page size",
  );
  equal(
    report.websocket?.message?.type,
    "ready",
    "production WebSocket ready type",
  );
  equal(
    report.websocket?.message?.protocolVersion,
    1,
    "production WebSocket protocol version",
  );
  assert(
    Number.isFinite(report.websocket?.upgradeAndReadyLatencyMs),
    "production WebSocket ready latency is missing",
  );
  equal(
    report.observability?.requiredMetricsPresent,
    true,
    "production observability metrics",
  );
  allTrue(report.thresholds, "production API smoke thresholds");
}

export function validateProductionK6Websocket(report) {
  object(report, "k6 WebSocket summary");
  const iterations = metric(report, "iterations");
  const checks = metric(report, "checks");
  const sessions = metric(report, "ws_sessions");
  const connecting = metric(report, "ws_connecting");
  equal(iterations.count, 10_000, "k6 WebSocket iterations");
  equal(sessions.count, 10_000, "k6 WebSocket sessions");
  equal(checks.passes + checks.fails, 20_000, "k6 WebSocket checks");
  finite(connecting["p(95)"], "k6 WebSocket connect p95");
  finite(connecting["p(99)"], "k6 WebSocket connect p99");
  const upgrade = validateFailureRate(
    report,
    "cpredict_ws_upgrade_failures",
    10_000,
  );
  const hold = validateFailureRate(report, "cpredict_ws_hold_failures", 10_000);
  validateFailureRate(report, "cpredict_ws_protocol_ready_failures", 10_000);
  equal(
    checks.fails,
    upgrade.passes + hold.passes,
    "k6 WebSocket failed checks/failure rates",
  );
}

export function validateProductionWebsocketCapacity(baseline, final) {
  for (const [value, phase] of [
    [baseline, "before"],
    [final, "after"],
  ]) {
    object(value, `WebSocket ${phase} capacity snapshot`);
    equal(value.schemaVersion, 1, `WebSocket ${phase} snapshot schemaVersion`);
    equal(
      value.lane,
      "production-indexer-websocket-capacity-snapshot",
      `WebSocket ${phase} snapshot lane`,
    );
    equal(value.phase, phase, `WebSocket ${phase} snapshot phase`);
    validRunId(value.runId);
    assert(
      !Number.isNaN(Date.parse(value.observedAt)),
      `WebSocket ${phase} snapshot timestamp is invalid`,
    );
    assert(
      typeof value.target === "string" &&
        value.target.startsWith("http://127.0.0.1:"),
      `WebSocket ${phase} snapshot target is invalid`,
    );
    for (const key of [
      "acceptedTotal",
      "rejectedTotal",
      "currentConnections",
      "peakConnections",
    ]) {
      assert(
        Number.isSafeInteger(value[key]) && value[key] >= 0,
        `WebSocket ${phase} ${key} is invalid`,
      );
    }
    assert(
      /^[0-9a-f]{64}$/.test(value.metricsSha256),
      `WebSocket ${phase} metrics hash is invalid`,
    );
  }
  equal(final.runId, baseline.runId, "WebSocket capacity runId");
  equal(final.target, baseline.target, "WebSocket capacity target");
  equal(baseline.acceptedTotal, 1, "WebSocket baseline accepted count");
  equal(baseline.rejectedTotal, 0, "WebSocket baseline rejected count");
  equal(
    baseline.currentConnections,
    0,
    "WebSocket baseline current connections",
  );
  equal(baseline.peakConnections, 1, "WebSocket baseline peak connections");
  equal(
    final.acceptedTotal - baseline.acceptedTotal,
    10_000,
    "WebSocket accepted-session delta",
  );
  equal(
    final.rejectedTotal - baseline.rejectedTotal,
    0,
    "WebSocket rejected-session delta",
  );
  equal(final.currentConnections, 0, "WebSocket final current connections");
  equal(
    final.peakConnections,
    10_000,
    "WebSocket simultaneous peak connections",
  );
}

export function validateProductionK6Api(report) {
  validateK6Api(report, [150_000, 1_250, 120_000], [150_500, 2_500, 122_000]);
}

export function validateCalibrationK6Api(report) {
  validateK6Api(report, [15_000, 1_250, 60_000], [15_500, 2_500, 62_000]);
}

function validateK6Api(report, required, configuredMaximum) {
  const [requiredSteady, requiredTransition, requiredBurst] = required;
  const [maximumSteady, maximumTransition, maximumBurst] = configuredMaximum;
  object(report, "k6 API summary");
  const iterations = metric(report, "iterations");
  const requests = metric(report, "http_reqs");
  const checks = metric(report, "checks");
  const duration = metric(report, "http_req_duration");
  const dropped = metric(report, "dropped_iterations");
  const scheduled = iterations.count + dropped.count;
  const requiredScheduled = requiredSteady + requiredTransition + requiredBurst;
  const maximumScheduled = maximumSteady + maximumTransition + maximumBurst;
  assert(
    scheduled >= requiredScheduled && scheduled <= maximumScheduled + 2,
    `k6 API profile must schedule within [${requiredScheduled.toString()}, ${(maximumScheduled + 2).toString()}] iterations`,
  );
  equal(
    requests.count,
    iterations.count,
    "k6 API request/iteration accounting",
  );
  const observedPhaseIterations = metric(
    report,
    "cpredict_api_phase_iterations",
  );
  equal(
    observedPhaseIterations.count,
    iterations.count,
    "k6 API aggregate phase/iteration accounting",
  );
  threshold(
    observedPhaseIterations,
    [
      `count>=${requiredScheduled.toString()}`,
      `count<=${(maximumScheduled + 2).toString()}`,
    ],
    "k6 API aggregate phase iterations",
  );
  equal(
    checks.passes + checks.fails,
    iterations.count,
    "k6 API check/iteration accounting",
  );
  assert(
    checks.fails / iterations.count < 0.005,
    "k6 API successful response rate is below 99.5%",
  );
  finite(duration["p(95)"], "k6 API p95");
  finite(duration["p(99)"], "k6 API p99");
  assert(duration["p(95)"] < 300, "k6 API p95 must be below 300 ms");
  assert(duration["p(99)"] < 750, "k6 API p99 must be below 750 ms");
  equal(dropped.count, 0, "k6 API dropped iterations");
  threshold(duration, ["p(95)<300", "p(99)<750"], "k6 API duration");
  threshold(dropped, ["count==0"], "k6 API dropped iterations");
  const response = validateFailureRate(
    report,
    "cpredict_response_errors",
    iterations.count,
  );
  validateFailureRate(report, "cpredict_server_errors", iterations.count);
  validateFailureRate(report, "cpredict_transport_errors", iterations.count);
  equal(
    response.passes,
    checks.fails,
    "k6 API response-error/check accounting",
  );

  validateApiPhase(report, "steady", requiredSteady);
  validateApiPhase(report, "transition", requiredTransition);
  validateApiPhase(report, "burst", requiredBurst);
}

function validateApiPhase(report, phase, requiredSamples) {
  const iterations = metric(
    report,
    `cpredict_api_phase_iterations{phase:${phase}}`,
  );
  assert(
    iterations.count >= requiredSamples,
    `k6 API ${phase} iterations must be at least ${requiredSamples}`,
  );
  threshold(
    iterations,
    [`count>=${requiredSamples.toString()}`],
    `k6 API ${phase} iterations`,
  );
  const duration = metric(report, `http_req_duration{phase:${phase}}`);
  finite(duration["p(95)"], `k6 API ${phase} p95`);
  finite(duration["p(99)"], `k6 API ${phase} p99`);
  assert(duration["p(95)"] < 300, `k6 API ${phase} p95 must be below 300 ms`);
  assert(duration["p(99)"] < 750, `k6 API ${phase} p99 must be below 750 ms`);
  threshold(duration, ["p(95)<300", "p(99)<750"], `k6 API ${phase} duration`);
  validateFailureRate(
    report,
    `cpredict_response_errors{phase:${phase}}`,
    iterations.count,
  );
  validateFailureRate(
    report,
    `cpredict_server_errors{phase:${phase}}`,
    iterations.count,
  );
  validateFailureRate(
    report,
    `cpredict_transport_errors{phase:${phase}}`,
    iterations.count,
  );
}

export function validatePostgresShutdown(report) {
  object(report, "PostgreSQL shutdown report");
  equal(report.schemaVersion, 1, "PostgreSQL shutdown schemaVersion");
  validRunId(report.runId);
  equal(report.pgCtlStopExit, 0, "PostgreSQL pg_ctl stop exit");
  equal(report.pgCtlStatusAfterStop, 3, "PostgreSQL pg_ctl status after stop");
  equal(report.pgIsReadyAfterStop, 2, "PostgreSQL pg_isready after stop");
  equal(
    report.dataDirectoryRemoved,
    true,
    "PostgreSQL temporary data directory cleanup",
  );
  assert(
    Number.isInteger(report.postmasterPid) && report.postmasterPid > 1,
    "PostgreSQL postmaster PID is invalid",
  );
}

export function validateProductionManifest(report, requirePass = true) {
  object(report, "production load stage manifest");
  const expectedKeys = [
    "schemaVersion",
    "lane",
    "runId",
    "runStatus",
    "runnerExit",
    ...STAGES,
    "overall",
  ];
  deepEqual(
    Object.keys(report),
    expectedKeys,
    "production load stage inventory changed",
  );
  equal(report.schemaVersion, 3, "production load stage schemaVersion");
  equal(
    report.lane,
    "real-production-Fastify-PostgreSQL-plus-local-chain",
    "production load lane",
  );
  validRunId(report.runId);
  assert(
    ["running", "aborted", "completed"].includes(report.runStatus),
    "production load runStatus is invalid",
  );
  for (const key of STAGES) stageStatus(report[key], key);
  assert(
    report.overall === 0 || report.overall === 1,
    "production load overall is invalid",
  );
  if (report.runStatus === "running") {
    equal(report.runnerExit, "not_run", "running production load runnerExit");
    equal(report.overall, 1, "running production load overall");
  } else {
    assert(
      Number.isInteger(report.runnerExit) && report.runnerExit >= 0,
      "production load runnerExit is invalid",
    );
  }
  if (report.runStatus === "aborted") {
    assert(
      report.runnerExit !== 0,
      "aborted production load runnerExit must be nonzero",
    );
    equal(report.overall, 1, "aborted production load overall");
  }
  if (report.runStatus === "completed") {
    assert(
      STAGES.every((key) => Number.isInteger(report[key])),
      "completed production load has an unrun stage",
    );
    const expectedOverall = STAGES.some((key) => report[key] !== 0) ? 1 : 0;
    equal(report.overall, expectedOverall, "production load derived overall");
    equal(
      report.runnerExit,
      report.overall,
      "production load runner exit/overall",
    );
  }
  if (requirePass) {
    equal(report.runStatus, "completed", "production load completion status");
    equal(report.overall, 0, "production load gate result");
  }
}

async function main([mode, ...paths]) {
  if (mode === "websocket-capacity") {
    if (paths.length !== 2)
      throw new Error(
        "websocket-capacity expects before and after evidence paths",
      );
    const [baseline, final] = await Promise.all(
      paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))),
    );
    validateProductionWebsocketCapacity(baseline, final);
    process.stdout.write("validated production websocket-capacity evidence\n");
    return;
  }
  if (paths.length !== 1)
    throw new Error(`${mode ?? "<missing>"} expects exactly one evidence path`);
  const report = JSON.parse(await readFile(paths[0], "utf8"));
  switch (mode) {
    case "seed":
      validateSeed(report);
      break;
    case "api-smoke":
      validateApiSmoke(report);
      break;
    case "k6-api":
      validateProductionK6Api(report);
      break;
    case "k6-api-calibration":
      validateCalibrationK6Api(report);
      break;
    case "k6-websocket":
      validateProductionK6Websocket(report);
      break;
    case "postgres-shutdown":
      validatePostgresShutdown(report);
      break;
    case "stage-manifest":
      validateProductionManifest(report, true);
      break;
    case "stage-manifest-structure":
      validateProductionManifest(report, false);
      break;
    case "legacy-stage-manifest-structure":
      validateLegacyManifestStructure(report);
      break;
    default:
      throw new Error(
        `unknown production evidence mode: ${mode ?? "<missing>"}`,
      );
  }
  process.stdout.write(`validated production ${mode} evidence\n`);
}

function allTrue(value, label) {
  object(value, label);
  assert(
    Object.keys(value).length > 0 &&
      Object.values(value).every((entry) => entry === true),
    `${label} contains a failed result`,
  );
}

function metric(report, name) {
  const value = report.metrics?.[name];
  object(value, `k6 metric ${name}`);
  return value;
}

function validateFailureRate(report, name, expectedSamples) {
  const value = metric(report, name);
  finite(value.value, `k6 ${name} rate`);
  assert(value.value < 0.005, `k6 ${name} must be below 0.5%`);
  equal(value.passes + value.fails, expectedSamples, `k6 ${name} samples`);
  threshold(value, ["rate<0.005"], `k6 ${name}`);
  return value;
}

function threshold(value, expected, label) {
  object(value.thresholds, `${label} thresholds`);
  deepEqual(
    Object.keys(value.thresholds).sort(),
    [...expected].sort(),
    `${label} threshold inventory`,
  );
  assert(
    Object.values(value.thresholds).every((failed) => failed === false),
    `${label} threshold failed`,
  );
}

function finite(value, label) {
  assert(Number.isFinite(value), `${label} must be finite`);
}

function validRunId(value) {
  assert(
    typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value),
    "runId is invalid",
  );
}

function stageStatus(value, key) {
  assert(
    value === "not_run" || (Number.isInteger(value) && value >= 0),
    `stage ${key} is invalid`,
  );
}

function object(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function equal(actual, expected, label) {
  assert(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function deepEqual(actual, expected, label) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `production evidence validation failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
