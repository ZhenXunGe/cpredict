import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateAderyn,
  validateEchidna,
  validateHalmos,
  validateK6Api,
  validateK6Websocket,
  validateLoadChain,
  validateLoadIndexer,
  validateLoadPreflight,
  validateLoadStageManifest,
  validateLoadStageManifestStructure,
  validateMedusa,
  validateSlither,
  validateSmt,
} from "./validate-gate-evidence.mjs";

test("retained parseable security evidence matches its exact inventories", async () => {
  validateAderyn(await json("reports/security/aderyn.json"));
  validateHalmos(
    await json("reports/security/halmos-protocol-math.json"),
    await readFile("reports/security/halmos-protocol-math.log", "utf8"),
  );
  validateMedusa(
    await readFile("reports/security/medusa-million.log", "utf8"),
    await readFile("reports/security/medusa-corpus/coverage/lcov.info", "utf8"),
  );
  validateSlither(await json("reports/slither-latest.json"));
});

test("retained Echidna failure and synthetic SMT violations remain failures", async () => {
  const echidnaLog = await readFile(
    "reports/security/echidna-retry.log",
    "utf8",
  );
  assert.throws(
    () => validateEchidna(echidnaLog),
    /crash marker|fewer than 1,000,000 calls/,
  );
  assert.throws(
    () => validateSmt("", "Warning: CHC: Assertion violation happens here."),
    /unavailable engine/,
  );
});

test("zero-result symbolic and fuzz summaries fail closed", async () => {
  const halmos = await json("reports/security/halmos-protocol-math.json");
  halmos.test_results["test/security/ProtocolMath.smt.sol:ProtocolMathSmt"] =
    [];
  assert.throws(
    () => validateHalmos(halmos, "Symbolic test result: 0 passed; 0 failed"),
    /inventory changed/,
  );

  const medusa = (
    await readFile("reports/security/medusa-million.log", "utf8")
  ).replace(
    "Test summary: 27 test(s) passed, 0 test(s) failed",
    "Test summary: 0 test(s) passed, 0 test(s) failed",
  );
  assert.throws(
    () =>
      validateMedusa(
        medusa,
        "TN:\nSF:src/example.sol\nDA:1,1\nend_of_record\n",
      ),
    /27 passed/,
  );
  assert.throws(() => validateSmt("", ""), /CHC assertion inventory changed/);
});

test("k6 summaries require explicit p99 and full WebSocket inventory", async () => {
  const api = {
    root_group: {
      checks: {
        "HTTP response is 2xx": {
          name: "HTTP response is 2xx",
          passes: 270_000,
          fails: 0,
        },
      },
    },
    metrics: {
      iterations: { count: 270_000 },
      http_reqs: { count: 270_000 },
      checks: { passes: 270_000, fails: 0 },
      http_req_duration: {
        "p(95)": 1,
        "p(99)": 2,
        thresholds: { "p(95)<300": false, "p(99)<750": false },
      },
      dropped_iterations: { count: 0, thresholds: { "count==0": false } },
      cpredict_server_errors: { value: 0, thresholds: { "rate<0.005": false } },
      cpredict_transport_errors: {
        value: 0,
        thresholds: { "rate<0.005": false },
      },
    },
  };
  validateK6Api(api);
  api.metrics.http_req_duration.thresholds["p(95)<300"] = true;
  assert.throws(() => validateK6Api(api), /failed condition/);
  api.metrics.http_req_duration.thresholds["p(95)<300"] = false;
  api.metrics.http_req_duration["p(95)"] = 300;
  assert.throws(() => validateK6Api(api), /below 300/);
  api.metrics.http_req_duration["p(95)"] = 1;
  delete api.metrics.http_req_duration["p(99)"];
  assert.throws(() => validateK6Api(api), /p99/);

  const historicalApi = await json(
    "reports/performance/full-20260808T013000Z-final/k6-api-summary.json",
  );
  assert.equal(
    historicalApi.metrics.http_req_duration.thresholds["p(95)<300"],
    false,
  );
  assert.equal(
    historicalApi.metrics.dropped_iterations.thresholds["count==0"],
    true,
  );
  assert.throws(() => validateK6Api(historicalApi));

  const websocket = {
    root_group: {
      checks: {
        "WebSocket upgrade is 101": {
          name: "WebSocket upgrade is 101",
          passes: 10_000,
          fails: 0,
        },
        "WebSocket connection held target duration": {
          name: "WebSocket connection held target duration",
          passes: 10_000,
          fails: 0,
        },
      },
    },
    metrics: {
      iterations: { count: 10_000 },
      checks: { passes: 20_000, fails: 0 },
      ws_connecting: { "p(95)": 1, "p(99)": 2 },
      cpredict_ws_upgrade_failures: {
        passes: 0,
        fails: 10_000,
        value: 0,
        thresholds: { "rate<0.005": false },
      },
      cpredict_ws_hold_failures: {
        passes: 0,
        fails: 10_000,
        value: 0,
        thresholds: { "rate<0.005": false },
      },
    },
  };
  validateK6Websocket(websocket);
  websocket.metrics.cpredict_ws_hold_failures.thresholds["rate<0.005"] = true;
  assert.throws(() => validateK6Websocket(websocket), /failed condition/);
  websocket.metrics.cpredict_ws_hold_failures.thresholds["rate<0.005"] = false;
  websocket.metrics.cpredict_ws_hold_failures.passes = 1;
  assert.throws(
    () => validateK6Websocket(websocket),
    /does not cover every session/,
  );
  websocket.metrics.cpredict_ws_hold_failures.passes = 0;
  websocket.metrics.iterations.count = 9_999;
  assert.throws(() => validateK6Websocket(websocket), /exactly 10,000/);

  const historicalWebsocket = await json(
    "reports/performance/full-20260808T013000Z-final/k6-websocket-summary.json",
  );
  assert.throws(
    () => validateK6Websocket(historicalWebsocket),
    /cpredict_ws_hold_failures/,
  );
});

test("retained passing load lanes match their exact inventories", async () => {
  validateLoadPreflight(
    await json(
      "reports/performance/full-20260808T013000Z-final/preflight.json",
    ),
  );
  validateLoadIndexer(
    await json("reports/performance/full-20260808T013000Z-final/indexer.json"),
  );
  validateLoadChain(
    await json("reports/performance/full-20260808T013000Z-final/chain.json"),
  );

  const preflight = await json(
    "reports/performance/full-20260808T013000Z-final/preflight.json",
  );
  preflight.fullProfileReadiness.cpuCapacityAvailable = false;
  assert.throws(() => validateLoadPreflight(preflight), /failed readiness/);

  const chain = await json(
    "reports/performance/full-20260808T013000Z-final/chain.json",
  );
  chain.classifications.planned -= 1;
  assert.throws(() => validateLoadChain(chain), /planned transaction count/);
});

test("load stage manifest schema 2 fails closed across completed and aborted runs", async () => {
  const passing = passingLoadStageManifest();
  validateLoadStageManifestStructure(passing);
  validateLoadStageManifest(passing);

  const completedFailure = {
    ...passing,
    runnerExit: 1,
    websocket: 99,
    websocketEvidence: 1,
    overall: 1,
  };
  validateLoadStageManifestStructure(completedFailure);
  assert.throws(
    () => validateLoadStageManifest(completedFailure),
    /nonzero stage result/,
  );

  const inconsistentOverall = { ...passing, api: 99 };
  assert.throws(
    () => validateLoadStageManifest(inconsistentOverall),
    /overall does not match/,
  );

  const incompleteCompleted = { ...passing, chain: "not_run" };
  assert.throws(
    () => validateLoadStageManifest(incompleteCompleted),
    /cannot contain not_run/,
  );

  const aborted = {
    ...passing,
    runStatus: "aborted",
    runnerExit: 75,
    preflight: 75,
    preflightEvidence: 1,
    harnessReadiness: "not_run",
    api: "not_run",
    apiLog: "not_run",
    apiEvidence: "not_run",
    websocket: "not_run",
    websocketLog: "not_run",
    websocketEvidence: "not_run",
    typescript: "not_run",
    indexer: "not_run",
    indexerEvidence: "not_run",
    anvilReadiness: "not_run",
    chain: "not_run",
    chainEvidence: "not_run",
    manifestEvidence: "not_run",
    overall: 1,
  };
  validateLoadStageManifestStructure(aborted);
  assert.throws(() => validateLoadStageManifest(aborted), /not completed/);

  const historical = await json(
    "reports/performance/full-20260808T013000Z-final/stage-exit-codes.json",
  );
  assert.throws(
    () => validateLoadStageManifest(historical),
    /inventory changed/,
  );
});

test("unexpected Slither High or Medium findings fail the reviewed baseline", async () => {
  const report = await json("reports/slither-latest.json");
  report.results.detectors.push({
    impact: "High",
    check: "new-high",
    elements: [
      {
        type: "function",
        name: "danger",
        source_mapping: { filename_relative: "src/core/ProtocolConfigV1.sol" },
      },
    ],
  });
  assert.throws(() => validateSlither(report), /reviewed baseline/);
});

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function passingLoadStageManifest() {
  return {
    schemaVersion: 2,
    runId: "unit-pass",
    runStatus: "completed",
    runnerExit: 0,
    toolchain: 0,
    preflight: 0,
    preflightEvidence: 0,
    harnessReadiness: 0,
    api: 0,
    apiLog: 0,
    apiEvidence: 0,
    websocket: 0,
    websocketLog: 0,
    websocketEvidence: 0,
    typescript: 0,
    indexer: 0,
    indexerEvidence: 0,
    anvilReadiness: 0,
    chain: 0,
    chainEvidence: 0,
    manifestEvidence: 0,
    overall: 0,
  };
}
