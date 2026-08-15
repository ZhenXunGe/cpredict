import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";
import { Counter, Rate } from "k6/metrics";

const profile = __ENV.LOAD_PROFILE || "smoke";
const smokeRate = Number(__ENV.HTTP_RPS || 50);
const smokeDuration = Number(__ENV.HTTP_DURATION || 10);
const smokePreAllocatedVUs = Math.max(10, Math.ceil(smokeRate / 5));
const smokeMaxVUs = Math.max(100, smokePreAllocatedVUs * 10);
const acknowledged =
  __ENV.CPREDICT_LOAD_CONFIRM === "I_UNDERSTAND_RESOURCE_USAGE";
if (profile === "full" && !acknowledged)
  throw new Error("full profile requires acknowledgement");
if (profile === "calibration" && !acknowledged)
  throw new Error("calibration profile requires acknowledgement");
if (!["smoke", "calibration", "full"].includes(profile))
  throw new Error("unsupported load profile");
if (
  profile !== "full" &&
  (smokeRate > 100 || smokeDuration > 30) &&
  !acknowledged
) {
  throw new Error(
    "larger smoke calibration requires explicit resource acknowledgement",
  );
}
const target = __ENV.TARGET_URL || "http://127.0.0.1:18080";
const transportErrors = new Rate("cpredict_transport_errors");
const serverErrors = new Rate("cpredict_server_errors");
const responseErrors = new Rate("cpredict_response_errors");
const phaseIterations = new Counter("cpredict_api_phase_iterations");
const isPhasedProfile = profile === "full" || profile === "calibration";
// k6's ramping executor schedules on discrete time buckets, so a duration that is mathematically
// exact can finish a few iterations below the requested integral without recording a drop. Each
// measured stage therefore runs one second longer (and the ramp runs for two seconds), while the
// minimum gate remains the original 500 RPS x 5m / 2,000 RPS x 1m workload. The upper bound locks
// the deliberately increased profile and prevents an accidental unbounded run.
const steadyDuration = profile === "full" ? "5m1s" : "31s";
const steadyDurationMs = profile === "full" ? 301_000 : 31_000;
const transitionDuration = "2s";
const transitionDurationMs = 2_000;
const requiredSteady = profile === "full" ? 150_000 : 15_000;
const maximumSteady = profile === "full" ? 150_500 : 15_500;
const requiredTransition = 1_250;
const maximumTransition = 2_500;
const requiredBurst = profile === "full" ? 120_000 : 60_000;
const maximumBurst = profile === "full" ? 122_000 : 62_000;
const requiredTotal = requiredSteady + requiredTransition + requiredBurst;
const maximumTotal = maximumSteady + maximumTransition + maximumBurst;

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  // Dynamic market/listing IDs must never become metric dimensions. The endpoint and name tags
  // retain useful cardinality while preventing the load generator itself from exhausting memory.
  systemTags: [
    "status",
    "method",
    "name",
    "expected_response",
    "scenario",
    "check",
  ],
  scenarios: isPhasedProfile
    ? {
        api_capacity: {
          executor: "ramping-arrival-rate",
          startRate: 500,
          timeUnit: "1s",
          preAllocatedVUs: 2_500,
          maxVUs: 7_000,
          stages: [
            { target: 500, duration: steadyDuration },
            { target: 2_000, duration: transitionDuration },
            { target: 2_000, duration: profile === "full" ? "1m1s" : "31s" },
          ],
        },
      }
    : {
        safe_smoke: {
          executor: "constant-arrival-rate",
          rate: smokeRate,
          timeUnit: "1s",
          duration: `${smokeDuration}s`,
          preAllocatedVUs: smokePreAllocatedVUs,
          maxVUs: smokeMaxVUs,
        },
      },
  thresholds: {
    http_req_duration: ["p(95)<300", "p(99)<750"],
    cpredict_server_errors: ["rate<0.005"],
    cpredict_response_errors: ["rate<0.005"],
    cpredict_transport_errors: ["rate<0.005"],
    dropped_iterations: ["count==0"],
    ...(isPhasedProfile
      ? {
          cpredict_api_phase_iterations: [
            `count>=${requiredTotal}`,
            `count<=${maximumTotal + 2}`,
          ],
          "cpredict_api_phase_iterations{phase:steady}":
            phaseCountThresholds(requiredSteady),
          "cpredict_api_phase_iterations{phase:transition}":
            phaseCountThresholds(requiredTransition),
          "cpredict_api_phase_iterations{phase:burst}":
            phaseCountThresholds(requiredBurst),
          ...phaseThresholds("steady"),
          ...phaseThresholds("transition"),
          ...phaseThresholds("burst"),
        }
      : {}),
  },
};

export default function () {
  const phase = isPhasedProfile
    ? phaseForElapsed(
        Date.now() - Number(exec.scenario.startTime),
        steadyDurationMs,
        transitionDurationMs,
      )
    : "smoke";
  const iteration = Number(exec.scenario.iterationInTest);
  const marketId = ((iteration * 31) % 100) + 1;
  const offset = (iteration * 17) % 980;
  const selector = iteration % 20;
  const path =
    selector === 0
      ? `/v1/markets?chainId=31337&cursor=${(iteration * 7) % 80}&limit=20`
      : selector % 4 === 0
        ? `/v1/markets/${address(marketId)}?chainId=31337`
        : `/v1/listings?chainId=31337&vault=${address(marketId)}&active=true&cursor=${offset}&limit=20`;
  const endpoint = endpointTag(path);
  const response = http.get(`${target}${path}`, {
    tags: { endpoint, name: `GET ${endpoint}`, phase },
  });
  phaseIterations.add(1, { phase });
  transportErrors.add(Boolean(response.error), { phase });
  serverErrors.add(response.status >= 500, { phase });
  const successful = response.status >= 200 && response.status < 300;
  responseErrors.add(!successful, { phase });
  check(response, { "HTTP response is 2xx": () => successful });
}

function phaseThresholds(phase) {
  return {
    [`http_req_duration{phase:${phase}}`]: ["p(95)<300", "p(99)<750"],
    [`cpredict_response_errors{phase:${phase}}`]: ["rate<0.005"],
    [`cpredict_server_errors{phase:${phase}}`]: ["rate<0.005"],
    [`cpredict_transport_errors{phase:${phase}}`]: ["rate<0.005"],
  };
}

function phaseCountThresholds(required) {
  return [`count>=${required}`];
}

function phaseForElapsed(elapsedMs, steadyMs, transitionMs) {
  if (elapsedMs < steadyMs) return "steady";
  if (elapsedMs < steadyMs + transitionMs) return "transition";
  return "burst";
}

function endpointTag(path) {
  if (path.startsWith("/v1/markets?")) return "markets-page";
  if (path.startsWith("/v1/markets/")) return "market-detail";
  return "listings";
}

function address(value) {
  return `0x${String(value).padStart(40, "0")}`;
}
