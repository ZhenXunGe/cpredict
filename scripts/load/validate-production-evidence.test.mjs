import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCTION_LOAD_STAGE_KEYS,
  validateCalibrationK6Api,
  validateProductionK6Api,
  validateProductionK6Websocket,
  validateProductionManifest,
  validateProductionWebsocketCapacity,
} from "./validate-production-evidence.mjs";

test("production API validator accepts exact full inventory and rejects response errors at 0.5%", () => {
  const report = apiReport();
  assert.doesNotThrow(() => validateProductionK6Api(report));
  const total = report.metrics.iterations.count;
  const errors = Math.ceil(total * 0.005);
  report.metrics.cpredict_response_errors = rate(errors, total - errors);
  report.metrics.checks = {
    passes: total - errors,
    fails: errors,
    value: (total - errors) / total,
  };
  assert.throws(
    () => validateProductionK6Api(report),
    /below 99.5%|below 0.5%/,
  );
});

test("production API validator rejects a dropped arrival even when latency is fast", () => {
  const report = apiReport();
  const completed = report.metrics.iterations.count - 1;
  report.metrics.iterations.count = completed;
  report.metrics.http_reqs.count = completed;
  report.metrics.cpredict_api_phase_iterations.count = completed;
  report.metrics.checks = { passes: completed, fails: 0, value: 1 };
  for (const name of [
    "cpredict_response_errors",
    "cpredict_server_errors",
    "cpredict_transport_errors",
  ]) {
    report.metrics[name] = rate(0, completed);
  }
  report.metrics.dropped_iterations = {
    count: 1,
    rate: 0,
    thresholds: { "count==0": true },
  };
  assert.throws(() => validateProductionK6Api(report), /dropped iterations/);
});

test("production API calibration validator preserves minimum 500/2000 RPS phase volumes", () => {
  const report = apiReport(15_000, 1_250, 60_000);
  assert.doesNotThrow(() => validateCalibrationK6Api(report));
  report.metrics["cpredict_api_phase_iterations{phase:burst}"].count -= 1;
  assert.throws(() => validateCalibrationK6Api(report), /burst iterations/);
});

test("production WebSocket validator requires all 10k samples and protocol readiness", () => {
  const report = websocketReport();
  assert.doesNotThrow(() => validateProductionK6Websocket(report));
  report.metrics.cpredict_ws_protocol_ready_failures = rate(50, 9_950);
  assert.throws(
    () => validateProductionK6Websocket(report),
    /protocol_ready.*below 0.5%/,
  );
});

test("production WebSocket capacity evidence proves an actual 10k simultaneous peak", () => {
  const baseline = websocketCapacity("before", 1, 0, 0, 1);
  const final = websocketCapacity("after", 10_001, 0, 0, 10_000);
  assert.doesNotThrow(() =>
    validateProductionWebsocketCapacity(baseline, final),
  );
  final.peakConnections = 9_999;
  assert.throws(
    () => validateProductionWebsocketCapacity(baseline, final),
    /simultaneous peak/,
  );
});

test("schema v3 manifest remains fail closed while running and accepts only all-zero completion", () => {
  const running = manifest("running", "not_run", "not_run", 1);
  assert.doesNotThrow(() => validateProductionManifest(running, false));
  assert.throws(
    () => validateProductionManifest(running, true),
    /completion status/,
  );
  const completed = manifest("completed", 0, 0, 0);
  assert.doesNotThrow(() => validateProductionManifest(completed, true));
  completed.api = 99;
  assert.throws(
    () => validateProductionManifest(completed, true),
    /derived overall/,
  );
  const aborted = manifest("aborted", 75, "not_run", 1);
  aborted.toolchain = 0;
  aborted.preflight = 75;
  assert.doesNotThrow(() => validateProductionManifest(aborted, false));
  aborted.runnerExit = 0;
  assert.throws(
    () => validateProductionManifest(aborted, false),
    /must be nonzero/,
  );
});

function apiReport(steady = 150_000, transition = 1_250, burst = 120_000) {
  const total = steady + transition + burst;
  const full = steady === 150_000;
  return {
    metrics: {
      iterations: { count: total, rate: 750 },
      http_reqs: { count: total, rate: 750 },
      checks: { passes: total, fails: 0, value: 1 },
      cpredict_api_phase_iterations: {
        count: total,
        rate: 1,
        thresholds: {
          [`count>=${full ? 271_250 : 76_250}`]: false,
          [`count<=${full ? 275_002 : 80_002}`]: false,
        },
      },
      http_req_duration: {
        "p(95)": 10,
        "p(99)": 20,
        thresholds: { "p(95)<300": false, "p(99)<750": false },
      },
      "cpredict_api_phase_iterations{phase:steady}": phaseCount(steady),
      "cpredict_api_phase_iterations{phase:transition}": phaseCount(transition),
      "cpredict_api_phase_iterations{phase:burst}": phaseCount(burst),
      "http_req_duration{phase:steady}": duration(10, 20),
      "http_req_duration{phase:transition}": duration(50, 100),
      "http_req_duration{phase:burst}": duration(100, 200),
      "cpredict_response_errors{phase:steady}": rate(0, steady),
      "cpredict_response_errors{phase:transition}": rate(0, transition),
      "cpredict_response_errors{phase:burst}": rate(0, burst),
      "cpredict_server_errors{phase:steady}": rate(0, steady),
      "cpredict_server_errors{phase:transition}": rate(0, transition),
      "cpredict_server_errors{phase:burst}": rate(0, burst),
      "cpredict_transport_errors{phase:steady}": rate(0, steady),
      "cpredict_transport_errors{phase:transition}": rate(0, transition),
      "cpredict_transport_errors{phase:burst}": rate(0, burst),
      dropped_iterations: {
        count: 0,
        rate: 0,
        thresholds: { "count==0": false },
      },
      cpredict_response_errors: rate(0, total),
      cpredict_server_errors: rate(0, total),
      cpredict_transport_errors: rate(0, total),
    },
  };
}

function phaseCount(required) {
  return {
    count: required,
    rate: 1,
    thresholds: {
      [`count>=${required.toString()}`]: false,
    },
  };
}

function duration(p95, p99) {
  return {
    "p(95)": p95,
    "p(99)": p99,
    thresholds: { "p(95)<300": false, "p(99)<750": false },
  };
}

function websocketReport() {
  return {
    metrics: {
      iterations: { count: 10_000, rate: 100 },
      checks: { passes: 20_000, fails: 0, value: 1 },
      ws_sessions: { count: 10_000, rate: 100 },
      ws_connecting: { "p(95)": 20, "p(99)": 40 },
      cpredict_ws_upgrade_failures: rate(0, 10_000),
      cpredict_ws_hold_failures: rate(0, 10_000),
      cpredict_ws_protocol_ready_failures: rate(0, 10_000),
    },
  };
}

function websocketCapacity(
  phase,
  acceptedTotal,
  rejectedTotal,
  currentConnections,
  peakConnections,
) {
  return {
    schemaVersion: 1,
    lane: "production-indexer-websocket-capacity-snapshot",
    runId: "validator-test",
    phase,
    observedAt: "2026-08-12T00:00:00.000Z",
    target: "http://127.0.0.1:18080",
    acceptedTotal,
    rejectedTotal,
    currentConnections,
    peakConnections,
    metricsSha256: "a".repeat(64),
  };
}

function rate(passes, fails) {
  return {
    passes,
    fails,
    value: passes / (passes + fails),
    thresholds: { "rate<0.005": passes / (passes + fails) >= 0.005 },
  };
}

function manifest(runStatus, runnerExit, stageValue, overall) {
  return Object.fromEntries([
    ["schemaVersion", 3],
    ["lane", "real-production-Fastify-PostgreSQL-plus-local-chain"],
    ["runId", "validator-test"],
    ["runStatus", runStatus],
    ["runnerExit", runnerExit],
    ...PRODUCTION_LOAD_STAGE_KEYS.map((key) => [key, stageValue]),
    ["overall", overall],
  ]);
}
