import ws from "k6/ws";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

const profile = __ENV.LOAD_PROFILE || "smoke";
const smokeSessions = Number(__ENV.WS_CONNECTIONS || 50);
const smokeHold = Number(__ENV.WS_HOLD_SECONDS || 10);
const acknowledged =
  __ENV.CPREDICT_LOAD_CONFIRM === "I_UNDERSTAND_RESOURCE_USAGE";
if (profile === "full" && !acknowledged)
  throw new Error("full profile requires acknowledgement");
if (
  profile !== "full" &&
  (smokeSessions > 500 || smokeHold > 30) &&
  !acknowledged
) {
  throw new Error(
    "larger connection calibration requires explicit resource acknowledgement",
  );
}
const target = __ENV.WS_TARGET || "ws://127.0.0.1:18080/v1/stream";
const upgradeFailures = new Rate("cpredict_ws_upgrade_failures");
const holdFailures = new Rate("cpredict_ws_hold_failures");
const protocolReadyFailures = new Rate("cpredict_ws_protocol_ready_failures");
const sessions = profile === "full" ? 10_000 : smokeSessions;
const hold = profile === "full" ? 60 : smokeHold;

export const options = {
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
  scenarios: {
    read_connections: {
      executor: "per-vu-iterations",
      vus: sessions,
      iterations: 1,
      maxDuration: `${hold + 45}s`,
    },
  },
  thresholds: {
    cpredict_ws_upgrade_failures: ["rate<0.005"],
    cpredict_ws_hold_failures: ["rate<0.005"],
    cpredict_ws_protocol_ready_failures: ["rate<0.005"],
  },
};

export default function () {
  let opened = false;
  let openedAt = 0;
  let protocolReady = false;
  if (profile === "full") sleep(((__VU - 1) / sessions) * 20);
  const marketId = ((__VU - 1) % 100) + 1;
  const response = ws.connect(
    `${target}?chainId=31337&market=${address(marketId)}`,
    { tags: { endpoint: "indexer-stream" } },
    (socket) => {
      socket.on("open", () => {
        opened = true;
        openedAt = Date.now();
        socket.setTimeout(() => socket.close(), hold * 1_000);
      });
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(data);
          if (
            message.type === "ready" &&
            message.chainId === 31337 &&
            message.protocolVersion === 1
          ) {
            protocolReady = true;
          }
        } catch {
          // A malformed application message leaves protocolReady false and fails closed.
        }
      });
    },
  );
  const accepted = check(response, {
    "WebSocket upgrade is 101": (result) => result?.status === 101,
  });
  const heldForTarget =
    accepted &&
    opened &&
    protocolReady &&
    Date.now() - openedAt >= hold * 1_000;
  check(
    { heldForTarget },
    {
      "WebSocket connection held target duration": (result) =>
        result.heldForTarget,
    },
  );
  upgradeFailures.add(!accepted || !opened);
  holdFailures.add(!heldForTarget);
  protocolReadyFailures.add(!protocolReady);
}

function address(value) {
  return `0x${String(value).padStart(40, "0")}`;
}
