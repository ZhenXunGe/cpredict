#!/usr/bin/env bash
set -euo pipefail

if [[ "${CPREDICT_LOAD_CONFIRM:-}" != "I_UNDERSTAND_RESOURCE_USAGE" ]]; then
  printf '%s\n' 'Refusing commercial SUT observation: set CPREDICT_LOAD_CONFIRM=I_UNDERSTAND_RESOURCE_USAGE' >&2
  exit 64
fi
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"
RUN_ID="${RUN_ID:?RUN_ID is required and must match the load and chain roles}"
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { printf '%s\n' 'invalid RUN_ID' >&2; exit 64; }
: "${CPREDICT_HOST_IDENTITY:?CPREDICT_HOST_IDENTITY is required}"
: "${CPREDICT_HOST_IDENTITY_SOURCE:?CPREDICT_HOST_IDENTITY_SOURCE is required}"
: "${CPREDICT_HOST_IDENTITY_EVIDENCE_PATH:?CPREDICT_HOST_IDENTITY_EVIDENCE_PATH is required}"
export CPREDICT_ROLE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
: "${SUT_BASE_URL:?SUT_BASE_URL is required}"
: "${SUT_WS_URL:?SUT_WS_URL is required for cross-role topology binding}"
export SUT_BASE_URL SUT_WS_URL
: "${SUT_START_COMMAND:?SUT_START_COMMAND must start API, Indexer, and PostgreSQL topology}"
: "${SUT_DATABASE_URL:?SUT_DATABASE_URL is required for PostgreSQL SQL telemetry}"
: "${CHAIN_RPC_URL:?CHAIN_RPC_URL is required for Indexer lag telemetry}"
OBSERVE_SECONDS="${SUT_OBSERVE_SECONDS:-900}"
[[ "$OBSERVE_SECONDS" =~ ^[0-9]+$ ]] && (( OBSERVE_SECONDS >= 600 && OBSERVE_SECONDS <= 7200 )) || {
  printf '%s\n' 'SUT_OBSERVE_SECONDS must be within [600, 7200]' >&2; exit 64;
}
node load/distributed/preflight-role-evidence.mjs sut
REPORT_DIR="${REPORT_DIR:-$PROJECT_ROOT/reports/performance/distributed-sut-$RUN_ID}"
mkdir -p "$(dirname "$REPORT_DIR")"
mkdir "$REPORT_DIR" || { printf '%s\n' "refusing existing report directory: $REPORT_DIR" >&2; exit 73; }
START_RC="not_run"
READINESS_RC="not_run"
TELEMETRY_RC="not_run"
TELEMETRY_EVIDENCE_RC="not_run"
RUN_STATUS=aborted
SUT_PID=""
TELEMETRY_PID=""

write_stages() {
  node -e '
    const fs = require("node:fs");
    const values = process.argv.slice(2).map((value) => /^\d+$/.test(value) ? Number(value) : value);
    fs.writeFileSync(process.argv[1], JSON.stringify({
      topologyStart: values[0], readiness: values[1], telemetry: values[2], telemetryEvidence: values[3],
    }, null, 2) + "\n");
  ' "$REPORT_DIR/stage-exit-codes.json" "$START_RC" "$READINESS_RC" "$TELEMETRY_RC" "$TELEMETRY_EVIDENCE_RC"
}

finalize() {
  local original_rc=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$TELEMETRY_PID" ]] && kill -0 "$TELEMETRY_PID" 2>/dev/null; then kill -TERM "$TELEMETRY_PID"; fi
  if [[ -n "$SUT_PID" ]] && kill -0 "$SUT_PID" 2>/dev/null; then kill -TERM "$SUT_PID"; fi
  if [[ -n "$TELEMETRY_PID" ]]; then wait "$TELEMETRY_PID"; TELEMETRY_RC=$?; fi
  if [[ -n "$SUT_PID" ]]; then wait "$SUT_PID" 2>/dev/null; fi
  set -e
  if [[ -f "$REPORT_DIR/telemetry-summary.json" ]]; then
    set +e
    node load/distributed/commercial-evidence.mjs validate-telemetry \
      "$REPORT_DIR/telemetry-summary.json" "$REPORT_DIR/telemetry-raw.json" \
      >>"$REPORT_DIR/telemetry.log" 2>&1
    TELEMETRY_EVIDENCE_RC=$?
    set -e
  fi
  write_stages
  if [[ "$original_rc" -eq 0 && "$START_RC" -eq 0 && "$READINESS_RC" -eq 0 && "$TELEMETRY_RC" -eq 0 && "$TELEMETRY_EVIDENCE_RC" -eq 0 ]]; then
    RUN_STATUS=completed
  else
    original_rc=1
  fi
  node load/distributed/write-role-evidence.mjs sut "$REPORT_DIR" "$RUN_ID" "$RUN_STATUS" || original_rc=1
  exit "$original_rc"
}
trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
write_stages

bash -lc "$SUT_START_COMMAND" >"$REPORT_DIR/sut-service.log" 2>&1 &
SUT_PID=$!
START_RC=0
READINESS_RC=75
for _ in {1..120}; do
  if ! kill -0 "$SUT_PID" 2>/dev/null; then READINESS_RC=70; break; fi
  if [[ "$(curl -fsS --max-time 2 "$SUT_BASE_URL/readyz" 2>/dev/null)" == '{"status":"ready"}' ]]; then
    READINESS_RC=0
    break
  fi
  sleep 0.5
done
write_stages
[[ "$READINESS_RC" -eq 0 ]] || exit "$READINESS_RC"

RUN_ID="$RUN_ID" SUT_BASE_URL="$SUT_BASE_URL" SUT_DATABASE_URL="$SUT_DATABASE_URL" CHAIN_RPC_URL="$CHAIN_RPC_URL" \
SUT_OBSERVE_SECONDS="$OBSERVE_SECONDS" TELEMETRY_REPORT_PATH="$REPORT_DIR/telemetry-summary.json" \
TELEMETRY_RAW_PATH="$REPORT_DIR/telemetry-raw.json" \
node load/distributed/collect-telemetry.mjs >"$REPORT_DIR/telemetry.log" 2>&1 &
TELEMETRY_PID=$!
set +e
wait "$TELEMETRY_PID"
TELEMETRY_RC=$?
set -e
TELEMETRY_PID=""
[[ "$TELEMETRY_RC" -eq 0 ]] || exit "$TELEMETRY_RC"
node load/distributed/commercial-evidence.mjs validate-telemetry \
  "$REPORT_DIR/telemetry-summary.json" "$REPORT_DIR/telemetry-raw.json" \
  >>"$REPORT_DIR/telemetry.log" 2>&1
TELEMETRY_EVIDENCE_RC=$?
write_stages
RUN_STATUS=completed
