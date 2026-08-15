import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  validateDistributedWebsocketCapacity,
  validateClockWindow,
  validateEventLatency,
  validateReorg,
  validateRoleTopology,
  validateRoleEvidence,
  validateTelemetry,
} from "./commercial-evidence.mjs";
import { buildTelemetrySummary } from "./telemetry-evidence.mjs";
import { buildEventLatencySummary } from "./event-latency-evidence.mjs";

test("distributed WebSocket capacity requires a fresh-process 10k simultaneous peak", () => {
  const before = websocket("before", 17, 2, 0, 0, 0);
  const after = websocket("after", 10_017, 2, 0, 10_000, 70_000);
  assert.doesNotThrow(() =>
    validateDistributedWebsocketCapacity(before, after),
  );
  before.peakConnections = 1;
  assert.throws(
    () => validateDistributedWebsocketCapacity(before, after),
    /baseline peak/,
  );
  before.peakConnections = 0;
  after.peakConnections = 9_999;
  assert.throws(
    () => validateDistributedWebsocketCapacity(before, after),
    /simultaneous peak/,
  );
});

test("telemetry is recomputed from raw samples and uses production store metrics", () => {
  const raw = rawTelemetry();
  const encoded = `${JSON.stringify(raw, null, 2)}\n`;
  const digest = sha256(encoded);
  const report = buildTelemetrySummary(raw, digest);
  assert.doesNotThrow(() => validateTelemetry(report, raw, digest));
  report.database.operationLatencyMs.p95 += 1;
  assert.throws(
    () => validateTelemetry(report, raw, digest),
    /raw recomputation/,
  );
});

test("event latency inventory is bound to all successful chain transactions", () => {
  const chain = chainReport();
  const chainSha = sha256(`${JSON.stringify(chain, null, 2)}\n`);
  const raw = eventLatencyRaw();
  const rawSha = sha256(`${JSON.stringify(raw, null, 2)}\n`);
  const report = buildEventLatencySummary(raw, chain, chainSha, rawSha);
  assert.doesNotThrow(() =>
    validateEventLatency(report, raw, chain, chainSha, rawSha),
  );
  raw.deliveries.pop();
  assert.throws(
    () => validateEventLatency(report, raw, chain, chainSha, rawSha),
    /raw recomputation|missing events/,
  );
  raw.deliveries.push(eventDelivery(28_499));
  report.latencyMs.p95 = 2_000;
  assert.throws(
    () => validateEventLatency(report, raw, chain, chainSha, rawSha),
    /raw recomputation|below 2000/,
  );
});

test("reorg proof requires hashes and complete rollback/replay inventories", () => {
  const report = reorgReport();
  assert.doesNotThrow(() => validateReorg(report));
  report.rollback.orphanedEventRowsAfter = 1;
  assert.throws(() => validateReorg(report), /orphaned events after rollback/);
  report.rollback.orphanedEventRowsAfter = 0;
  report.finalCheckpoint.blockHash = hash("9");
  assert.throws(() => validateReorg(report), /final checkpoint hash/);
});

test("role topology rejects duplicate hosts, release drift, target drift, and non-overlapping clocks", () => {
  const roles = {
    sut: role("1", 0, 1_000, "sut"),
    load: role("2", 100, 900, "load"),
    chain: role("3", 200, 800, "chain"),
  };
  assert.doesNotThrow(() => validateRoleTopology(roles));
  roles.chain.host.machineFingerprintSha256 =
    roles.load.host.machineFingerprintSha256;
  assert.throws(
    () => validateRoleTopology(roles),
    /machine fingerprint separation/,
  );
  roles.chain.host.machineFingerprintSha256 = "3".repeat(64);
  roles.chain.releaseBinding.sourceManifestSha256 = "9".repeat(64);
  assert.throws(() => validateRoleTopology(roles), /sourceManifestSha256/);
  roles.chain.releaseBinding.sourceManifestSha256 = "a".repeat(64);
  roles.chain.targets.sutOrigin = "https://wrong.example.invalid";
  assert.throws(
    () => validateRoleTopology(roles),
    /chain observer\/SUT API target/,
  );
  roles.chain.targets.sutOrigin = "https://sut.example.invalid";
  roles.chain.window.startedAt = new Date(2_000_000).toISOString();
  roles.chain.window.completedAt = new Date(2_100_000).toISOString();
  roles.chain.observedAt = roles.chain.window.completedAt;
  assert.throws(() => validateRoleTopology(roles), /overlap/);
});

test("role topology accepts exact /v1/stream and rejects a root WebSocket target", () => {
  const roles = {
    sut: role("1", 0, 1_000, "sut"),
    load: role("2", 100, 900, "load"),
    chain: role("3", 200, 800, "chain"),
  };
  assert.doesNotThrow(() => validateRoleTopology(roles));
  roles.load.targets.websocketTarget = "wss://sut.example.invalid/";
  assert.throws(
    () => validateRoleTopology(roles),
    /load\/SUT WebSocket target/,
  );
});

test("role evidence binds an opaque host identity receipt without overstating verification", () => {
  const report = {
    schemaVersion: 1,
    lane: "distributed-commercial-load-role",
    role: "load",
    runId: "fixture",
    runStatus: "completed",
    host: {
      identitySha256: "1".repeat(64),
      machineFingerprintSha256: "2".repeat(64),
      identitySource: "cloud-instance-identity",
      identityEvidence: {
        path: "host-identity-evidence.bin",
        sha256: "3".repeat(64),
        bytes: 128,
        assurance:
          "opaque-external-host-identity-evidence-not-cryptographically-verified-by-cpredict",
      },
    },
    stages: { load: 0 },
    artifacts: [
      {
        name: "host-identity-evidence.bin",
        sha256: "3".repeat(64),
        bytes: 128,
      },
    ],
  };
  assert.doesNotThrow(() => validateRoleEvidence(report, "load", "fixture"));
  report.host.identityEvidence.assurance = "cryptographically-verified";
  assert.throws(
    () => validateRoleEvidence(report, "load", "fixture"),
    /assurance boundary/,
  );
});

test("clock evidence must be fresh for the role window", () => {
  assert.doesNotThrow(() =>
    validateClockWindow(50_000, 100_000, 200_000, "load"),
  );
  assert.throws(
    () => validateClockWindow(39_999, 100_000, 200_000, "load"),
    /within 60 seconds/,
  );
  assert.throws(
    () => validateClockWindow(200_001, 100_000, 200_000, "load"),
    /within 60 seconds/,
  );
});

function websocket(
  phase,
  acceptedTotal,
  rejectedTotal,
  currentConnections,
  peakConnections,
  observedAt,
) {
  return {
    schemaVersion: 1,
    runId: "fixture",
    phase,
    observedAt: new Date(observedAt).toISOString(),
    target: "https://sut.example.invalid",
    processStartTimeSeconds: 1_700_000_000,
    acceptedTotal,
    rejectedTotal,
    currentConnections,
    peakConnections,
  };
}

function rawTelemetry() {
  return {
    schemaVersion: 1,
    lane: "distributed-commercial-sut-telemetry-raw",
    runId: "fixture",
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(600_000).toISOString(),
    sampleIntervalMs: 5_000,
    allowedBlockLag: 2,
    samples: [
      {
        observedAt: new Date(0).toISOString(),
        metrics: metrics(0),
        chainHead: 100,
        postgres: {
          activeConnections: 2,
          transactions: 1_000,
          checkpoints: 10,
        },
      },
      {
        observedAt: new Date(600_000).toISOString(),
        metrics: metrics(1),
        chainHead: 200,
        postgres: {
          activeConnections: 8,
          transactions: 301_000,
          checkpoints: 12,
        },
      },
    ],
  };
}

function metrics(phase) {
  const end = phase === 1;
  const count = end ? 100 : 0;
  const accepted = end ? 10_000 : 0;
  const scalar = {
    cpredict_indexer_process_cpu_seconds_total: end ? 10 : 0,
    cpredict_indexer_process_resident_memory_bytes: end ? 1_000 : 900,
    cpredict_indexer_nodejs_eventloop_lag_seconds: 0.005,
    cpredict_indexer_http_connections: end ? 100 : 0,
    cpredict_indexer_http_requests_queued: end ? 2 : 0,
    cpredict_indexer_http_requests_in_flight: end ? 10 : 0,
    cpredict_indexer_db_operations_queued: end ? 2 : 0,
    cpredict_indexer_db_operations_in_flight: end ? 8 : 0,
    cpredict_indexer_db_configured_connections: 10,
    cpredict_indexer_last_indexed_block: end ? 199 : 99,
    cpredict_indexer_ws_accepted_total: accepted,
    cpredict_indexer_ws_connections: 0,
    cpredict_indexer_ws_peak_connections: accepted,
  };
  const result = Object.entries(scalar).map(([key, value]) => ({ key, value }));
  for (const name of [
    "cpredict_indexer_http_request_duration_seconds",
    "cpredict_indexer_db_admission_wait_seconds",
    "cpredict_indexer_tick_seconds",
  ]) {
    result.push({ key: `${name}_bucket{le="0.1"}`, value: count });
    result.push({ key: `${name}_bucket{le="+Inf"}`, value: count });
    result.push({ key: `${name}_count`, value: count });
  }
  const db = "cpredict_indexer_db_operation_duration_seconds";
  result.push({
    key: `${db}_bucket{le="0.1",operation="list_markets"}`,
    value: count,
  });
  result.push({
    key: `${db}_bucket{le="+Inf",operation="list_markets"}`,
    value: count,
  });
  result.push({ key: `${db}_count{operation="list_markets"}`, value: count });
  result.push({
    key: 'cpredict_indexer_ws_rejected_total{reason="capacity"}',
    value: 0,
  });
  result.push({
    key: 'cpredict_indexer_ws_outbound_total{kind="ready"}',
    value: accepted,
  });
  result.push({
    key: 'cpredict_indexer_ws_heartbeat_total{kind="ping"}',
    value: end ? 20_000 : 0,
  });
  return result;
}

function chainReport() {
  return {
    market: "0x0000000000000000000000000000000000000001",
    profile: "full",
    targetTps: 50,
    durationSeconds: 600,
    classifications: {
      planned: 30_000,
      submitted: 30_000,
      included: 30_000,
      success: 28_500,
      expectedRevert: 1_500,
      rejectedSubmission: 0,
      unexpectedRevert: 0,
      unexpectedSuccess: 0,
      missingReceipt: 0,
    },
    thresholds: {
      allSubmissionsIncluded: true,
      noUnexpectedOutcome: true,
      achievedAtLeast95PercentOfTarget: true,
    },
  };
}

function eventLatencyRaw() {
  return {
    schemaVersion: 1,
    lane: "chain-receipt-to-websocket-client-raw",
    clockDomain: "single-process-monotonic-nanoseconds",
    market: "0x0000000000000000000000000000000000000001",
    transactions: Array.from({ length: 30_000 }, (_, index) => ({
      transactionHash: transactionHash(index),
      blockNumber: 1 + Math.floor(index / 50),
      expectedOutcome: index < 28_500 ? "success" : "expected-revert",
      receiptStatus: index < 28_500 ? "success" : "expected-revert",
    })),
    deliveries: Array.from({ length: 28_500 }, (_, index) =>
      eventDelivery(index),
    ),
  };
}

function eventDelivery(index) {
  return {
    transactionHash: transactionHash(index),
    logIndex: 0,
    eventName: "PrimaryPurchased",
    receiptObservedMonotonicNs: String(1_000_000_000 + index * 1_000_000),
    websocketReceivedMonotonicNs: String(1_001_000_000 + index * 1_000_000),
  };
}

function transactionHash(index) {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function reorgReport() {
  return {
    schemaVersion: 2,
    lane: "multi-block-common-ancestor-rollback-replay",
    injectedDepth: 3,
    commonAncestor: { blockNumber: 100, blockHash: hash("a") },
    oldBranch: { tipBlockNumber: 103, tipHash: hash("b"), blockCount: 3 },
    newBranch: { tipBlockNumber: 103, tipHash: hash("c"), blockCount: 3 },
    rollback: {
      orphanedBlockRowsBefore: 3,
      orphanedEventRowsBefore: 60,
      orphanedBlockRowsAfter: 0,
      orphanedEventRowsAfter: 0,
      transactionAtomicityFailures: 0,
    },
    replay: {
      expectedBlocks: 3,
      replayedBlocks: 3,
      expectedEvents: 60,
      replayedEvents: 60,
      missingEvents: 0,
      duplicateEvents: 0,
    },
    finalCheckpoint: { blockNumber: 103, blockHash: hash("c") },
    recoveryMs: 250,
  };
}

function role(id, startSeconds, endSeconds, roleName) {
  const allTargets = {
    sutOrigin: "https://sut.example.invalid",
    websocketTarget: "wss://sut.example.invalid/v1/stream",
    chainRpcOrigin: "https://chain.example.invalid",
  };
  const targets =
    roleName === "load"
      ? {
          sutOrigin: allTargets.sutOrigin,
          websocketTarget: allTargets.websocketTarget,
        }
      : allTargets;
  return {
    observedAt: new Date(endSeconds * 1_000).toISOString(),
    host: {
      identitySha256: id.repeat(64),
      machineFingerprintSha256: id.repeat(64),
    },
    targets,
    releaseBinding: {
      gitCommitSha: "b".repeat(40),
      sourceManifestSha256: "a".repeat(64),
      releaseConfigSha256: "c".repeat(64),
      migrationsSha256: "d".repeat(64),
      runtimeImageDigest: `sha256:${id.repeat(64)}`,
    },
    window: {
      startedAt: new Date(startSeconds * 1_000).toISOString(),
      completedAt: new Date(endSeconds * 1_000).toISOString(),
      clockSource: "chrony",
      clockMaxOffsetMs: 25,
    },
  };
}

function hash(character) {
  return `0x${character.repeat(64)}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
