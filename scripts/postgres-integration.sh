#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
postgres_tool_root="$repo_root/.tools/postgresql-17.10"
postgres_source_archive="$repo_root/.tools/postgresql-src/postgresql-17.10.tar.bz2"
postgres_lock="$repo_root/manifests/postgresql-tools.lock"
postgres_run_root=""
postgres_data_dir=""
postgres_port=""
postgres_started=0

fail_gate() {
  printf 'PostgreSQL integration gate failed: %s\n' "$1" >&2
  exit 1
}

lock_value() {
  awk -F ' \\| ' -v key="$1" '$1 == key { print $2 }' "$postgres_lock"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

cleanup_postgres() {
  original_status=$?
  trap - EXIT INT TERM
  set +e

  cleanup_status=0
  if [[ "$postgres_started" -eq 1 ]]; then
    "$postgres_tool_root/bin/pg_ctl" -D "$postgres_data_dir" -m fast -w stop
    stop_status=$?
    [[ "$stop_status" -eq 0 ]] || cleanup_status=1
  fi

  if [[ -n "$postgres_data_dir" && -d "$postgres_data_dir" ]]; then
    "$postgres_tool_root/bin/pg_ctl" -D "$postgres_data_dir" status >/dev/null 2>&1
    status_after_stop=$?
    [[ "$status_after_stop" -eq 3 ]] || cleanup_status=1
  else
    status_after_stop=3
  fi

  if [[ -n "$postgres_port" ]]; then
    "$postgres_tool_root/bin/pg_isready" \
      -h 127.0.0.1 -p "$postgres_port" -d postgres >/dev/null 2>&1
    ready_after_stop=$?
    [[ "$ready_after_stop" -eq 2 ]] || cleanup_status=1
  else
    ready_after_stop=2
  fi

  printf 'POSTGRES_STATUS_AFTER_STOP=%s\n' "$status_after_stop"
  printf 'POSTGRES_READY_AFTER_STOP=%s\n' "$ready_after_stop"

  if [[ -n "$postgres_run_root" && "$cleanup_status" -eq 0 ]]; then
    case "$postgres_run_root" in
      /private/tmp/cpredict-postgres.*)
        rm -rf -- "$postgres_run_root"
        [[ ! -e "$postgres_run_root" ]] || cleanup_status=1
        ;;
      *)
        printf 'Refusing to remove unexpected PostgreSQL temp path: %s\n' \
          "$postgres_run_root" >&2
        cleanup_status=1
        ;;
    esac
  elif [[ -n "$postgres_run_root" ]]; then
    printf 'Retaining PostgreSQL temp path after failed shutdown verification: %s\n' \
      "$postgres_run_root" >&2
  fi

  if [[ "$cleanup_status" -eq 0 ]]; then
    printf 'POSTGRES_DATA_DIRECTORY_REMOVED=true\n'
  else
    printf 'POSTGRES_DATA_DIRECTORY_REMOVED=false\n'
  fi

  if [[ "$original_status" -ne 0 ]]; then
    exit "$original_status"
  fi
  exit "$cleanup_status"
}

[[ -f "$postgres_lock" ]] || fail_gate "missing manifests/postgresql-tools.lock"
[[ -x "$postgres_tool_root/bin/postgres" ]] || fail_gate "missing project-local postgres"
[[ -x "$postgres_tool_root/bin/initdb" ]] || fail_gate "missing project-local initdb"
[[ -x "$postgres_tool_root/bin/pg_ctl" ]] || fail_gate "missing project-local pg_ctl"
[[ -f "$postgres_source_archive" ]] || fail_gate "missing verified PostgreSQL source archive"
[[ -x "$repo_root/node_modules/.bin/vitest" ]] || fail_gate "missing project-local vitest"

locked_sha256="$(lock_value postgresql-archive-sha256)"
locked_version="$(lock_value postgresql-reported-version)"
actual_sha256="$(sha256_file "$postgres_source_archive")"
actual_version="$($postgres_tool_root/bin/postgres --version)"
[[ -n "$locked_sha256" && "$actual_sha256" == "$locked_sha256" ]] || \
  fail_gate "source archive SHA-256 does not match the lock"
[[ -n "$locked_version" && "$actual_version" == "$locked_version" ]] || \
  fail_gate "postgres version does not match the lock"
for binary_name in postgres initdb pg_ctl psql pg_isready; do
  locked_binary_sha="$(lock_value "postgresql-$binary_name-binary-sha256")"
  actual_binary_sha="$(sha256_file "$postgres_tool_root/bin/$binary_name")"
  [[ -n "$locked_binary_sha" && "$actual_binary_sha" == "$locked_binary_sha" ]] || \
    fail_gate "$binary_name SHA-256 does not match the lock"
done
postgres_binary_sha="$(sha256_file "$postgres_tool_root/bin/postgres")"

postgres_run_root="$(mktemp -d /private/tmp/cpredict-postgres.XXXXXX)"
postgres_data_dir="$postgres_run_root/data"
postgres_log_file="$postgres_run_root/postgres.log"
trap cleanup_postgres EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
postgres_port="$(node -e '
  const net = require("node:net");
  const server = net.createServer();
  server.on("error", (error) => { console.error(error.message); process.exit(1); });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (typeof address !== "object" || address === null) process.exit(1);
    process.stdout.write(String(address.port));
    server.close();
  });
')"

chmod 700 "$postgres_run_root"
"$postgres_tool_root/bin/initdb" \
  -D "$postgres_data_dir" \
  --username=cpredict_test \
  --auth-local=trust \
  --auth-host=trust \
  --no-locale \
  --encoding=UTF8 \
  >"$postgres_run_root/initdb.log"
"$postgres_tool_root/bin/pg_ctl" \
  -D "$postgres_data_dir" \
  -l "$postgres_log_file" \
  -o "-c listen_addresses=127.0.0.1 -c port=$postgres_port -c unix_socket_directories=$postgres_run_root" \
  -w start
postgres_started=1

listen_addresses="$($postgres_tool_root/bin/psql \
  -h 127.0.0.1 -p "$postgres_port" -U cpredict_test -d postgres -Atc 'SHOW listen_addresses')"
[[ "$listen_addresses" == "127.0.0.1" ]] || fail_gate "postgres is not loopback-only"

printf 'POSTGRES_VERSION=%s\n' "$actual_version"
printf 'POSTGRES_ARCHIVE_SHA256=%s\n' "$actual_sha256"
printf 'POSTGRES_BINARY_SHA256=%s\n' "$postgres_binary_sha"
printf 'POSTGRES_LISTEN=%s\n' "$listen_addresses"
printf 'POSTGRES_PORT=%s\n' "$postgres_port"

test_database_url="postgresql://cpredict_test@127.0.0.1:$postgres_port/postgres?sslmode=disable"
"$repo_root/node_modules/.bin/vitest" run \
  offchain/paymaster-service/test/postgres-budget-store.test.ts \
  --maxWorkers=1 \
  --reporter=verbose \
  --reporter=json \
  --outputFile.json="$postgres_run_root/paymaster-readiness.json"
node "$repo_root/scripts/postgres-assert-vitest-report.mjs" \
  "$postgres_run_root/paymaster-readiness.json" \
  paymaster-readiness
TEST_DATABASE_URL="$test_database_url" "$repo_root/node_modules/.bin/vitest" run \
  offchain/paymaster-service/test/postgres-budget.integration.test.ts \
  --maxWorkers=1 \
  --reporter=verbose \
  --reporter=json \
  --outputFile.json="$postgres_run_root/paymaster-postgresql.json"
node "$repo_root/scripts/postgres-assert-vitest-report.mjs" \
  "$postgres_run_root/paymaster-postgresql.json" \
  paymaster-postgresql
TEST_DATABASE_URL="$test_database_url" "$repo_root/node_modules/.bin/vitest" run \
  offchain/indexer/test/postgres.integration.test.ts \
  --maxWorkers=1 \
  --reporter=verbose \
  --reporter=json \
  --outputFile.json="$postgres_run_root/indexer-postgresql.json"
node "$repo_root/scripts/postgres-assert-vitest-report.mjs" \
  "$postgres_run_root/indexer-postgresql.json" \
  indexer-postgresql

printf 'POSTGRES_GATE_TOTALS=9/9/0/0/0\n'
