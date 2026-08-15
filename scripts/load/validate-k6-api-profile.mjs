import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function validateK6ApiProfileInspection(report, profile) {
  assert(
    report !== null && typeof report === "object",
    "k6 inspection must be an object",
  );
  assert(
    profile === "full" || profile === "calibration",
    "profile must be full or calibration",
  );
  const expected =
    profile === "full"
      ? {
          steadyDuration: "5m1s",
          steady: 150_000,
          totalMin: 271_250,
          totalMax: 275_000,
          burstDuration: "1m1s",
          burst: 120_000,
        }
      : {
          steadyDuration: "31s",
          steady: 15_000,
          totalMin: 76_250,
          totalMax: 80_000,
          burstDuration: "31s",
          burst: 60_000,
        };
  const scenarioNames = Object.keys(report.scenarios ?? {});
  equal(scenarioNames, ["api_capacity"], "single persistent API scenario");
  const scenario = report.scenarios.api_capacity;
  equal(scenario.executor, "ramping-arrival-rate", "API scenario executor");
  equal(scenario.startRate, 500, "API scenario start rate");
  equal(scenario.timeUnit, "1s", "API scenario time unit");
  equal(scenario.preAllocatedVUs, 2_500, "API preallocated VUs");
  equal(scenario.maxVUs, 7_000, "API maximum VUs");
  equal(
    scenario.stages,
    [
      { duration: expected.steadyDuration, target: 500 },
      { duration: "2s", target: 2_000 },
      { duration: expected.burstDuration, target: 2_000 },
    ],
    "API rate stages",
  );
  assert(
    report.noConnectionReuse === null || report.noConnectionReuse === false,
    "HTTP connection reuse is disabled",
  );
  assert(
    report.noVUConnectionReuse === null || report.noVUConnectionReuse === false,
    "per-VU connection reuse is disabled",
  );

  const thresholds = report.thresholds ?? {};
  equal(thresholds.dropped_iterations, ["count==0"], "zero-drop threshold");
  equal(
    thresholds.http_req_duration,
    ["p(95)<300", "p(99)<750"],
    "aggregate duration thresholds",
  );
  equal(
    thresholds.cpredict_api_phase_iterations,
    [`count>=${expected.totalMin}`, `count<=${expected.totalMax + 2}`],
    "aggregate planned arrival bounds",
  );
  for (const [phase, required] of [
    ["steady", expected.steady],
    ["transition", 1_250],
    ["burst", expected.burst],
  ]) {
    equal(
      thresholds[`cpredict_api_phase_iterations{phase:${phase}}`],
      [`count>=${required.toString()}`],
      `${phase} planned arrival bounds`,
    );
    equal(
      thresholds[`http_req_duration{phase:${phase}}`],
      ["p(95)<300", "p(99)<750"],
      `${phase} duration thresholds`,
    );
    for (const metric of [
      "cpredict_response_errors",
      "cpredict_server_errors",
      "cpredict_transport_errors",
    ]) {
      equal(
        thresholds[`${metric}{phase:${phase}}`],
        ["rate<0.005"],
        `${phase} ${metric} threshold`,
      );
    }
  }
}

function equal(actual, expected, label) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} differs from the locked profile`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main([profile, path]) {
  if (path === undefined)
    throw new Error(
      "usage: validate-k6-api-profile.mjs <full|calibration> <inspect.json>",
    );
  const report = JSON.parse(await readFile(path, "utf8"));
  validateK6ApiProfileInspection(report, profile);
  process.stdout.write(`validated k6 API ${profile} persistent-VU profile\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `k6 API profile validation failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
