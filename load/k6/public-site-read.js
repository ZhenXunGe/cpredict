import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";

const target = __ENV.CPREDICT_CAPACITY_TARGET;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(target || ""))
  throw new Error("capacity target must be the owned loopback service");
const duration = Number(__ENV.CPREDICT_CAPACITY_SECONDS);
if (![30, 1800].includes(duration))
  throw new Error(
    "only the 30-second preparation and agreed 30-minute profile are supported",
  );
const reads = new Counter("cpredict_public_reads");
export const options = {
  scenarios: {
    public_readers: {
      executor: "constant-vus",
      vus: 50,
      duration: `${duration + 5}s`,
      gracefulStop: "10s",
    },
  },
  systemTags: [
    "status",
    "method",
    "name",
    "expected_response",
    "scenario",
    "check",
  ],
  summaryTrendStats: ["avg", "min", "med", "max", "p(95)", "p(99)"],
  thresholds: {
    http_req_duration: ["p(95)<=1000"],
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    cpredict_public_reads: [`count>=${duration * 10}`],
  },
};
export default function () {
  if (__ITER === 0) sleep((__VU - 1) / 10);
  const started = Date.now(),
    owner = `0x${(1000 + __VU - 1).toString(16).padStart(40, "0")}`;
  const binding = "environment=ctusd-test&deploymentId=deployment-test";
  const paths = [
    "/public/v2/markets",
    `/public/v2/activity/${owner}`,
    `/public/v2/pnl/${owner}`,
    "/public/v1/listings",
  ];
  const kind = (__VU + __ITER) % paths.length;
  const response = http.get(
    `${target}${paths[kind]}?${binding}${kind === 2 ? "" : "&limit=20"}`,
    {
      tags: { name: ["markets", "activity", "pnl", "listings"][kind] },
      timeout: "5s",
      redirects: 0,
    },
  );
  let data;
  try {
    data = response.json();
  } catch {
    data = null;
  }
  check(response, {
    "successful deployment-bound populated response": (r) =>
      r.status === 200 &&
      data !== null &&
      (kind === 2 ? data.pnl?.lots?.length === 100 : data.items?.length > 0) &&
      data.snapshot?.environment === "ctusd-test" &&
      data.snapshot?.deploymentId === "deployment-test",
  });
  reads.add(1);
  // Fifty independent readers each issue one request every five seconds: 10 queries/sec.
  sleep(Math.max(0, 5 - (Date.now() - started) / 1000));
}
