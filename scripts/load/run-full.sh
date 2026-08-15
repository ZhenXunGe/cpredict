#!/usr/bin/env bash
set -euo pipefail

if [[ "${CPREDICT_LOAD_CONFIRM:-}" != "I_UNDERSTAND_RESOURCE_USAGE" ]]; then
  printf '%s\n' 'Refusing full load: set CPREDICT_LOAD_CONFIRM=I_UNDERSTAND_RESOURCE_USAGE' >&2
  exit 64
fi

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"

RUN_ID="${RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  printf '%s\n' 'RUN_ID must contain only 1-64 letters, digits, dots, underscores, or hyphens' >&2
  exit 64
fi
REPORT_PARENT="$PROJECT_ROOT/reports/performance"
REPORT_DIR="$REPORT_PARENT/full-$RUN_ID"
mkdir -p "$REPORT_PARENT"
if ! mkdir "$REPORT_DIR"; then
  printf '%s\n' "Refusing existing full-load report directory: $REPORT_DIR" >&2
  exit 73
fi

EVIDENCE_VALIDATOR="$PROJECT_ROOT/scripts/load/validate-production-evidence.mjs"
LEGACY_VALIDATOR="$PROJECT_ROOT/scripts/security/validate-gate-evidence.mjs"
LOAD_TOOL_LOCK="$PROJECT_ROOT/manifests/load-tools.lock"
SECURITY_TOOL_LOCK="$PROJECT_ROOT/manifests/security-tools.lock"
POSTGRES_TOOL_LOCK="$PROJECT_ROOT/manifests/postgresql-tools.lock"
K6_BIN="$PROJECT_ROOT/.tools/k6/k6"
ANVIL_BIN="$PROJECT_ROOT/.tools/foundry/bin/anvil"
CAST_BIN="$PROJECT_ROOT/.tools/foundry/bin/cast"
POSTGRES_ROOT="$PROJECT_ROOT/.tools/postgresql-17.10"
POSTGRES_BIN="$POSTGRES_ROOT/bin/postgres"
INITDB_BIN="$POSTGRES_ROOT/bin/initdb"
PG_CTL_BIN="$POSTGRES_ROOT/bin/pg_ctl"
PG_ISREADY_BIN="$POSTGRES_ROOT/bin/pg_isready"
TEMP_BUILD=""
POSTGRES_RUN_ROOT=""
POSTGRES_DATA_DIR=""
POSTGRES_STARTED=0
POSTMASTER_PID=""
API_PID=""
ANVIL_PID=""
RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RUN_STATUS="running"
RUN_COMPLETED=0
RUNNER_RC="not_run"
OVERALL_RC=0

TOOLCHAIN_RC="not_run"
PREFLIGHT_RC="not_run"
PREFLIGHT_EVIDENCE_RC="not_run"
POSTGRES_START_RC="not_run"
SEED_RC="not_run"
SEED_LOG_RC="not_run"
SEED_EVIDENCE_RC="not_run"
ANVIL_READINESS_RC="not_run"
TSC_RC="not_run"
PRODUCTION_API_READINESS_RC="not_run"
PRODUCTION_API_SMOKE_RC="not_run"
PRODUCTION_API_SMOKE_LOG_RC="not_run"
PRODUCTION_API_SMOKE_EVIDENCE_RC="not_run"
API_RC="not_run"
API_LOG_RC="not_run"
API_EVIDENCE_RC="not_run"
WEBSOCKET_RC="not_run"
WEBSOCKET_LOG_RC="not_run"
WEBSOCKET_EVIDENCE_RC="not_run"
WEBSOCKET_BASELINE_RC="not_run"
WEBSOCKET_FINAL_CAPTURE_RC="not_run"
WEBSOCKET_K6_EVIDENCE_RC="not_run"
WEBSOCKET_CAPACITY_EVIDENCE_RC="not_run"
PRODUCTION_API_SHUTDOWN_RC="not_run"
POSTGRES_SHUTDOWN_RC="not_run"
POSTGRES_SHUTDOWN_EVIDENCE_RC="not_run"
SYNTHETIC_INDEXER_RC="not_run"
SYNTHETIC_INDEXER_EVIDENCE_RC="not_run"
CHAIN_RC="not_run"
CHAIN_EVIDENCE_RC="not_run"
ANVIL_SHUTDOWN_RC="not_run"
MANIFEST_EVIDENCE_RC="not_run"

json_status() {
  if [[ "$1" =~ ^[0-9]+$ ]]; then printf '%s' "$1"; else printf '"%s"' "$1"; fi
}

write_stage_manifest() {
  local effective_overall="$OVERALL_RC"
  local temporary_manifest="$REPORT_DIR/.stage-exit-codes.json.tmp"
  if [[ "$RUN_STATUS" != "completed" ]]; then effective_overall=1; fi
  {
    printf '{\n'
    printf '  "schemaVersion": 3,\n'
    printf '  "lane": "real-production-Fastify-PostgreSQL-plus-local-chain",\n'
    printf '  "runId": "%s",\n' "$RUN_ID"
    printf '  "runStatus": "%s",\n' "$RUN_STATUS"
    printf '  "runnerExit": %s,\n' "$(json_status "$RUNNER_RC")"
    printf '  "toolchain": %s,\n' "$(json_status "$TOOLCHAIN_RC")"
    printf '  "preflight": %s,\n' "$(json_status "$PREFLIGHT_RC")"
    printf '  "preflightEvidence": %s,\n' "$(json_status "$PREFLIGHT_EVIDENCE_RC")"
    printf '  "postgresStart": %s,\n' "$(json_status "$POSTGRES_START_RC")"
    printf '  "seed": %s,\n' "$(json_status "$SEED_RC")"
    printf '  "seedLog": %s,\n' "$(json_status "$SEED_LOG_RC")"
    printf '  "seedEvidence": %s,\n' "$(json_status "$SEED_EVIDENCE_RC")"
    printf '  "anvilReadiness": %s,\n' "$(json_status "$ANVIL_READINESS_RC")"
    printf '  "typescript": %s,\n' "$(json_status "$TSC_RC")"
    printf '  "productionApiReadiness": %s,\n' "$(json_status "$PRODUCTION_API_READINESS_RC")"
    printf '  "productionApiSmoke": %s,\n' "$(json_status "$PRODUCTION_API_SMOKE_RC")"
    printf '  "productionApiSmokeLog": %s,\n' "$(json_status "$PRODUCTION_API_SMOKE_LOG_RC")"
    printf '  "productionApiSmokeEvidence": %s,\n' "$(json_status "$PRODUCTION_API_SMOKE_EVIDENCE_RC")"
    printf '  "api": %s,\n' "$(json_status "$API_RC")"
    printf '  "apiLog": %s,\n' "$(json_status "$API_LOG_RC")"
    printf '  "apiEvidence": %s,\n' "$(json_status "$API_EVIDENCE_RC")"
    printf '  "websocket": %s,\n' "$(json_status "$WEBSOCKET_RC")"
    printf '  "websocketLog": %s,\n' "$(json_status "$WEBSOCKET_LOG_RC")"
    printf '  "websocketEvidence": %s,\n' "$(json_status "$WEBSOCKET_EVIDENCE_RC")"
    printf '  "productionApiShutdown": %s,\n' "$(json_status "$PRODUCTION_API_SHUTDOWN_RC")"
    printf '  "postgresShutdown": %s,\n' "$(json_status "$POSTGRES_SHUTDOWN_RC")"
    printf '  "postgresShutdownEvidence": %s,\n' "$(json_status "$POSTGRES_SHUTDOWN_EVIDENCE_RC")"
    printf '  "syntheticIndexer": %s,\n' "$(json_status "$SYNTHETIC_INDEXER_RC")"
    printf '  "syntheticIndexerEvidence": %s,\n' "$(json_status "$SYNTHETIC_INDEXER_EVIDENCE_RC")"
    printf '  "chain": %s,\n' "$(json_status "$CHAIN_RC")"
    printf '  "chainEvidence": %s,\n' "$(json_status "$CHAIN_EVIDENCE_RC")"
    printf '  "anvilShutdown": %s,\n' "$(json_status "$ANVIL_SHUTDOWN_RC")"
    printf '  "manifestEvidence": %s,\n' "$(json_status "$MANIFEST_EVIDENCE_RC")"
    printf '  "overall": %s\n' "$effective_overall"
    printf '}\n'
  } >"$temporary_manifest"
  mv "$temporary_manifest" "$REPORT_DIR/stage-exit-codes.json"
}

# A stage is successful only when every command and evidence validator in that
# stage returned zero. Exiting here is intentional: the EXIT trap remains the
# single owner of API/PostgreSQL/Anvil and temporary-directory cleanup, while
# every later stage stays exactly "not_run" in the schema-v3 manifest.
require_stage_success() {
  local failure_exit="$1"
  shift
  local stage_rc
  for stage_rc in "$@"; do
    if [[ ! "$stage_rc" =~ ^[0-9]+$ || "$stage_rc" -ne 0 ]]; then
      OVERALL_RC=1
      write_stage_manifest
      exit "$failure_exit"
    fi
  done
}

safe_remove_temp_build() {
  if [[ -z "$TEMP_BUILD" || ! -d "$TEMP_BUILD" ]]; then return; fi
  case "$TEMP_BUILD" in
    "$PROJECT_ROOT"/.tools/cpredict-load-build.*) rm -rf -- "$TEMP_BUILD" ;;
    *) printf '%s\n' "Refusing unexpected temporary build path: $TEMP_BUILD" >&2; OVERALL_RC=1 ;;
  esac
  TEMP_BUILD=""
}

safe_remove_stopped_postgres_temp() {
  if [[ -z "$POSTGRES_RUN_ROOT" || ! -d "$POSTGRES_RUN_ROOT" ]]; then return; fi
  if [[ "$POSTGRES_STARTED" -ne 0 ]]; then
    printf '%s\n' 'Refusing PostgreSQL data removal while server is marked running' >&2
    OVERALL_RC=1
    return
  fi
  if [[ -f "$POSTGRES_DATA_DIR/postmaster.pid" ]]; then
    local recorded_pid
    recorded_pid="$(sed -n '1p' "$POSTGRES_DATA_DIR/postmaster.pid")"
    if [[ "$recorded_pid" =~ ^[0-9]+$ ]] && kill -0 "$recorded_pid" 2>/dev/null; then
      printf '%s\n' "Refusing live PostgreSQL data removal for PID $recorded_pid" >&2
      OVERALL_RC=1
      return
    fi
  fi
  case "$POSTGRES_RUN_ROOT" in
    /private/tmp/cpredict-load-postgres.*) rm -rf -- "$POSTGRES_RUN_ROOT" ;;
    *) printf '%s\n' "Refusing unexpected PostgreSQL temp path: $POSTGRES_RUN_ROOT" >&2; OVERALL_RC=1; return ;;
  esac
  if [[ -e "$POSTGRES_RUN_ROOT" ]]; then OVERALL_RC=1; fi
  POSTGRES_RUN_ROOT=""
}

stop_api() {
  if [[ -z "$API_PID" ]]; then return; fi
  set +e
  if kill -0 "$API_PID" 2>/dev/null; then kill -TERM "$API_PID" 2>/dev/null; fi
  wait "$API_PID"
  local wait_rc=$?
  set -e
  API_PID=""
  if [[ "$wait_rc" -eq 0 ]]; then PRODUCTION_API_SHUTDOWN_RC=0; else PRODUCTION_API_SHUTDOWN_RC="$wait_rc"; OVERALL_RC=1; fi
  write_stage_manifest
}

stop_anvil() {
  if [[ -z "$ANVIL_PID" ]]; then return; fi
  set +e
  if kill -0 "$ANVIL_PID" 2>/dev/null; then kill -TERM "$ANVIL_PID" 2>/dev/null; fi
  wait "$ANVIL_PID" 2>/dev/null
  if kill -0 "$ANVIL_PID" 2>/dev/null; then ANVIL_SHUTDOWN_RC=1; OVERALL_RC=1; else ANVIL_SHUTDOWN_RC=0; fi
  set -e
  ANVIL_PID=""
  write_stage_manifest
}

stop_postgres() {
  if [[ "$POSTGRES_STARTED" -ne 1 ]]; then return; fi
  local stop_rc status_rc ready_rc removed
  set +e
  "$PG_CTL_BIN" -D "$POSTGRES_DATA_DIR" -m fast -w stop >>"$REPORT_DIR/postgres-shutdown.log" 2>&1
  stop_rc=$?
  "$PG_CTL_BIN" -D "$POSTGRES_DATA_DIR" status >>"$REPORT_DIR/postgres-shutdown.log" 2>&1
  status_rc=$?
  "$PG_ISREADY_BIN" -h 127.0.0.1 -p "$POSTGRES_PORT" -d postgres >>"$REPORT_DIR/postgres-shutdown.log" 2>&1
  ready_rc=$?
  set -e
  POSTGRES_STARTED=0
  removed=false
  if [[ "$stop_rc" -eq 0 && "$status_rc" -eq 3 && "$ready_rc" -eq 2 ]]; then
    case "$POSTGRES_RUN_ROOT" in
      /private/tmp/cpredict-load-postgres.*)
        rm -rf -- "$POSTGRES_RUN_ROOT"
        if [[ ! -e "$POSTGRES_RUN_ROOT" ]]; then removed=true; POSTGRES_RUN_ROOT=""; fi
        ;;
      *) printf '%s\n' "Refusing unexpected PostgreSQL temp path: $POSTGRES_RUN_ROOT" >&2 ;;
    esac
  fi
  {
    printf '{\n'
    printf '  "schemaVersion": 1,\n'
    printf '  "runId": "%s",\n' "$RUN_ID"
    printf '  "pgCtlStopExit": %s,\n' "$stop_rc"
    printf '  "pgCtlStatusAfterStop": %s,\n' "$status_rc"
    printf '  "pgIsReadyAfterStop": %s,\n' "$ready_rc"
    printf '  "dataDirectoryRemoved": %s,\n' "$removed"
    printf '  "postmasterPid": %s\n' "${POSTMASTER_PID:-0}"
    printf '}\n'
  } >"$REPORT_DIR/postgres-shutdown.json"
  if [[ "$stop_rc" -eq 0 && "$status_rc" -eq 3 && "$ready_rc" -eq 2 && "$removed" == true ]]; then
    POSTGRES_SHUTDOWN_RC=0
  else
    POSTGRES_SHUTDOWN_RC=1
    OVERALL_RC=1
  fi
  set +e
  node "$EVIDENCE_VALIDATOR" postgres-shutdown "$REPORT_DIR/postgres-shutdown.json"
  POSTGRES_SHUTDOWN_EVIDENCE_RC=$?
  set -e
  if [[ "$POSTGRES_SHUTDOWN_EVIDENCE_RC" -ne 0 ]]; then OVERALL_RC=1; fi
  write_stage_manifest
}

finalize() {
  local exit_rc=$?
  trap - EXIT INT TERM
  set +e
  stop_api
  stop_postgres
  stop_anvil
  safe_remove_stopped_postgres_temp
  safe_remove_temp_build
  if [[ "$exit_rc" -ne 0 ]]; then OVERALL_RC=1; fi
  if [[ "$exit_rc" -eq 0 && "$OVERALL_RC" -ne 0 ]]; then exit_rc=1; fi
  if [[ "$RUN_COMPLETED" -eq 1 ]]; then RUN_STATUS="completed"; else RUN_STATUS="aborted"; fi
  RUNNER_RC="$exit_rc"
  write_stage_manifest
  exit "$exit_rc"
}

trap finalize EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
write_stage_manifest

lock_column() {
  awk -F '|' -v expected_key="$1" -v requested_column="$2" '
    {
      key = $1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key == expected_key) {
        value = $requested_column
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
        print value
        found = 1
        exit
      }
    }
    END { if (!found) exit 1 }
  ' "$3"
}

sha256_file() {
  shasum -a 256 "$1" | awk '{ print $1 }'
}

fail_toolchain() {
  TOOLCHAIN_RC=69
  OVERALL_RC=1
  printf '%s\n' "$1" >&2
  write_stage_manifest
  exit 69
}

for path in "$LOAD_TOOL_LOCK" "$SECURITY_TOOL_LOCK" "$POSTGRES_TOOL_LOCK" "$EVIDENCE_VALIDATOR" "$LEGACY_VALIDATOR"; do
  [[ -r "$path" ]] || fail_toolchain "missing load-gate input: $path"
done
for path in "$K6_BIN" "$ANVIL_BIN" "$CAST_BIN" "$POSTGRES_BIN" "$INITDB_BIN" "$PG_CTL_BIN" "$PG_ISREADY_BIN"; do
  [[ -x "$path" ]] || fail_toolchain "missing project-local executable: $path"
done

LOCKED_K6_DESCRIPTOR="$(lock_column k6 2 "$LOAD_TOOL_LOCK")" || fail_toolchain "load tool lock has no k6 descriptor"
LOCKED_K6_PATH="$(lock_column k6 3 "$LOAD_TOOL_LOCK")" || fail_toolchain "load tool lock has no k6 path"
LOCKED_K6_SHA="$(lock_column k6-binary-sha256 2 "$LOAD_TOOL_LOCK")" || fail_toolchain "load tool lock has no k6 SHA-256"
LOCKED_K6_BUILD="$(lock_column k6-reported-build 2 "$LOAD_TOOL_LOCK")" || fail_toolchain "load tool lock has no k6 build"
[[ "$LOCKED_K6_PATH" == "project-local .tools/k6/k6" ]] || fail_toolchain "load tool lock does not require the project-local k6"
LOCKED_K6_VERSION="${LOCKED_K6_DESCRIPTOR%% / *}"
LOCKED_K6_COMMIT="${LOCKED_K6_DESCRIPTOR##* / }"
LOCKED_K6_GO="${LOCKED_K6_BUILD%% / *}"
LOCKED_K6_PLATFORM="${LOCKED_K6_BUILD##* / }"
LOCKED_K6_RUNTIME_PLATFORM="${LOCKED_K6_PLATFORM/-//}"
EXPECTED_K6_VERSION="k6 $LOCKED_K6_VERSION (commit/$LOCKED_K6_COMMIT, $LOCKED_K6_GO, $LOCKED_K6_RUNTIME_PLATFORM)"
ACTUAL_K6_VERSION="$("$K6_BIN" version 2>&1)" || fail_toolchain "project-local k6 cannot report its version"
[[ "$ACTUAL_K6_VERSION" == "$EXPECTED_K6_VERSION" ]] || fail_toolchain "project-local k6 version differs from its lock"
[[ "$(sha256_file "$K6_BIN")" == "$LOCKED_K6_SHA" ]] || fail_toolchain "project-local k6 SHA-256 differs from its lock"
[[ "$(sha256_file "$ANVIL_BIN")" == "$(lock_column anvil-sha256 2 "$SECURITY_TOOL_LOCK")" ]] || fail_toolchain "Anvil SHA-256 differs from its lock"
[[ "$(sha256_file "$CAST_BIN")" == "$(lock_column cast-sha256 2 "$SECURITY_TOOL_LOCK")" ]] || fail_toolchain "Cast SHA-256 differs from its lock"
for binary_name in postgres initdb pg_ctl pg_isready; do
  binary_path="$POSTGRES_ROOT/bin/$binary_name"
  [[ "$(sha256_file "$binary_path")" == "$(lock_column "postgresql-$binary_name-binary-sha256" 2 "$POSTGRES_TOOL_LOCK")" ]] || \
    fail_toolchain "PostgreSQL $binary_name SHA-256 differs from its lock"
done
[[ "$("$POSTGRES_BIN" --version)" == "$(lock_column postgresql-reported-version 2 "$POSTGRES_TOOL_LOCK")" ]] || fail_toolchain "PostgreSQL version differs from its lock"
{
  printf 'RUN_ID=%s\n' "$RUN_ID"
  printf 'K6_VERSION=%s\n' "$ACTUAL_K6_VERSION"
  printf 'K6_SHA256=%s\n' "$(sha256_file "$K6_BIN")"
  printf 'ANVIL_SHA256=%s\n' "$(sha256_file "$ANVIL_BIN")"
  printf 'CAST_SHA256=%s\n' "$(sha256_file "$CAST_BIN")"
  printf 'POSTGRES_VERSION=%s\n' "$("$POSTGRES_BIN" --version)"
  printf 'POSTGRES_SHA256=%s\n' "$(sha256_file "$POSTGRES_BIN")"
} >"$REPORT_DIR/toolchain.log"
TOOLCHAIN_RC=0
write_stage_manifest

set +e
REQUIRE_FULL_READY=1 REPORT_PATH="$REPORT_DIR/preflight.json" node load/node/preflight.mjs
PREFLIGHT_RC=$?
node "$LEGACY_VALIDATOR" load-preflight "$REPORT_DIR/preflight.json"
PREFLIGHT_EVIDENCE_RC=$?
set -e
if [[ "$PREFLIGHT_RC" -ne 0 || "$PREFLIGHT_EVIDENCE_RC" -ne 0 ]]; then
  OVERALL_RC=1
  write_stage_manifest
  if [[ "$PREFLIGHT_RC" -ne 0 ]]; then exit "$PREFLIGHT_RC"; else exit "$PREFLIGHT_EVIDENCE_RC"; fi
fi
write_stage_manifest

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 ))
}

LOAD_API_PORT="${LOAD_API_PORT:-18080}"
POSTGRES_PORT="${POSTGRES_PORT:-15432}"
ANVIL_PORT="${ANVIL_PORT:-18545}"
for port in "$LOAD_API_PORT" "$POSTGRES_PORT" "$ANVIL_PORT"; do
  valid_port "$port" || { printf '%s\n' "invalid load port: $port" >&2; exit 64; }
done
LOAD_API_PORT=$((10#$LOAD_API_PORT))
POSTGRES_PORT=$((10#$POSTGRES_PORT))
ANVIL_PORT=$((10#$ANVIL_PORT))
if [[ "$LOAD_API_PORT" -eq "$POSTGRES_PORT" || "$LOAD_API_PORT" -eq "$ANVIL_PORT" || "$POSTGRES_PORT" -eq "$ANVIL_PORT" ]]; then
  printf '%s\n' 'load ports must be distinct' >&2
  exit 64
fi
for port in "$LOAD_API_PORT" "$POSTGRES_PORT" "$ANVIL_PORT"; do
  node load/node/assert-port-free.mjs "$port"
done

TEMP_BUILD="$(mktemp -d "$PROJECT_ROOT/.tools/cpredict-load-build.XXXXXX")"
set +e
./node_modules/.bin/tsc -p tsconfig.json --outDir "$TEMP_BUILD" >"$REPORT_DIR/typescript.log" 2>&1
TSC_RC=$?
set -e
if [[ "$TSC_RC" -ne 0 ]]; then OVERALL_RC=1; write_stage_manifest; exit "$TSC_RC"; fi
write_stage_manifest

POSTGRES_RUN_ROOT="$(mktemp -d /private/tmp/cpredict-load-postgres.XXXXXX)"
POSTGRES_DATA_DIR="$POSTGRES_RUN_ROOT/data"
chmod 700 "$POSTGRES_RUN_ROOT"
set +e
"$INITDB_BIN" -D "$POSTGRES_DATA_DIR" --username=cpredict_load --auth-local=trust --auth-host=trust \
  --no-locale --encoding=UTF8 >"$REPORT_DIR/postgres-initdb.log" 2>&1
initdb_rc=$?
if [[ "$initdb_rc" -eq 0 ]]; then
  "$PG_CTL_BIN" -D "$POSTGRES_DATA_DIR" -l "$REPORT_DIR/postgres.log" \
    -o "-c listen_addresses=127.0.0.1 -c port=$POSTGRES_PORT -c unix_socket_directories=$POSTGRES_RUN_ROOT -c max_connections=100 -c shared_buffers=256MB -c work_mem=4MB -c checkpoint_timeout=10min -c idle_in_transaction_session_timeout=30s -c statement_timeout=5s" \
    -w start >>"$REPORT_DIR/postgres-start.log" 2>&1
  POSTGRES_START_RC=$?
else
  POSTGRES_START_RC="$initdb_rc"
fi
set -e
if [[ "$POSTGRES_START_RC" -ne 0 ]]; then OVERALL_RC=1; write_stage_manifest; exit "$POSTGRES_START_RC"; fi
POSTGRES_STARTED=1
POSTMASTER_PID="$(sed -n '1p' "$POSTGRES_DATA_DIR/postmaster.pid")"
if [[ ! "$POSTMASTER_PID" =~ ^[0-9]+$ ]] || ! kill -0 "$POSTMASTER_PID" 2>/dev/null; then
  POSTGRES_START_RC=70
  OVERALL_RC=1
  write_stage_manifest
  exit 70
fi
write_stage_manifest

DATABASE_URL="postgresql://cpredict_load@127.0.0.1:$POSTGRES_PORT/postgres?sslmode=disable"
set +e
LOAD_DATABASE_URL="$DATABASE_URL" LOAD_DATABASE_EXPECTED_DATA_DIR="$POSTGRES_DATA_DIR" \
RUN_ID="$RUN_ID" RUN_STARTED_AT="$RUN_STARTED_AT" LOAD_CHAIN_ID=31337 \
CPREDICT_LOAD_CONFIRM="$CPREDICT_LOAD_CONFIRM" REPORT_PATH="$REPORT_DIR/production-seed.json" \
node load/production/seed-postgres.mjs 2>&1 | tee "$REPORT_DIR/production-seed.log"
seed_pipeline_status=("${PIPESTATUS[@]}")
SEED_RC=${seed_pipeline_status[0]}
SEED_LOG_RC=${seed_pipeline_status[1]}
if [[ ! -s "$REPORT_DIR/production-seed.log" ]]; then SEED_LOG_RC=66; fi
node "$EVIDENCE_VALIDATOR" seed "$REPORT_DIR/production-seed.json"
SEED_EVIDENCE_RC=$?
set -e
if [[ "$SEED_RC" -ne 0 || "$SEED_LOG_RC" -ne 0 || "$SEED_EVIDENCE_RC" -ne 0 ]]; then
  OVERALL_RC=1
  write_stage_manifest
  exit 1
fi
write_stage_manifest

"$ANVIL_BIN" --silent --port "$ANVIL_PORT" --chain-id 31337 >"$REPORT_DIR/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in {1..50}; do
  if ! kill -0 "$ANVIL_PID" 2>/dev/null; then ANVIL_READINESS_RC=70; break; fi
  block_number="$("$CAST_BIN" block-number --rpc-url "http://127.0.0.1:$ANVIL_PORT" 2>/dev/null)" || { sleep 0.1; continue; }
  chain_id="$("$CAST_BIN" chain-id --rpc-url "http://127.0.0.1:$ANVIL_PORT" 2>/dev/null)" || { sleep 0.1; continue; }
  if [[ "$block_number" == "0" && "$chain_id" == "31337" ]]; then ANVIL_READINESS_RC=0; break; fi
  ANVIL_READINESS_RC=76
  break
done
if [[ "$ANVIL_READINESS_RC" != 0 ]]; then OVERALL_RC=1; write_stage_manifest; exit "${ANVIL_READINESS_RC:-75}"; fi
write_stage_manifest

{
  printf 'RUN_ID=%s\n' "$RUN_ID"
  printf 'SPAWNED_API_PID_PENDING=true\n'
} >"$REPORT_DIR/indexer-service.log"
CPREDICT_INDEXER_HOST=127.0.0.1 \
CPREDICT_INDEXER_PORT="$LOAD_API_PORT" \
CPREDICT_INDEXER_LOG_LEVEL=warn \
CPREDICT_INDEXER_CHAIN_ID=31337 \
CPREDICT_INDEXER_RPC_URL="http://127.0.0.1:$ANVIL_PORT" \
CPREDICT_INDEXER_DATABASE_URL="$DATABASE_URL" \
CPREDICT_INDEXER_FACTORY_ADDRESS=0x00000000000000000000000000000000000000f1 \
CPREDICT_INDEXER_CORE_ADDRESSES=0x00000000000000000000000000000000000000f1,0x00000000000000000000000000000000000000f2 \
CPREDICT_INDEXER_DEPLOYMENT_BLOCK=0 \
CPREDICT_INDEXER_CONFIRMATIONS=0 \
CPREDICT_INDEXER_BATCH_SIZE=500 \
CPREDICT_INDEXER_MAX_BATCHES_PER_TICK=4 \
CPREDICT_INDEXER_POLL_INTERVAL_MS=1000 \
CPREDICT_INDEXER_RPC_TIMEOUT_MS=5000 \
CPREDICT_INDEXER_LISTEN_BACKLOG=16384 \
CPREDICT_INDEXER_HTTP_MAX_CONNECTIONS=20000 \
CPREDICT_INDEXER_WS_MAX_CONNECTIONS=12000 \
CPREDICT_INDEXER_WS_HEARTBEAT_INTERVAL_MS=15000 \
CPREDICT_INDEXER_WS_MAX_BUFFERED_AMOUNT_BYTES=65536 \
CPREDICT_INDEXER_WS_SHUTDOWN_GRACE_MS=5000 \
node "$TEMP_BUILD/offchain/indexer/src/main.js" >>"$REPORT_DIR/indexer-service.log" 2>&1 &
API_PID=$!
printf 'SPAWNED_API_PID=%s\n' "$API_PID" >>"$REPORT_DIR/indexer-service.log"
PRODUCTION_API_READINESS_RC=75
for _ in {1..100}; do
  if ! kill -0 "$API_PID" 2>/dev/null; then PRODUCTION_API_READINESS_RC=70; break; fi
  if [[ "$(curl -fsS --max-time 1 "http://127.0.0.1:$LOAD_API_PORT/readyz" 2>/dev/null)" == '{"status":"ready"}' ]]; then
    PRODUCTION_API_READINESS_RC=0
    break
  fi
  sleep 0.1
done
if [[ "$PRODUCTION_API_READINESS_RC" -ne 0 ]]; then OVERALL_RC=1; write_stage_manifest; exit "$PRODUCTION_API_READINESS_RC"; fi
write_stage_manifest

set +e
RUN_ID="$RUN_ID" TARGET_URL="http://127.0.0.1:$LOAD_API_PORT" LOAD_CHAIN_ID=31337 \
REPORT_PATH="$REPORT_DIR/production-api-smoke.json" node load/production/verify-api.mjs \
  2>&1 | tee "$REPORT_DIR/production-api-smoke.log"
smoke_pipeline_status=("${PIPESTATUS[@]}")
PRODUCTION_API_SMOKE_RC=${smoke_pipeline_status[0]}
PRODUCTION_API_SMOKE_LOG_RC=${smoke_pipeline_status[1]}
if [[ ! -s "$REPORT_DIR/production-api-smoke.log" ]]; then PRODUCTION_API_SMOKE_LOG_RC=66; fi
node "$EVIDENCE_VALIDATOR" api-smoke "$REPORT_DIR/production-api-smoke.json"
PRODUCTION_API_SMOKE_EVIDENCE_RC=$?
set -e
if [[ "$PRODUCTION_API_SMOKE_RC" -ne 0 || "$PRODUCTION_API_SMOKE_LOG_RC" -ne 0 || "$PRODUCTION_API_SMOKE_EVIDENCE_RC" -ne 0 ]]; then
  OVERALL_RC=1
  write_stage_manifest
  exit 1
fi
write_stage_manifest

set +e
"$K6_BIN" run --summary-export "$REPORT_DIR/k6-api-summary.json" \
  -e LOAD_PROFILE=full \
  -e CPREDICT_LOAD_CONFIRM="$CPREDICT_LOAD_CONFIRM" \
  -e TARGET_URL="http://127.0.0.1:$LOAD_API_PORT" \
  load/k6/api-read.js 2>&1 | tee "$REPORT_DIR/k6-api.log"
api_pipeline_status=("${PIPESTATUS[@]}")
API_RC=${api_pipeline_status[0]}
API_LOG_RC=${api_pipeline_status[1]}
if [[ ! -s "$REPORT_DIR/k6-api.log" ]]; then API_LOG_RC=66; fi
node "$EVIDENCE_VALIDATOR" k6-api "$REPORT_DIR/k6-api-summary.json"
API_EVIDENCE_RC=$?
set -e
require_stage_success 1 "$API_RC" "$API_LOG_RC" "$API_EVIDENCE_RC"
write_stage_manifest

if ! kill -0 "$API_PID" 2>/dev/null || [[ "$(curl -fsS --max-time 1 "http://127.0.0.1:$LOAD_API_PORT/readyz" 2>/dev/null)" != '{"status":"ready"}' ]]; then
  PRODUCTION_API_READINESS_RC=70
  OVERALL_RC=1
  write_stage_manifest
  exit 70
fi

set +e
RUN_ID="$RUN_ID" TARGET_URL="http://127.0.0.1:$LOAD_API_PORT" SNAPSHOT_PHASE=before \
REPORT_PATH="$REPORT_DIR/websocket-capacity-before.json" \
node load/production/capture-websocket-metrics.mjs >"$REPORT_DIR/websocket-capacity-before.log" 2>&1
WEBSOCKET_BASELINE_RC=$?
set -e
if [[ "$WEBSOCKET_BASELINE_RC" -ne 0 ]]; then
  WEBSOCKET_EVIDENCE_RC="$WEBSOCKET_BASELINE_RC"
  require_stage_success 1 "$WEBSOCKET_EVIDENCE_RC"
fi

set +e
"$K6_BIN" run --summary-export "$REPORT_DIR/k6-websocket-summary.json" \
  -e LOAD_PROFILE=full \
  -e CPREDICT_LOAD_CONFIRM="$CPREDICT_LOAD_CONFIRM" \
  -e WS_TARGET="ws://127.0.0.1:$LOAD_API_PORT/v1/stream" \
  load/k6/read-connections.js 2>&1 | tee "$REPORT_DIR/k6-websocket.log"
websocket_pipeline_status=("${PIPESTATUS[@]}")
WEBSOCKET_RC=${websocket_pipeline_status[0]}
WEBSOCKET_LOG_RC=${websocket_pipeline_status[1]}
if [[ ! -s "$REPORT_DIR/k6-websocket.log" ]]; then WEBSOCKET_LOG_RC=66; fi
RUN_ID="$RUN_ID" TARGET_URL="http://127.0.0.1:$LOAD_API_PORT" SNAPSHOT_PHASE=after \
REPORT_PATH="$REPORT_DIR/websocket-capacity-after.json" \
node load/production/capture-websocket-metrics.mjs >"$REPORT_DIR/websocket-capacity-after.log" 2>&1
WEBSOCKET_FINAL_CAPTURE_RC=$?
node "$EVIDENCE_VALIDATOR" k6-websocket "$REPORT_DIR/k6-websocket-summary.json"
WEBSOCKET_K6_EVIDENCE_RC=$?
node "$EVIDENCE_VALIDATOR" websocket-capacity \
  "$REPORT_DIR/websocket-capacity-before.json" "$REPORT_DIR/websocket-capacity-after.json"
WEBSOCKET_CAPACITY_EVIDENCE_RC=$?
set -e
if [[ "$WEBSOCKET_BASELINE_RC" -eq 0 && "$WEBSOCKET_FINAL_CAPTURE_RC" -eq 0 && \
      "$WEBSOCKET_K6_EVIDENCE_RC" -eq 0 && "$WEBSOCKET_CAPACITY_EVIDENCE_RC" -eq 0 ]]; then
  WEBSOCKET_EVIDENCE_RC=0
else
  WEBSOCKET_EVIDENCE_RC=1
fi
require_stage_success 1 "$WEBSOCKET_RC" "$WEBSOCKET_LOG_RC" "$WEBSOCKET_EVIDENCE_RC"
if ! kill -0 "$API_PID" 2>/dev/null; then PRODUCTION_API_READINESS_RC=70; OVERALL_RC=1; fi
write_stage_manifest

stop_api
stop_postgres

set +e
LOAD_PROFILE=full CPREDICT_LOAD_CONFIRM="$CPREDICT_LOAD_CONFIRM" \
CPREDICT_INDEXER_MODULE="$TEMP_BUILD/offchain/indexer/src/indexer.js" \
INDEXER_MARKETS=100 INDEXER_LISTINGS=100000 REPORT_PATH="$REPORT_DIR/indexer-synthetic.json" \
node load/indexer/benchmark.mjs
SYNTHETIC_INDEXER_RC=$?
node "$LEGACY_VALIDATOR" load-indexer "$REPORT_DIR/indexer-synthetic.json"
SYNTHETIC_INDEXER_EVIDENCE_RC=$?
set -e
require_stage_success 1 "$SYNTHETIC_INDEXER_RC" "$SYNTHETIC_INDEXER_EVIDENCE_RC"
write_stage_manifest

if [[ "$("$CAST_BIN" block-number --rpc-url "http://127.0.0.1:$ANVIL_PORT" 2>/dev/null)" != "0" ]]; then
  ANVIL_READINESS_RC=76
  OVERALL_RC=1
  write_stage_manifest
  exit 76
fi
set +e
LOAD_PROFILE=full CPREDICT_LOAD_CONFIRM="$CPREDICT_LOAD_CONFIRM" \
ANVIL_RPC_URL="http://127.0.0.1:$ANVIL_PORT" CHAIN_TPS=50 CHAIN_DURATION=600 \
REPORT_PATH="$REPORT_DIR/chain.json" node load/chain/hot-market.mjs
CHAIN_RC=$?
node "$LEGACY_VALIDATOR" load-chain "$REPORT_DIR/chain.json"
CHAIN_EVIDENCE_RC=$?
set -e
require_stage_success 1 "$CHAIN_RC" "$CHAIN_EVIDENCE_RC"
write_stage_manifest
stop_anvil

RUN_COMPLETED=1
RUN_STATUS="completed"
RUNNER_RC="$OVERALL_RC"
set +e
node load/production/write-evidence-index.mjs "$REPORT_DIR" "$RUN_ID" \
  real-production-Fastify-PostgreSQL-plus-local-chain
MANIFEST_EVIDENCE_RC=$?
set -e
if [[ "$MANIFEST_EVIDENCE_RC" -ne 0 ]]; then OVERALL_RC=1; RUNNER_RC=1; fi
write_stage_manifest
set +e
if [[ "$MANIFEST_EVIDENCE_RC" -eq 0 ]]; then
  node "$EVIDENCE_VALIDATOR" stage-manifest-structure "$REPORT_DIR/stage-exit-codes.json"
  MANIFEST_EVIDENCE_RC=$?
fi
set -e
if [[ "$MANIFEST_EVIDENCE_RC" -ne 0 ]]; then OVERALL_RC=1; RUNNER_RC=1; fi
write_stage_manifest
printf '%s\n' "Full production-composition local evidence: $REPORT_DIR"
exit "$OVERALL_RC"
