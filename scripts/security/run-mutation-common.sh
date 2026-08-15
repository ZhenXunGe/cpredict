#!/usr/bin/env bash

# Shared fail-closed lifecycle helpers for the mutation runners. This file is sourced by the
# bounded and whole-protocol entrypoints; it is not an executable gate on its own.

MUTATION_CHILD_PID=""
MUTATION_CHILD_PGID=""
MUTATION_CHILD_STATUS=255
MUTATION_CHILD_GROUP_LEAK=0

mutation_require_positive_integer() {
  local name="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    printf '%s must be a positive integer, got %s\n' "$name" "$value" >&2
    return 64
  fi
}

mutation_process_group_alive() {
  local pgid="${1:-}"
  [[ -n "$pgid" ]] && kill -0 -- "-$pgid" 2>/dev/null
}

mutation_kill_group_and_wait() {
  local pgid="$1"
  local attempt=0
  if ! mutation_process_group_alive "$pgid"; then return 0; fi
  kill -KILL -- "-$pgid" 2>/dev/null || true
  while (( attempt < 50 )); do
    if ! mutation_process_group_alive "$pgid"; then return 0; fi
    sleep 0.1
    attempt=$((attempt + 1))
  done
  return 1
}

mutation_start_process() {
  local output_path="$1"
  shift
  if [[ -n "${MUTATION_CHILD_PID:-}" ]]; then
    printf '%s\n' 'refusing to start a second mutation child before reaping the first' >&2
    return 70
  fi

  # Monitor mode gives the background command its own process group on macOS Bash 3.2. The
  # runner can then terminate slither-mutate and every Forge/shell descendant as one unit. The
  # wrapper clears traps only inside the child before exec; the parent keeps signal/EXIT cleanup
  # active for the whole campaign.
  set -m
  (trap - EXIT INT TERM HUP; exec "$@") >"$output_path" 2>&1 &
  MUTATION_CHILD_PID=$!
  MUTATION_CHILD_PGID=$MUTATION_CHILD_PID
  set +m
  MUTATION_CHILD_STATUS=255
  MUTATION_CHILD_GROUP_LEAK=0

  if ! mutation_process_group_alive "$MUTATION_CHILD_PGID" \
    && kill -0 "$MUTATION_CHILD_PID" 2>/dev/null; then
    printf 'mutation child did not acquire an isolated process group: %s\n' "$MUTATION_CHILD_PID" >&2
    kill -TERM "$MUTATION_CHILD_PID" 2>/dev/null || true
    set +e
    wait "$MUTATION_CHILD_PID" 2>/dev/null
    MUTATION_CHILD_STATUS=$?
    set -e
    MUTATION_CHILD_PID=""
    MUTATION_CHILD_PGID=""
    return 70
  fi
}

mutation_process_running() {
  [[ -n "${MUTATION_CHILD_PID:-}" ]] && kill -0 "$MUTATION_CHILD_PID" 2>/dev/null
}

mutation_wait_process() {
  local pid="${MUTATION_CHILD_PID:-}"
  local pgid="${MUTATION_CHILD_PGID:-}"
  local status
  if [[ -z "$pid" ]]; then return 0; fi

  set +e
  wait "$pid"
  status=$?
  set -e
  MUTATION_CHILD_STATUS=$status
  MUTATION_CHILD_PID=""

  # A nominally exited parent that leaves a descendant behind is a lifecycle failure. Kill the
  # isolated group so a stale Forge process cannot mutate or append to later evidence.
  if mutation_process_group_alive "$pgid"; then
    MUTATION_CHILD_GROUP_LEAK=1
    mutation_kill_group_and_wait "$pgid" || true
  fi
  MUTATION_CHILD_PGID=""
}

mutation_terminate_process() {
  local grace_seconds="$1"
  local pid="${MUTATION_CHILD_PID:-}"
  local pgid="${MUTATION_CHILD_PGID:-}"
  local watchdog_pid=""
  local status
  if [[ -z "$pid" ]]; then return 0; fi
  mutation_require_positive_integer MUTATION_TERMINATION_GRACE_SECONDS "$grace_seconds"

  if mutation_process_group_alive "$pgid"; then
    kill -TERM -- "-$pgid" 2>/dev/null || true
  else
    kill -TERM "$pid" 2>/dev/null || true
  fi

  # Bound wait(1) even when the Python parent or a descendant ignores TERM.
  (
    # EXIT traps are inherited by command-group subshells on Bash 3.2. Never let this watchdog run
    # the parent runner's evidence/lock/worktree cleanup.
    trap - EXIT INT TERM HUP
    sleep "$grace_seconds"
    if mutation_process_group_alive "$pgid"; then
      kill -KILL -- "-$pgid" 2>/dev/null || true
    else
      kill -KILL "$pid" 2>/dev/null || true
    fi
  ) &
  watchdog_pid=$!

  set +e
  wait "$pid"
  status=$?
  kill -TERM "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null
  set -e

  if mutation_process_group_alive "$pgid"; then
    MUTATION_CHILD_GROUP_LEAK=1
    mutation_kill_group_and_wait "$pgid" || true
  fi
  MUTATION_CHILD_STATUS=$status
  MUTATION_CHILD_PID=""
  MUTATION_CHILD_PGID=""
}

mutation_atomic_copy() {
  local source_path="$1"
  local destination_path="$2"
  local temporary_path="${destination_path}.tmp.$$.$RANDOM"
  if ! cp "$source_path" "$temporary_path"; then
    rm -f -- "$temporary_path"
    return 1
  fi
  if ! mv -f -- "$temporary_path" "$destination_path"; then
    rm -f -- "$temporary_path"
    return 1
  fi
}

mutation_atomic_write_line() {
  local destination_path="$1"
  local content="$2"
  local temporary_path="${destination_path}.tmp.$$.$RANDOM"
  if ! printf '%s\n' "$content" >"$temporary_path"; then
    rm -f -- "$temporary_path"
    return 1
  fi
  if ! mv -f -- "$temporary_path" "$destination_path"; then
    rm -f -- "$temporary_path"
    return 1
  fi
}

mutation_atomic_append_file() {
  local source_path="$1"
  local destination_path="$2"
  local temporary_path="${destination_path}.tmp.$$.$RANDOM"
  if [[ -f "$destination_path" ]]; then
    if ! { cat "$destination_path"; cat "$source_path"; } >"$temporary_path"; then
      rm -f -- "$temporary_path"
      return 1
    fi
  elif ! cp "$source_path" "$temporary_path"; then
    rm -f -- "$temporary_path"
    return 1
  fi
  if ! mv -f -- "$temporary_path" "$destination_path"; then
    rm -f -- "$temporary_path"
    return 1
  fi
}
