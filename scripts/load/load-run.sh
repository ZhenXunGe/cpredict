#!/usr/bin/env bash
set -euo pipefail

if [[ "${CPREDICT_LOAD_CONFIRM:-}" != "I_UNDERSTAND_RESOURCE_USAGE" ]]; then
  printf '%s\n' 'Refusing commercial load: set CPREDICT_LOAD_CONFIRM=I_UNDERSTAND_RESOURCE_USAGE' >&2
  exit 64
fi
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"
RUN_ID="${RUN_ID:?RUN_ID is required and must match the SUT and chain roles}"
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { printf '%s\n' 'invalid RUN_ID' >&2; exit 64; }
: "${CPREDICT_HOST_IDENTITY:?CPREDICT_HOST_IDENTITY is required}"
: "${CPREDICT_HOST_IDENTITY_SOURCE:?CPREDICT_HOST_IDENTITY_SOURCE is required}"
: "${CPREDICT_HOST_IDENTITY_EVIDENCE_PATH:?CPREDICT_HOST_IDENTITY_EVIDENCE_PATH is required}"
export CPREDICT_ROLE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SUT_BASE_URL="${SUT_BASE_URL:?SUT_BASE_URL is required}"
SUT_WS_URL="${SUT_WS_URL:?SUT_WS_URL is required}"
export SUT_BASE_URL SUT_WS_URL
node -e '
  const api = new URL(process.argv[1]);
  const websocket = new URL(process.argv[2]);
  for (const [url, protocol, label] of [[api, "https:", "API"], [websocket, "wss:", "WebSocket"]]) {
    if (["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"].includes(url.hostname)) throw new Error(`${label} target must be non-loopback`);
    if (url.protocol !== protocol) throw new Error(`${label} target must use ${protocol}`);
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error(`${label} target must not contain credentials, query, or hash`);
  }
  if (api.pathname !== "/") throw new Error("API target must be a normalized root origin");
  if (websocket.pathname !== "/v1/stream") throw new Error("WebSocket target must be exactly /v1/stream");
  if (api.host !== websocket.host) throw new Error("API and WebSocket targets must identify the same host and port");
' "$SUT_BASE_URL" "$SUT_WS_URL"
node load/distributed/preflight-role-evidence.mjs load

REPORT_DIR="${REPORT_DIR:-$PROJECT_ROOT/reports/performance/distributed-load-$RUN_ID}"
mkdir -p "$(dirname "$REPORT_DIR")"
mkdir "$REPORT_DIR" || { printf '%s\n' "refusing existing report directory: $REPORT_DIR" >&2; exit 73; }
K6_BIN="${K6_BIN:-$PROJECT_ROOT/.tools/k6/k6}"
VALIDATOR="$PROJECT_ROOT/scripts/load/validate-production-evidence.mjs"
[[ -x "$K6_BIN" ]] || { printf '%s\n' 'k6 executable is missing' >&2; exit 69; }

API_RC="not_run"
API_EVIDENCE_RC="not_run"
WS_BEFORE_RC="not_run"
WS_RC="not_run"
WS_AFTER_RC="not_run"
WS_EVIDENCE_RC="not_run"
WS_CAPACITY_RC="not_run"
RUN_STATUS=aborted

write_stages() {
  node -e '
    const fs = require("node:fs");
    const values = process.argv.slice(2).map((value) => /^\d+$/.test(value) ? Number(value) : value);
    fs.writeFileSync(process.argv[1], JSON.stringify({
      api: values[0], apiEvidence: values[1], websocketBaseline: values[2],
      websocket: values[3], websocketFinal: values[4], websocketEvidence: values[5],
      websocketCapacityEvidence: values[6],
    }, null, 2) + "\n");
  ' "$REPORT_DIR/stage-exit-codes.json" "$API_RC" "$API_EVIDENCE_RC" "$WS_BEFORE_RC" \
    "$WS_RC" "$WS_AFTER_RC" "$WS_EVIDENCE_RC" "$WS_CAPACITY_RC"
}

finalize() {
  local original_rc=$?
  trap - EXIT INT TERM
  write_stages
  if [[ "$original_rc" -eq 0 ]]; then RUN_STATUS=completed; fi
  node load/distributed/write-role-evidence.mjs load "$REPORT_DIR" "$RUN_ID" "$RUN_STATUS" || original_rc=1
  exit "$original_rc"
}
trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
write_stages

# WebSocket capacity is first so a fresh SUT process can prove baseline peak=0 before the chain
# observer opens its event stream. Start the chain role only after this block completes; the
# following 360-second API phase still provides the required >=300-second three-role overlap.
set +e
RUN_ID="$RUN_ID" TARGET_URL="$SUT_BASE_URL" SNAPSHOT_PHASE=before \
REPORT_PATH="$REPORT_DIR/websocket-capacity-before.json" \
node load/production/capture-websocket-metrics.mjs >"$REPORT_DIR/websocket-capacity-before.log" 2>&1
WS_BEFORE_RC=$?
set -e
write_stages
[[ "$WS_BEFORE_RC" -eq 0 ]] || exit 1

set +e
"$K6_BIN" run --summary-export "$REPORT_DIR/k6-websocket-summary.json" \
  -e LOAD_PROFILE=full -e CPREDICT_LOAD_CONFIRM="$CPREDICT_LOAD_CONFIRM" \
  -e WS_TARGET="$SUT_WS_URL" load/k6/read-connections.js >"$REPORT_DIR/k6-websocket.log" 2>&1
WS_RC=$?
RUN_ID="$RUN_ID" TARGET_URL="$SUT_BASE_URL" SNAPSHOT_PHASE=after \
REPORT_PATH="$REPORT_DIR/websocket-capacity-after.json" \
node load/production/capture-websocket-metrics.mjs >"$REPORT_DIR/websocket-capacity-after.log" 2>&1
WS_AFTER_RC=$?
node "$VALIDATOR" k6-websocket "$REPORT_DIR/k6-websocket-summary.json" >>"$REPORT_DIR/k6-websocket.log" 2>&1
WS_EVIDENCE_RC=$?
node load/distributed/commercial-evidence.mjs validate-websocket-capacity \
  "$REPORT_DIR/websocket-capacity-before.json" "$REPORT_DIR/websocket-capacity-after.json" \
  >>"$REPORT_DIR/k6-websocket.log" 2>&1
WS_CAPACITY_RC=$?
set -e
write_stages
[[ "$WS_RC" -eq 0 && "$WS_AFTER_RC" -eq 0 && "$WS_EVIDENCE_RC" -eq 0 && "$WS_CAPACITY_RC" -eq 0 ]] || exit 1

set +e
"$K6_BIN" run --summary-export "$REPORT_DIR/k6-api-summary.json" \
  -e LOAD_PROFILE=full -e CPREDICT_LOAD_CONFIRM="$CPREDICT_LOAD_CONFIRM" \
  -e TARGET_URL="$SUT_BASE_URL" load/k6/api-read.js >"$REPORT_DIR/k6-api.log" 2>&1
API_RC=$?
node "$VALIDATOR" k6-api "$REPORT_DIR/k6-api-summary.json" >>"$REPORT_DIR/k6-api.log" 2>&1
API_EVIDENCE_RC=$?
set -e
write_stages
[[ "$API_RC" -eq 0 && "$API_EVIDENCE_RC" -eq 0 ]] || exit 1

RUN_STATUS=completed
