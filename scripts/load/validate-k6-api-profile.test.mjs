import assert from "node:assert/strict";
import test from "node:test";
import { validateK6ApiProfileInspection } from "./validate-k6-api-profile.mjs";

test("accepts the single persistent full API VU pool and all three phase gates", () => {
  assert.doesNotThrow(() =>
    validateK6ApiProfileInspection(inspection("full"), "full"),
  );
});

test("accepts the short calibration with the same persistent-pool shape", () => {
  assert.doesNotThrow(() =>
    validateK6ApiProfileInspection(inspection("calibration"), "calibration"),
  );
});

test("rejects a second cold scenario or a missing phase threshold", () => {
  const duplicate = inspection("full");
  duplicate.scenarios.cold_burst = structuredClone(
    duplicate.scenarios.api_capacity,
  );
  assert.throws(
    () => validateK6ApiProfileInspection(duplicate, "full"),
    /single persistent/,
  );

  const missing = inspection("full");
  delete missing.thresholds["http_req_duration{phase:transition}"];
  assert.throws(
    () => validateK6ApiProfileInspection(missing, "full"),
    /transition duration/,
  );
});

test("rejects reduced VU capacity and relaxed arrival bounds", () => {
  const reduced = inspection("full");
  reduced.scenarios.api_capacity.maxVUs = 5_000;
  assert.throws(
    () => validateK6ApiProfileInspection(reduced, "full"),
    /maximum VUs/,
  );

  const relaxed = inspection("full");
  relaxed.thresholds["cpredict_api_phase_iterations{phase:burst}"] = [
    "count>=119000",
  ];
  assert.throws(
    () => validateK6ApiProfileInspection(relaxed, "full"),
    /burst planned/,
  );
});

function inspection(profile) {
  const full = profile === "full";
  const steady = full ? 150_000 : 15_000;
  const burst = full ? 120_000 : 60_000;
  const totalMin = full ? 271_250 : 76_250;
  const totalMax = full ? 275_000 : 80_000;
  const thresholds = {
    dropped_iterations: ["count==0"],
    http_req_duration: ["p(95)<300", "p(99)<750"],
    cpredict_api_phase_iterations: [
      `count>=${totalMin}`,
      `count<=${totalMax + 2}`,
    ],
  };
  for (const [phase, required] of [
    ["steady", steady],
    ["transition", 1_250],
    ["burst", burst],
  ]) {
    thresholds[`cpredict_api_phase_iterations{phase:${phase}}`] = [
      `count>=${required}`,
    ];
    thresholds[`http_req_duration{phase:${phase}}`] = [
      "p(95)<300",
      "p(99)<750",
    ];
    for (const metric of [
      "cpredict_response_errors",
      "cpredict_server_errors",
      "cpredict_transport_errors",
    ]) {
      thresholds[`${metric}{phase:${phase}}`] = ["rate<0.005"];
    }
  }
  return {
    scenarios: {
      api_capacity: {
        executor: "ramping-arrival-rate",
        startRate: 500,
        timeUnit: "1s",
        preAllocatedVUs: 2_500,
        maxVUs: 7_000,
        stages: [
          { duration: full ? "5m1s" : "31s", target: 500 },
          { duration: "2s", target: 2_000 },
          { duration: full ? "1m1s" : "31s", target: 2_000 },
        ],
      },
    },
    thresholds,
    noConnectionReuse: null,
    noVUConnectionReuse: null,
  };
}
