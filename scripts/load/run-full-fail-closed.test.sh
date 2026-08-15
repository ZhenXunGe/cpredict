#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNNER="$PROJECT_ROOT/scripts/load/run-full.sh"
FIXTURE_ROOT="$(mktemp -d /private/tmp/cpredict-load-fail-closed.XXXXXX)"
FUNCTION_FILE="$FIXTURE_ROOT/require-stage-success.sh"

cleanup_outer() {
  rm -rf -- "$FIXTURE_ROOT"
}
trap cleanup_outer EXIT

# Execute the helper extracted from the production runner, so this test cannot
# silently drift to a separate reimplementation of the fail-closed decision.
awk '
  /^require_stage_success\(\) \{/ { capture = 1 }
  capture { print }
  capture && /^}/ { exit }
' "$RUNNER" >"$FUNCTION_FILE"
if ! rg -q '^require_stage_success\(\) \{' "$FUNCTION_FILE"; then
  printf '%s\n' 'failed to extract require_stage_success from production runner' >&2
  exit 1
fi

# Integration ordering: the API gate must appear after its evidence validator
# and before the WebSocket command. This guards against a correct helper that is
# accidentally moved too late in the real runner.
api_validator_line="$(rg -n 'EVIDENCE_VALIDATOR.*k6-api' "$RUNNER" | cut -d: -f1)"
api_gate_line="$(rg -n 'require_stage_success 1 .*API_RC.*API_LOG_RC.*API_EVIDENCE_RC' "$RUNNER" | cut -d: -f1)"
websocket_line="$(rg -n 'k6-websocket-summary\.json' "$RUNNER" | cut -d: -f1 | sed -n '1p')"
if [[ -z "$api_validator_line" || -z "$api_gate_line" || -z "$websocket_line" ]] ||
   (( api_validator_line >= api_gate_line || api_gate_line >= websocket_line )); then
  printf '%s\n' 'production runner API fail-closed gate ordering is invalid' >&2
  exit 1
fi

set +e
(
  set -euo pipefail
  # shellcheck source=/dev/null
  source "$FUNCTION_FILE"

  OVERALL_RC=0
  API_RC=99
  API_LOG_RC=0
  API_EVIDENCE_RC=1
  WEBSOCKET_RC="not_run"
  SYNTHETIC_INDEXER_RC="not_run"
  CHAIN_RC="not_run"
  API_PID=""
  POSTGRES_PID=""
  ANVIL_PID=""
  POSTGRES_TEMP="$FIXTURE_ROOT/postgres-data"
  mkdir -p "$POSTGRES_TEMP"

  write_stage_manifest() {
    printf '{"api":%s,"apiLog":%s,"apiEvidence":%s,"websocket":"%s","syntheticIndexer":"%s","chain":"%s","overall":%s}\n' \
      "$API_RC" "$API_LOG_RC" "$API_EVIDENCE_RC" "$WEBSOCKET_RC" \
      "$SYNTHETIC_INDEXER_RC" "$CHAIN_RC" "$OVERALL_RC" >"$FIXTURE_ROOT/stage-exit-codes.json"
  }

  cleanup_fixture() {
    local pid
    set +e
    for pid in "$API_PID" "$POSTGRES_PID" "$ANVIL_PID"; do
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid" 2>/dev/null; fi
      if [[ -n "$pid" ]]; then wait "$pid" 2>/dev/null; fi
    done
    rm -rf -- "$POSTGRES_TEMP"
    printf '%s\n' "$API_PID $POSTGRES_PID $ANVIL_PID" >"$FIXTURE_ROOT/cleaned-pids"
    printf '%s\n' 'cleanup-complete' >"$FIXTURE_ROOT/cleanup.marker"
  }
  trap cleanup_fixture EXIT

  sleep 30 & API_PID=$!
  sleep 30 & POSTGRES_PID=$!
  sleep 30 & ANVIL_PID=$!

  require_stage_success 1 "$API_RC" "$API_LOG_RC" "$API_EVIDENCE_RC"
  touch "$FIXTURE_ROOT/websocket-ran" "$FIXTURE_ROOT/synthetic-ran" "$FIXTURE_ROOT/chain-ran"
)
fixture_rc=$?
set -e

if [[ "$fixture_rc" -ne 1 ]]; then
  printf '%s\n' "API failure fixture returned $fixture_rc instead of 1" >&2
  exit 1
fi
[[ -f "$FIXTURE_ROOT/cleanup.marker" ]]
[[ ! -e "$FIXTURE_ROOT/postgres-data" ]]
[[ ! -e "$FIXTURE_ROOT/websocket-ran" ]]
[[ ! -e "$FIXTURE_ROOT/synthetic-ran" ]]
[[ ! -e "$FIXTURE_ROOT/chain-ran" ]]

while read -r pid; do
  [[ -z "$pid" ]] && continue
  if kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' "fixture process $pid survived cleanup" >&2
    exit 1
  fi
done < <(tr ' ' '\n' <"$FIXTURE_ROOT/cleaned-pids")

node -e '
  const fs = require("node:fs");
  const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (report.api !== 99 || report.apiLog !== 0 || report.apiEvidence !== 1) process.exit(1);
  for (const key of ["websocket", "syntheticIndexer", "chain"]) {
    if (report[key] !== "not_run") process.exit(1);
  }
  if (report.overall !== 1) process.exit(1);
' "$FIXTURE_ROOT/stage-exit-codes.json"

printf '%s\n' 'run-full API fail-closed fixture: PASS'
