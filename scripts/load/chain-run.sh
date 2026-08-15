#!/usr/bin/env bash
set -euo pipefail

if [[ "${CPREDICT_LOAD_CONFIRM:-}" != "I_UNDERSTAND_RESOURCE_USAGE" ]]; then
  printf '%s\n' 'Refusing commercial chain load: set CPREDICT_LOAD_CONFIRM=I_UNDERSTAND_RESOURCE_USAGE' >&2
  exit 64
fi
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"
RUN_ID="${RUN_ID:?RUN_ID is required and must match the SUT and load roles}"
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { printf '%s\n' 'invalid RUN_ID' >&2; exit 64; }
: "${CPREDICT_HOST_IDENTITY:?CPREDICT_HOST_IDENTITY is required}"
: "${CPREDICT_HOST_IDENTITY_SOURCE:?CPREDICT_HOST_IDENTITY_SOURCE is required}"
: "${CPREDICT_HOST_IDENTITY_EVIDENCE_PATH:?CPREDICT_HOST_IDENTITY_EVIDENCE_PATH is required}"
export CPREDICT_ROLE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
: "${SUT_BASE_URL:?SUT_BASE_URL is required for event delivery evidence}"
: "${SUT_WS_URL:?SUT_WS_URL is required for event delivery evidence}"
: "${CHAIN_RPC_URL:?CHAIN_RPC_URL must be the non-loopback TLS origin shared with the SUT}"
CHAIN_LOCAL_RPC_URL="${CHAIN_LOCAL_RPC_URL:-http://127.0.0.1:18545}"
export SUT_BASE_URL SUT_WS_URL CHAIN_RPC_URL CHAIN_LOCAL_RPC_URL
node -e '
  for (const [value, protocol, label] of [
    [process.argv[1], "https:", "SUT API"], [process.argv[2], "wss:", "SUT WebSocket"],
    [process.argv[3], "https:", "shared chain RPC"],
  ]) {
    const url = new URL(value);
    if (url.protocol !== protocol || ["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"].includes(url.hostname)) {
      throw new Error(`${label} must use a non-loopback ${protocol} origin`);
    }
  }
  const api = new URL(process.argv[1]);
  const websocket = new URL(process.argv[2]);
  if (api.pathname !== "/" || websocket.pathname !== "/v1/stream" || api.host !== websocket.host) {
    throw new Error("SUT API root and /v1/stream targets must use the same host and port");
  }
  const local = new URL(process.argv[4]);
  if (local.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(local.hostname)) {
    throw new Error("CHAIN_LOCAL_RPC_URL must be a loopback HTTP Anvil endpoint");
  }
' "$SUT_BASE_URL" "$SUT_WS_URL" "$CHAIN_RPC_URL" "$CHAIN_LOCAL_RPC_URL"
node load/distributed/preflight-role-evidence.mjs chain
REPORT_DIR="${REPORT_DIR:-$PROJECT_ROOT/reports/performance/distributed-chain-$RUN_ID}"
mkdir -p "$(dirname "$REPORT_DIR")"
mkdir "$REPORT_DIR" || { printf '%s\n' "refusing existing report directory: $REPORT_DIR" >&2; exit 73; }
LEGACY_VALIDATOR="$PROJECT_ROOT/scripts/security/validate-gate-evidence.mjs"
CHAIN_RC="not_run"
CHAIN_EVIDENCE_RC="not_run"
CHAIN_BINDING_PREFLIGHT_RC="not_run"
CHAIN_BINDING_FINAL_RC="not_run"
EVENT_LATENCY_RC="not_run"
REORG_RC="not_run"
OBSERVABILITY_RC="not_run"
RUN_STATUS=aborted
OBSERVABILITY_PID=""

write_stages() {
  node -e '
    const fs = require("node:fs");
    const values = process.argv.slice(2).map((value) => /^\d+$/.test(value) ? Number(value) : value);
    fs.writeFileSync(process.argv[1], JSON.stringify({
      chainBindingPreflight: values[0], chain: values[1], chainEvidence: values[2],
      chainObservability: values[3], chainBindingFinal: values[4],
      eventLatencyEvidence: values[5], reorgEvidence: values[6],
    }, null, 2) + "\n");
  ' "$REPORT_DIR/stage-exit-codes.json" "$CHAIN_BINDING_PREFLIGHT_RC" "$CHAIN_RC" "$CHAIN_EVIDENCE_RC" \
    "$OBSERVABILITY_RC" "$CHAIN_BINDING_FINAL_RC" "$EVENT_LATENCY_RC" "$REORG_RC"
}

finalize() {
  local original_rc=$?
  trap - EXIT INT TERM
  if [[ -n "$OBSERVABILITY_PID" ]] && kill -0 "$OBSERVABILITY_PID" 2>/dev/null; then kill -TERM "$OBSERVABILITY_PID" 2>/dev/null; fi
  if [[ -n "$OBSERVABILITY_PID" ]]; then wait "$OBSERVABILITY_PID" 2>/dev/null || true; fi
  write_stages
  if [[ "$original_rc" -eq 0 ]]; then RUN_STATUS=completed; fi
  node load/distributed/write-role-evidence.mjs chain "$REPORT_DIR" "$RUN_ID" "$RUN_STATUS" || original_rc=1
  exit "$original_rc"
}
trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
write_stages

set +e
node load/distributed/chain-node-binding.mjs preflight "$RUN_ID" "$CHAIN_LOCAL_RPC_URL" "$CHAIN_RPC_URL" \
  "$REPORT_DIR/chain-node-preflight.json" >"$REPORT_DIR/chain-node-binding.log" 2>&1
CHAIN_BINDING_PREFLIGHT_RC=$?
set -e
write_stages
[[ "$CHAIN_BINDING_PREFLIGHT_RC" -eq 0 ]] || exit 1

# The topology adapter starts before transaction load so its client can timestamp real checkpoint
# deliveries. It may wait for CHAIN_REPORT_PATH to appear before injecting the post-load reorg.
: "${CHAIN_OBSERVABILITY_COMMAND:?CHAIN_OBSERVABILITY_COMMAND must produce event-latency-raw.json, event-latency.json, and reorg-recovery.json}"
RUN_ID="$RUN_ID" CHAIN_REPORT_PATH="$REPORT_DIR/chain.json" CHAIN_RPC_URL="$CHAIN_RPC_URL" \
SUT_BASE_URL="$SUT_BASE_URL" SUT_WS_URL="$SUT_WS_URL" \
EVENT_LATENCY_RAW_PATH="$REPORT_DIR/event-latency-raw.json" \
EVENT_LATENCY_REPORT_PATH="$REPORT_DIR/event-latency.json" REORG_REPORT_PATH="$REPORT_DIR/reorg-recovery.json" \
bash -lc "$CHAIN_OBSERVABILITY_COMMAND" >"$REPORT_DIR/chain-observability.log" 2>&1 &
OBSERVABILITY_PID=$!

set +e
LOAD_PROFILE=full CPREDICT_LOAD_CONFIRM="$CPREDICT_LOAD_CONFIRM" ANVIL_RPC_URL="$CHAIN_LOCAL_RPC_URL" \
CHAIN_TPS=50 CHAIN_DURATION=600 REPORT_PATH="$REPORT_DIR/chain.json" \
node load/chain/hot-market.mjs >"$REPORT_DIR/chain.log" 2>&1
CHAIN_RC=$?
node "$LEGACY_VALIDATOR" load-chain "$REPORT_DIR/chain.json" >>"$REPORT_DIR/chain.log" 2>&1
CHAIN_EVIDENCE_RC=$?
set -e
write_stages
[[ "$CHAIN_RC" -eq 0 && "$CHAIN_EVIDENCE_RC" -eq 0 ]] || exit 1

set +e
wait "$OBSERVABILITY_PID"
OBSERVABILITY_RC=$?
OBSERVABILITY_PID=""
node load/distributed/chain-node-binding.mjs final "$RUN_ID" "$CHAIN_LOCAL_RPC_URL" "$CHAIN_RPC_URL" \
  "$REPORT_DIR/chain-node-final.json" "$REPORT_DIR/chain-node-preflight.json" "$REPORT_DIR/chain.json" \
  >>"$REPORT_DIR/chain-node-binding.log" 2>&1
CHAIN_BINDING_FINAL_RC=$?
node load/distributed/commercial-evidence.mjs validate-event-latency \
  "$REPORT_DIR/event-latency.json" "$REPORT_DIR/event-latency-raw.json" "$REPORT_DIR/chain.json" \
  >>"$REPORT_DIR/chain-observability.log" 2>&1
EVENT_LATENCY_RC=$?
node load/distributed/commercial-evidence.mjs validate-reorg "$REPORT_DIR/reorg-recovery.json" \
  >>"$REPORT_DIR/chain-observability.log" 2>&1
REORG_RC=$?
set -e
write_stages
[[ "$OBSERVABILITY_RC" -eq 0 && "$CHAIN_BINDING_FINAL_RC" -eq 0 && "$EVENT_LATENCY_RC" -eq 0 && "$REORG_RC" -eq 0 ]] || exit 1
RUN_STATUS=completed
