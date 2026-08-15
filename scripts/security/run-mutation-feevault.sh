#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
common_runner="$repo_root/scripts/security/run-mutation-common.sh"
mutator="$repo_root/.tools/slither/bin/slither-mutate"
evidence_writer="$repo_root/scripts/security/write-gate-evidence.mjs"
evidence_verifier="$repo_root/scripts/security/verify-gate-evidence.mjs"
score_parser="$repo_root/scripts/security/parse-mutation-summary.mjs"
install_verifier="$repo_root/scripts/security/verify-slither-install.sh"
log_path="$repo_root/reports/security/mutation-feevault.log"
summary_path="$repo_root/reports/security/mutation-feevault-summary.txt"
evidence_path="$repo_root/reports/security/mutation-feevault-evidence.json"
slither_record_sha="1a60e3eb9e7e7b5697a19cc3a59fddd0e22a5e4540aee5c95908f1e1d5c412ec"
lock_parent="$repo_root/.tools/locks"
lock_dir="$lock_parent/mutation"
campaign_timeout_seconds="${CPREDICT_MUTATION_CAMPAIGN_TIMEOUT_SECONDS:-21600}"
post_report_timeout_seconds="${CPREDICT_MUTATION_POST_REPORT_TIMEOUT_SECONDS:-120}"
termination_grace_seconds="${CPREDICT_MUTATION_TERMINATION_GRACE_SECONDS:-10}"

# shellcheck source=scripts/security/run-mutation-common.sh
source "$common_runner"

work_root=""
run_log=""
lock_acquired=0
summary_owned=0
summary_finalized=0
log_published=0
evidence_attempted=0
evidence_written=0
tool_status=255
validator_status=1
runner_signal=""

contract_marker_present() {
  local file="$1"
  grep -Eq -- '(^|:)Done mutating FeeVaultV1\.$' "$file"
}

summary_class_count() {
  local file="$1"
  local class="$2"
  awk -v class="$class" '
    index($0, ":" class " mutants:") || index($0, class " mutants:") == 1 { count += 1 }
    END { print count + 0 }
  ' "$file"
}

all_expected_summaries_seen() {
  [[ -f "$run_log" ]] \
    && [[ "$(summary_class_count "$run_log" Revert)" -ge 1 ]] \
    && [[ "$(summary_class_count "$run_log" Comment)" -ge 1 ]] \
    && [[ "$(summary_class_count "$run_log" Tweak)" -ge 1 ]]
}

publish_log() {
  if [[ "$log_published" -eq 1 || -z "$run_log" || ! -f "$run_log" ]]; then return; fi
  mutation_atomic_copy "$run_log" "$log_path"
  log_published=1
}

publish_summary_line() {
  mutation_atomic_write_line "$summary_path" "$1"
  summary_finalized=1
}

publish_summary_file() {
  mutation_atomic_copy "$1" "$summary_path"
  summary_finalized=1
}

write_evidence() {
  local stage_dir stage_relative staged_json staged_sidecar
  if [[ "$evidence_attempted" -eq 1 || ! -f "$log_path" || ! -f "$summary_path" ]]; then return; fi
  evidence_attempted=1
  stage_dir="$(mktemp -d "$repo_root/reports/security/.mutation-feevault-evidence.XXXXXX")"
  stage_relative="${stage_dir#"$repo_root/"}/mutation-feevault-evidence.json"
  staged_json="$stage_dir/mutation-feevault-evidence.json"
  staged_sidecar="$staged_json.sha256"

  if ! node "$evidence_writer" \
    --root "$repo_root" \
    --gate mutation-feevault \
    --tool slither-mutate \
    --version 0.11.6 \
    --artifact-sha256 "$slither_record_sha" \
    --tool-exit "$tool_status" \
    --accepted-tool-exits 0 \
    --validator-exit "$validator_status" \
    --output "$stage_relative" \
    --input src/core/FeeVaultV1.sol \
    --input test/unit \
    --input scripts/forge.sh \
    --input scripts/security/run-mutation-common.sh \
    --input scripts/security/run-mutation-feevault.sh \
    --input scripts/security/run-mutation-lifecycle.test.sh \
    --input scripts/security/parse-mutation-summary.mjs \
    --input scripts/security/parse-mutation-summary.test.mjs \
    --input scripts/security/write-gate-evidence.mjs \
    --input scripts/security/verify-gate-evidence.mjs \
    --input scripts/security/verify-python-record.mjs \
    --input scripts/security/verify-slither-install.sh \
    --input manifests/security-tools.lock \
    --input foundry.toml \
    --input remappings.txt \
    --evidence reports/security/mutation-feevault.log \
    --evidence reports/security/mutation-feevault-summary.txt \
    || ! (cd "$repo_root" && node "$evidence_verifier" "$stage_relative"); then
    rm -rf -- "$stage_dir"
    return 1
  fi

  # Publish the sidecar first and the JSON last. Any observer racing these two renames fails closed
  # on a hash mismatch; no observer can validate a mixed pair as PASS.
  mv -f -- "$staged_sidecar" "$evidence_path.sha256"
  mv -f -- "$staged_json" "$evidence_path"
  rmdir "$stage_dir"
  evidence_written=1
}

cleanup() {
  local exit_status=$?
  trap - EXIT
  trap '' INT TERM HUP

  if [[ -n "${MUTATION_CHILD_PID:-}" ]]; then
    mutation_terminate_process "$termination_grace_seconds" || true
    tool_status=$MUTATION_CHILD_STATUS
  fi
  if [[ "$summary_owned" -eq 1 && "$summary_finalized" -eq 0 ]]; then
    publish_log || true
    if [[ -n "$runner_signal" ]]; then
      publish_summary_line "bounded mutation gate: FAIL (runner interrupted by $runner_signal; tool exit $tool_status)" || true
    else
      publish_summary_line "bounded mutation gate: FAIL (runner exited before validated completion; tool exit $tool_status)" || true
    fi
  fi
  if [[ "$summary_owned" -eq 1 && -f "$log_path" && -f "$summary_path" ]]; then
    write_evidence || true
  fi
  if [[ -n "$work_root" ]]; then rm -rf -- "$work_root" || true; fi
  if [[ "$lock_acquired" -eq 1 ]]; then rmdir "$lock_dir" 2>/dev/null || true; fi
  return "$exit_status"
}

handle_signal() {
  runner_signal="$1"
  exit "$2"
}

mutation_require_positive_integer CPREDICT_MUTATION_CAMPAIGN_TIMEOUT_SECONDS "$campaign_timeout_seconds"
mutation_require_positive_integer CPREDICT_MUTATION_POST_REPORT_TIMEOUT_SECONDS "$post_report_timeout_seconds"
mutation_require_positive_integer CPREDICT_MUTATION_TERMINATION_GRACE_SECONDS "$termination_grace_seconds"
trap cleanup EXIT
trap 'handle_signal INT 130' INT
trap 'handle_signal TERM 143' TERM
trap 'handle_signal HUP 129' HUP

mkdir -p "$lock_parent"
if ! mkdir "$lock_dir"; then
  printf 'Refusing concurrent mutation campaign; lock exists: %s\n' "$lock_dir" >&2
  exit 75
fi
lock_acquired=1
work_root="$(mktemp -d)"
work_repo="$work_root/repo"
run_log="$work_root/mutation-feevault.log"

[[ -x "$mutator" ]] || {
  printf 'Missing project-local slither-mutate: %s\n' "$mutator" >&2
  exit 1
}
bash "$install_verifier"

mkdir -p "$work_repo" "$(dirname "$log_path")"
cp -R "$repo_root/src" "$repo_root/test" "$repo_root/script" "$work_repo/"
mkdir -p "$work_repo/scripts"
cp "$repo_root/scripts/forge.sh" "$work_repo/scripts/forge.sh"
cp "$repo_root/foundry.toml" "$repo_root/remappings.txt" "$work_repo/"
ln -s "$repo_root/lib" "$work_repo/lib"
ln -s "$repo_root/.tools" "$work_repo/.tools"

export PATH="$repo_root/.tools/slither/bin:$repo_root/.tools/foundry/bin:$PATH"
export SVM_HOME="$repo_root/.tools/svm"

cd "$work_repo"
mutation_atomic_write_line "$summary_path" 'bounded mutation gate: RUNNING (no validated result yet)'
summary_owned=1

# Passing the exact source file prevents slither-mutate from continuing through unrelated Solidity
# files after FeeVaultV1 has emitted its final report (the cause of the prior post-report hang).
mutation_start_process "$run_log" "$mutator" src/core/FeeVaultV1.sol \
  --test-cmd "bash scripts/forge.sh test --match-contract 'VaultControlComponentsTest|FeeVaultMutationResistanceTest'" \
  --test-dir test \
  --timeout 180 \
  --output-dir mutation_campaign/FeeVaultV1 \
  --contract-names FeeVaultV1 \
  --compile-force-framework foundry \
  --foundry-compile-all \
  --comprehensive \
  --verbose

campaign_started_at=$SECONDS
final_seen_at=0
post_report_timeout=0
campaign_timed_out=0
while mutation_process_running; do
  if (( SECONDS - campaign_started_at >= campaign_timeout_seconds )); then
    campaign_timed_out=1
    mutation_terminate_process "$termination_grace_seconds"
    break
  fi
  if contract_marker_present "$run_log" && all_expected_summaries_seen; then
    if [[ "$final_seen_at" -eq 0 ]]; then
      final_seen_at=$SECONDS
    elif (( SECONDS - final_seen_at >= post_report_timeout_seconds )); then
      post_report_timeout=1
      mutation_terminate_process "$termination_grace_seconds"
      break
    fi
  fi
  sleep 2
done
if [[ -n "${MUTATION_CHILD_PID:-}" ]]; then mutation_wait_process; fi
tool_status=$MUTATION_CHILD_STATUS
group_leak=$MUTATION_CHILD_GROUP_LEAK
publish_log

summary_temp="$(mktemp "$work_root/mutation-feevault-summary.XXXXXX")"
set +e
node "$score_parser" \
  --input "$log_path" \
  --expected-contracts 1 \
  --expected-contract FeeVaultV1 \
  --threshold-percent 90 \
  --label 'bounded mutation gate' >"$summary_temp"
score_status=$?
set -e

lifecycle_status=0
if [[ "$campaign_timed_out" -eq 1 ]]; then
  lifecycle_status=124
  printf 'tool lifecycle gate: FAIL (campaign timeout after %s seconds; exit %s)\n' \
    "$campaign_timeout_seconds" "$tool_status" >>"$summary_temp"
elif [[ "$post_report_timeout" -eq 1 ]]; then
  lifecycle_status=124
  printf 'tool lifecycle gate: FAIL (post-report timeout; exit %s)\n' "$tool_status" >>"$summary_temp"
elif [[ "$group_leak" -ne 0 ]]; then
  lifecycle_status=125
  printf 'tool lifecycle gate: FAIL (orphan process group after exit %s)\n' "$tool_status" >>"$summary_temp"
elif [[ "$tool_status" -ne 0 ]]; then
  lifecycle_status=$tool_status
  printf 'tool lifecycle gate: FAIL (exit %s)\n' "$tool_status" >>"$summary_temp"
else
  printf '%s\n' 'tool lifecycle gate: PASS' >>"$summary_temp"
fi

if [[ "$score_status" -eq 0 && "$lifecycle_status" -eq 0 ]]; then validator_status=0; else validator_status=1; fi
publish_summary_file "$summary_temp"
write_evidence

if [[ "$score_status" -ne 0 ]]; then exit "$score_status"; fi
if [[ "$lifecycle_status" -ne 0 ]]; then
  printf 'slither-mutate lifecycle failed with status %s; see %s\n' "$lifecycle_status" "$log_path" >&2
  exit "$lifecycle_status"
fi
