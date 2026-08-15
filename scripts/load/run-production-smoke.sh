#!/usr/bin/env bash
set -euo pipefail

if [[ "${CPREDICT_LOAD_CONFIRM:-}" != "I_UNDERSTAND_RESOURCE_USAGE" ]]; then
  printf '%s\n' 'Refusing 100k-row production smoke: set CPREDICT_LOAD_CONFIRM=I_UNDERSTAND_RESOURCE_USAGE' >&2
  exit 64
fi
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"
RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { printf '%s\n' 'invalid RUN_ID' >&2; exit 64; }
REPORT_DIR="$PROJECT_ROOT/reports/performance/production-smoke-$RUN_ID"
mkdir -p "$PROJECT_ROOT/reports/performance"
mkdir "$REPORT_DIR" || { printf '%s\n' "refusing existing report directory: $REPORT_DIR" >&2; exit 73; }

POSTGRES_ROOT="$PROJECT_ROOT/.tools/postgresql-17.10"
K6_BIN="$PROJECT_ROOT/.tools/k6/k6"
ANVIL_BIN="$PROJECT_ROOT/.tools/foundry/bin/anvil"
CAST_BIN="$PROJECT_ROOT/.tools/foundry/bin/cast"
VALIDATOR="$PROJECT_ROOT/scripts/load/validate-production-evidence.mjs"
LEGACY_VALIDATOR="$PROJECT_ROOT/scripts/security/validate-gate-evidence.mjs"
LOAD_API_PORT="${LOAD_API_PORT:-19080}"
POSTGRES_PORT="${POSTGRES_PORT:-19432}"
ANVIL_PORT="${ANVIL_PORT:-19545}"
RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TEMP_BUILD=""
POSTGRES_RUN_ROOT=""
POSTGRES_DATA_DIR=""
POSTGRES_STARTED=0
API_PID=""
ANVIL_PID=""
WRITE_EVIDENCE_INDEX=1
API_LOAD_PROFILE="${API_LOAD_PROFILE:-smoke}"
if [[ "$API_LOAD_PROFILE" != "smoke" && "$API_LOAD_PROFILE" != "calibration" ]]; then
  printf '%s\n' 'API_LOAD_PROFILE must be smoke or calibration' >&2
  exit 64
fi

cleanup() {
  local original_rc=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$API_PID" ]] && kill -0 "$API_PID" 2>/dev/null; then kill -TERM "$API_PID" 2>/dev/null; fi
  if [[ -n "$API_PID" ]]; then wait "$API_PID" 2>/dev/null; fi
  if [[ "$POSTGRES_STARTED" -eq 1 ]]; then
    "$POSTGRES_ROOT/bin/pg_ctl" -D "$POSTGRES_DATA_DIR" -m fast -w stop >>"$REPORT_DIR/postgres-shutdown.log" 2>&1
    "$POSTGRES_ROOT/bin/pg_ctl" -D "$POSTGRES_DATA_DIR" status >>"$REPORT_DIR/postgres-shutdown.log" 2>&1
    PG_STATUS_RC=$?
    "$POSTGRES_ROOT/bin/pg_isready" -h 127.0.0.1 -p "$POSTGRES_PORT" -d postgres >>"$REPORT_DIR/postgres-shutdown.log" 2>&1
    PG_READY_RC=$?
    if [[ "$PG_STATUS_RC" -ne 3 || "$PG_READY_RC" -ne 2 ]]; then original_rc=1; fi
  fi
  if [[ -n "$ANVIL_PID" ]] && kill -0 "$ANVIL_PID" 2>/dev/null; then kill -TERM "$ANVIL_PID" 2>/dev/null; fi
  if [[ -n "$ANVIL_PID" ]]; then wait "$ANVIL_PID" 2>/dev/null; fi
  case "$POSTGRES_RUN_ROOT" in
    /private/tmp/cpredict-load-postgres.*) rm -rf -- "$POSTGRES_RUN_ROOT" ;;
    "") ;;
    *) printf '%s\n' "refusing unexpected PostgreSQL path: $POSTGRES_RUN_ROOT" >&2; original_rc=1 ;;
  esac
  case "$TEMP_BUILD" in
    "$PROJECT_ROOT"/.tools/cpredict-load-build.*) rm -rf -- "$TEMP_BUILD" ;;
    "") ;;
    *) printf '%s\n' "refusing unexpected build path: $TEMP_BUILD" >&2; original_rc=1 ;;
  esac
  if [[ "$WRITE_EVIDENCE_INDEX" -eq 1 ]]; then
    node "$PROJECT_ROOT/load/production/write-evidence-index.mjs" "$REPORT_DIR" "$RUN_ID" \
      production-indexer-Fastify-PostgreSQL-smoke || { if [[ "$original_rc" -eq 0 ]]; then original_rc=1; fi; }
  fi
  exit "$original_rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for port in "$LOAD_API_PORT" "$POSTGRES_PORT" "$ANVIL_PORT"; do
  [[ "$port" =~ ^[0-9]+$ ]] && (( 10#$port >= 1 && 10#$port <= 65535 )) || { printf '%s\n' "invalid port: $port" >&2; exit 64; }
  node load/node/assert-port-free.mjs "$port"
done
[[ -x "$K6_BIN" && -x "$ANVIL_BIN" && -x "$POSTGRES_ROOT/bin/postgres" ]] || { printf '%s\n' 'project-local load tools are missing' >&2; exit 69; }
EXPECTED_K6_SHA="$(awk -F '|' '$1 ~ /^k6-binary-sha256 / { gsub(/ /, "", $2); print $2 }' manifests/load-tools.lock)"
[[ "$(shasum -a 256 "$K6_BIN" | awk '{ print $1 }')" == "$EXPECTED_K6_SHA" ]] || { printf '%s\n' 'k6 binary SHA-256 mismatch' >&2; exit 69; }

set +e
if [[ "$API_LOAD_PROFILE" == "calibration" ]]; then
  REQUIRE_FULL_READY=1 REPORT_PATH="$REPORT_DIR/preflight.json" node load/node/preflight.mjs \
    >"$REPORT_DIR/preflight.log" 2>&1
else
  REPORT_PATH="$REPORT_DIR/preflight.json" node load/node/preflight.mjs \
    >"$REPORT_DIR/preflight.log" 2>&1
fi
PREFLIGHT_RC=$?
PREFLIGHT_EVIDENCE_RC=0
if [[ "$API_LOAD_PROFILE" == "calibration" ]]; then
  node "$LEGACY_VALIDATOR" load-preflight "$REPORT_DIR/preflight.json" \
    >>"$REPORT_DIR/preflight.log" 2>&1
  PREFLIGHT_EVIDENCE_RC=$?
fi
set -e
if [[ "$PREFLIGHT_RC" -ne 0 || "$PREFLIGHT_EVIDENCE_RC" -ne 0 ]]; then
  printf '%s\n' "calibration preflight failed: command=$PREFLIGHT_RC evidence=$PREFLIGHT_EVIDENCE_RC" >&2
  exit 75
fi

TEMP_BUILD="$(mktemp -d "$PROJECT_ROOT/.tools/cpredict-load-build.XXXXXX")"
./node_modules/.bin/tsc -p tsconfig.json --outDir "$TEMP_BUILD" >"$REPORT_DIR/typescript.log" 2>&1
POSTGRES_RUN_ROOT="$(mktemp -d /private/tmp/cpredict-load-postgres.XXXXXX)"
POSTGRES_DATA_DIR="$POSTGRES_RUN_ROOT/data"
chmod 700 "$POSTGRES_RUN_ROOT"
"$POSTGRES_ROOT/bin/initdb" -D "$POSTGRES_DATA_DIR" --username=cpredict_load --auth-local=trust \
  --auth-host=trust --no-locale --encoding=UTF8 >"$REPORT_DIR/postgres-initdb.log" 2>&1
"$POSTGRES_ROOT/bin/pg_ctl" -D "$POSTGRES_DATA_DIR" -l "$REPORT_DIR/postgres.log" \
  -o "-c listen_addresses=127.0.0.1 -c port=$POSTGRES_PORT -c unix_socket_directories=$POSTGRES_RUN_ROOT -c max_connections=100 -c shared_buffers=256MB -c work_mem=4MB -c checkpoint_timeout=10min -c idle_in_transaction_session_timeout=30s -c statement_timeout=5s" \
  -w start >"$REPORT_DIR/postgres-start.log" 2>&1
POSTGRES_STARTED=1
POSTMASTER_PID="$(sed -n '1p' "$POSTGRES_DATA_DIR/postmaster.pid")"
kill -0 "$POSTMASTER_PID" 2>/dev/null
DATABASE_URL="postgresql://cpredict_load@127.0.0.1:$POSTGRES_PORT/postgres?sslmode=disable"
LOAD_DATABASE_URL="$DATABASE_URL" LOAD_DATABASE_EXPECTED_DATA_DIR="$POSTGRES_DATA_DIR" \
RUN_ID="$RUN_ID" RUN_STARTED_AT="$RUN_STARTED_AT" LOAD_CHAIN_ID=31337 \
CPREDICT_LOAD_CONFIRM="$CPREDICT_LOAD_CONFIRM" REPORT_PATH="$REPORT_DIR/production-seed.json" \
node load/production/seed-postgres.mjs 2>&1 | tee "$REPORT_DIR/production-seed.log"
node "$VALIDATOR" seed "$REPORT_DIR/production-seed.json"

"$ANVIL_BIN" --silent --port "$ANVIL_PORT" --chain-id 31337 >"$REPORT_DIR/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in {1..50}; do
  if [[ "$("$CAST_BIN" block-number --rpc-url "http://127.0.0.1:$ANVIL_PORT" 2>/dev/null)" == "0" ]]; then break; fi
  sleep 0.1
done
[[ "$("$CAST_BIN" chain-id --rpc-url "http://127.0.0.1:$ANVIL_PORT")" == "31337" ]]

CPREDICT_INDEXER_HOST=127.0.0.1 CPREDICT_INDEXER_PORT="$LOAD_API_PORT" \
CPREDICT_INDEXER_LOG_LEVEL=warn CPREDICT_INDEXER_CHAIN_ID=31337 \
CPREDICT_INDEXER_RPC_URL="http://127.0.0.1:$ANVIL_PORT" CPREDICT_INDEXER_DATABASE_URL="$DATABASE_URL" \
CPREDICT_INDEXER_FACTORY_ADDRESS=0x00000000000000000000000000000000000000f1 \
CPREDICT_INDEXER_CORE_ADDRESSES=0x00000000000000000000000000000000000000f1,0x00000000000000000000000000000000000000f2 \
CPREDICT_INDEXER_DEPLOYMENT_BLOCK=0 CPREDICT_INDEXER_CONFIRMATIONS=0 CPREDICT_INDEXER_BATCH_SIZE=500 \
CPREDICT_INDEXER_MAX_BATCHES_PER_TICK=4 CPREDICT_INDEXER_POLL_INTERVAL_MS=1000 CPREDICT_INDEXER_RPC_TIMEOUT_MS=5000 \
CPREDICT_INDEXER_LISTEN_BACKLOG=16384 CPREDICT_INDEXER_HTTP_MAX_CONNECTIONS=20000 \
CPREDICT_INDEXER_WS_MAX_CONNECTIONS=12000 CPREDICT_INDEXER_WS_HEARTBEAT_INTERVAL_MS=5000 \
CPREDICT_INDEXER_WS_MAX_BUFFERED_AMOUNT_BYTES=65536 CPREDICT_INDEXER_WS_SHUTDOWN_GRACE_MS=5000 \
node "$TEMP_BUILD/offchain/indexer/src/main.js" >"$REPORT_DIR/indexer-service.log" 2>&1 &
API_PID=$!
for _ in {1..100}; do
  if [[ "$(curl -fsS --max-time 1 "http://127.0.0.1:$LOAD_API_PORT/readyz" 2>/dev/null)" == '{"status":"ready"}' ]]; then break; fi
  sleep 0.1
done
kill -0 "$API_PID" 2>/dev/null
[[ "$(curl -fsS --max-time 1 "http://127.0.0.1:$LOAD_API_PORT/readyz")" == '{"status":"ready"}' ]]

RUN_ID="$RUN_ID" TARGET_URL="http://127.0.0.1:$LOAD_API_PORT" LOAD_CHAIN_ID=31337 \
REPORT_PATH="$REPORT_DIR/production-api-smoke.json" node load/production/verify-api.mjs \
  2>&1 | tee "$REPORT_DIR/production-api-smoke.log"
node "$VALIDATOR" api-smoke "$REPORT_DIR/production-api-smoke.json"
set +e
"$K6_BIN" run --summary-export "$REPORT_DIR/k6-api-summary.json" \
  -e LOAD_PROFILE="$API_LOAD_PROFILE" -e HTTP_RPS="${HTTP_RPS:-50}" -e HTTP_DURATION="${HTTP_DURATION:-10}" \
  -e CPREDICT_LOAD_CONFIRM="$CPREDICT_LOAD_CONFIRM" -e TARGET_URL="http://127.0.0.1:$LOAD_API_PORT" \
  load/k6/api-read.js 2>&1 | tee "$REPORT_DIR/k6-api.log"
api_pipeline_status=("${PIPESTATUS[@]}")
API_RC=${api_pipeline_status[0]}
API_LOG_RC=${api_pipeline_status[1]}
if [[ ! -s "$REPORT_DIR/k6-api.log" ]]; then API_LOG_RC=66; fi
API_EVIDENCE_RC=0
if [[ "$API_LOAD_PROFILE" == "calibration" ]]; then
  node "$VALIDATOR" k6-api-calibration "$REPORT_DIR/k6-api-summary.json"
  API_EVIDENCE_RC=$?
fi
set -e
printf '{"schemaVersion":1,"profile":"%s","k6Exit":%s,"logExit":%s,"evidenceExit":%s}\n' \
  "$API_LOAD_PROFILE" "$API_RC" "$API_LOG_RC" "$API_EVIDENCE_RC" >"$REPORT_DIR/api-load-stage.json"
if [[ "$API_RC" -ne 0 || "$API_LOG_RC" -ne 0 || "$API_EVIDENCE_RC" -ne 0 ]]; then exit 1; fi

set +e
"$K6_BIN" run --summary-export "$REPORT_DIR/k6-websocket-summary.json" \
  -e LOAD_PROFILE=smoke -e WS_CONNECTIONS="${WS_CONNECTIONS:-50}" -e WS_HOLD_SECONDS="${WS_HOLD_SECONDS:-10}" \
  -e CPREDICT_LOAD_CONFIRM="$CPREDICT_LOAD_CONFIRM" -e WS_TARGET="ws://127.0.0.1:$LOAD_API_PORT/v1/stream" \
  load/k6/read-connections.js 2>&1 | tee "$REPORT_DIR/k6-websocket.log"
websocket_pipeline_status=("${PIPESTATUS[@]}")
WEBSOCKET_RC=${websocket_pipeline_status[0]}
WEBSOCKET_LOG_RC=${websocket_pipeline_status[1]}
if [[ ! -s "$REPORT_DIR/k6-websocket.log" ]]; then WEBSOCKET_LOG_RC=66; fi
set -e
printf '{"schemaVersion":1,"profile":"smoke","k6Exit":%s,"logExit":%s}\n' \
  "$WEBSOCKET_RC" "$WEBSOCKET_LOG_RC" >"$REPORT_DIR/websocket-load-stage.json"
if [[ "$WEBSOCKET_RC" -ne 0 || "$WEBSOCKET_LOG_RC" -ne 0 ]]; then exit 1; fi

printf '%s\n' "Production-composition smoke evidence: $REPORT_DIR"
