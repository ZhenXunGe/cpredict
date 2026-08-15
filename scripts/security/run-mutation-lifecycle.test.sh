#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/security/run-mutation-common.sh
source "$repo_root/scripts/security/run-mutation-common.sh"

fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/cpredict-mutation-lifecycle.XXXXXX")"
exit_marker="$fixture_root/exit-marker"
cleanup() {
  printf '%s\n' exited >"$exit_marker"
  if [[ -n "${MUTATION_CHILD_PID:-}" ]]; then mutation_terminate_process 1 || true; fi
  rm -rf -- "$fixture_root"
}
trap cleanup EXIT

clean_log="$fixture_root/clean.log"
mutation_start_process "$clean_log" bash -c "printf '%s\\n' clean-exit"
mutation_wait_process
[[ "$MUTATION_CHILD_STATUS" -eq 0 ]]
[[ "$MUTATION_CHILD_GROUP_LEAK" -eq 0 ]]
[[ ! -e "$exit_marker" ]]
grep -Fxq 'clean-exit' "$clean_log"

orphan_log="$fixture_root/orphan.log"
mutation_start_process "$orphan_log" bash -c 'sleep 30 & exit 0'
orphan_group="$MUTATION_CHILD_PGID"
mutation_wait_process
[[ "$MUTATION_CHILD_STATUS" -eq 0 ]]
[[ "$MUTATION_CHILD_GROUP_LEAK" -eq 1 ]]
if mutation_process_group_alive "$orphan_group"; then
  printf '%s\n' 'orphan process group survived lifecycle cleanup' >&2
  exit 1
fi

term_log="$fixture_root/term.log"
mutation_start_process "$term_log" bash -c 'trap "" TERM; sleep 30 & wait'
term_group="$MUTATION_CHILD_PGID"
mutation_terminate_process 1
[[ "$MUTATION_CHILD_STATUS" -ne 0 ]]
if mutation_process_group_alive "$term_group"; then
  printf '%s\n' 'terminated process group survived lifecycle cleanup' >&2
  exit 1
fi

printf '%s\n' old >"$fixture_root/destination"
printf '%s\n' new >"$fixture_root/source"
mutation_atomic_copy "$fixture_root/source" "$fixture_root/destination"
grep -Fxq new "$fixture_root/destination"
mutation_atomic_write_line "$fixture_root/destination" final
grep -Fxq final "$fixture_root/destination"
printf '%s\n' appended >"$fixture_root/source"
mutation_atomic_append_file "$fixture_root/source" "$fixture_root/destination"
[[ "$(sed -n '1p' "$fixture_root/destination")" == final ]]
[[ "$(sed -n '2p' "$fixture_root/destination")" == appended ]]

set +e
mutation_require_positive_integer FIXTURE 0 >/dev/null 2>&1
invalid_status=$?
set -e
[[ "$invalid_status" -eq 64 ]]

printf '%s\n' 'mutation lifecycle fixture: PASS'
