#!/usr/bin/env bash
set -euo pipefail

if [[ "${CPREDICT_MUTATION_CONFIRM:-}" != "I_UNDERSTAND_MUTATION_RUNTIME" ]]; then
  printf '%s\n' 'Refusing full mutation: set CPREDICT_MUTATION_CONFIRM=I_UNDERSTAND_MUTATION_RUNTIME' >&2
  exit 64
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
common_runner="$repo_root/scripts/security/run-mutation-common.sh"
mutator="$repo_root/.tools/slither/bin/slither-mutate"
evidence_writer="$repo_root/scripts/security/write-gate-evidence.mjs"
evidence_verifier="$repo_root/scripts/security/verify-gate-evidence.mjs"
score_parser="$repo_root/scripts/security/parse-mutation-summary.mjs"
install_verifier="$repo_root/scripts/security/verify-slither-install.sh"
log_path="$repo_root/reports/security/mutation-full.log"
summary_path="$repo_root/reports/security/mutation-full-summary.txt"
evidence_path="$repo_root/reports/security/mutation-full-evidence.json"
slither_record_sha="1a60e3eb9e7e7b5697a19cc3a59fddd0e22a5e4540aee5c95908f1e1d5c412ec"
lock_parent="$repo_root/.tools/locks"
lock_dir="$lock_parent/mutation"
campaign_timeout_seconds="${CPREDICT_MUTATION_CAMPAIGN_TIMEOUT_SECONDS:-172800}"
post_report_timeout_seconds="${CPREDICT_MUTATION_POST_REPORT_TIMEOUT_SECONDS:-120}"
termination_grace_seconds="${CPREDICT_MUTATION_TERMINATION_GRACE_SECONDS:-10}"

# shellcheck source=scripts/security/run-mutation-common.sh
source "$common_runner"

expected_contracts=(
  BondEscrowV1
  CloneMarketVaultV1
  EmergencyControllerV1
  FeeVaultV1
  FixedPriceMarketplaceV1
  FullMarketDeployerV1
  FullMarketVaultV1
  LaunchExposureGuardV1
  MarketFactoryV1
  MarketVaultCoreV1
  ProtocolConfigV1
  SponsorshipPaymasterV1
)

# Use one exact source file per subprocess. Apart from avoiding the upstream post-report traversal
# hang, this makes a future bounded/resumable scheduler possible without weakening the requirement
# that all 12 production contracts complete in one validated aggregate.
expected_sources=(
  src/core/BondEscrowV1.sol
  src/market/CloneMarketVaultV1.sol
  src/core/EmergencyControllerV1.sol
  src/core/FeeVaultV1.sol
  src/marketplace/FixedPriceMarketplaceV1.sol
  src/core/FullMarketDeployerV1.sol
  src/market/FullMarketVaultV1.sol
  src/core/LaunchExposureGuardV1.sol
  src/core/MarketFactoryV1.sol
  src/market/MarketVaultCoreV1.sol
  src/core/ProtocolConfigV1.sol
  src/paymaster/SponsorshipPaymasterV1.sol
)

work_root=""
aggregate_log=""
current_log=""
lock_acquired=0
summary_owned=0
summary_finalized=0
log_published=0
evidence_attempted=0
evidence_written=0
tool_status=255
validator_status=1
runner_signal=""
current_contract=""
completed_contracts=0
campaign_timed_out=0
post_report_timeout=0
group_leak=0

contract_marker_present() {
  local file="$1"
  local contract="$2"
  grep -Eq -- "(^|:)Done mutating ${contract}\\.$" "$file"
}

summary_class_count() {
  local file="$1"
  local class="$2"
  awk -v class="$class" '
    index($0, ":" class " mutants:") || index($0, class " mutants:") == 1 { count += 1 }
    END { print count + 0 }
  ' "$file"
}

current_contract_report_complete() {
  [[ -f "$current_log" ]] \
    && contract_marker_present "$current_log" "$current_contract" \
    && [[ "$(summary_class_count "$current_log" Revert)" -ge 1 ]] \
    && [[ "$(summary_class_count "$current_log" Comment)" -ge 1 ]] \
    && [[ "$(summary_class_count "$current_log" Tweak)" -ge 1 ]]
}

publish_log() {
  if [[ "$log_published" -eq 1 || -z "$aggregate_log" || ! -f "$aggregate_log" ]]; then return; fi
  mutation_atomic_copy "$aggregate_log" "$log_path"
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
  stage_dir="$(mktemp -d "$repo_root/reports/security/.mutation-full-evidence.XXXXXX")"
  stage_relative="${stage_dir#"$repo_root/"}/mutation-full-evidence.json"
  staged_json="$stage_dir/mutation-full-evidence.json"
  staged_sidecar="$staged_json.sha256"

  if ! node "$evidence_writer" \
    --root "$repo_root" \
    --gate mutation-full \
    --tool slither-mutate \
    --version 0.11.6 \
    --artifact-sha256 "$slither_record_sha" \
    --tool-exit "$tool_status" \
    --accepted-tool-exits 0 \
    --validator-exit "$validator_status" \
    --output "$stage_relative" \
    --input src \
    --input test/gas \
    --input test/helpers \
    --input test/invariant \
    --input test/mocks \
    --input test/security \
    --input test/unit \
    --input test/viair \
    --input scripts/forge.sh \
    --input scripts/test-all.sh \
    --input scripts/security/run-mutation-common.sh \
    --input scripts/security/run-mutation-full.sh \
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
    --evidence reports/security/mutation-full.log \
    --evidence reports/security/mutation-full-summary.txt \
    || ! (cd "$repo_root" && node "$evidence_verifier" "$stage_relative"); then
    rm -rf -- "$stage_dir"
    return 1
  fi

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
  if [[ -n "$current_log" && -f "$current_log" && -n "$aggregate_log" ]]; then
    mutation_atomic_append_file "$current_log" "$aggregate_log" || true
    current_log=""
  fi
  if [[ "$summary_owned" -eq 1 && "$summary_finalized" -eq 0 ]]; then
    publish_log || true
    if [[ -n "$runner_signal" ]]; then
      publish_summary_line "mutation gate: FAIL (runner interrupted by $runner_signal after $completed_contracts/12 contracts; tool exit $tool_status)" || true
    else
      publish_summary_line "mutation gate: FAIL (runner exited after $completed_contracts/12 contracts before validated completion; tool exit $tool_status)" || true
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
if [[ "${#expected_contracts[@]}" -ne 12 || "${#expected_sources[@]}" -ne 12 ]]; then
  printf '%s\n' 'full mutation inventory must contain exactly 12 contract/source pairs' >&2
  exit 70
fi
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
aggregate_log="$work_root/mutation-full.log"
: >"$aggregate_log"

[[ -x "$mutator" ]] || {
  printf 'Missing project-local slither-mutate: %s\n' "$mutator" >&2
  exit 1
}
bash "$install_verifier"

mkdir -p "$work_repo/scripts" "$(dirname "$log_path")"
cp -R "$repo_root/src" "$repo_root/test" "$repo_root/script" "$work_repo/"
cp "$repo_root/scripts/forge.sh" "$repo_root/scripts/test-all.sh" "$work_repo/scripts/"
cp "$repo_root/foundry.toml" "$repo_root/remappings.txt" "$work_repo/"
ln -s "$repo_root/lib" "$work_repo/lib"
ln -s "$repo_root/.tools" "$work_repo/.tools"

export PATH="$repo_root/.tools/slither/bin:$repo_root/.tools/foundry/bin:$PATH"
export SVM_HOME="$repo_root/.tools/svm"

cd "$work_repo"
mutation_atomic_write_line "$summary_path" 'mutation gate: RUNNING (no validated result yet)'
summary_owned=1
campaign_started_at=$SECONDS

for contract_index in "${!expected_contracts[@]}"; do
  current_contract="${expected_contracts[$contract_index]}"
  current_source="${expected_sources[$contract_index]}"
  current_log="$work_root/mutation-${contract_index}-${current_contract}.log"
  final_seen_at=0
  post_report_timeout=0

  mutation_start_process "$current_log" "$mutator" "$current_source" \
    --test-cmd "bash scripts/test-all.sh" \
    --test-dir test \
    --timeout 600 \
    --output-dir "mutation_campaign/$current_contract" \
    --contract-names "$current_contract" \
    --compile-force-framework foundry \
    --foundry-compile-all \
    --comprehensive \
    --verbose

  while mutation_process_running; do
    if (( SECONDS - campaign_started_at >= campaign_timeout_seconds )); then
      campaign_timed_out=1
      mutation_terminate_process "$termination_grace_seconds"
      break
    fi
    if current_contract_report_complete; then
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
  if [[ "$MUTATION_CHILD_GROUP_LEAK" -ne 0 ]]; then group_leak=1; fi
  mutation_atomic_append_file "$current_log" "$aggregate_log"
  current_log=""

  if [[ "$campaign_timed_out" -ne 0 || "$post_report_timeout" -ne 0 || "$group_leak" -ne 0 \
    || "$tool_status" -ne 0 ]]; then
    break
  fi
  completed_contracts=$((completed_contracts + 1))
done

publish_log
summary_temp="$(mktemp "$work_root/mutation-full-summary.XXXXXX")"
parser_arguments=(
  --input "$log_path"
  --expected-contracts 12
  --threshold-percent 90
  --label 'mutation gate'
)
for contract in "${expected_contracts[@]}"; do parser_arguments+=(--expected-contract "$contract"); done
set +e
node "$score_parser" "${parser_arguments[@]}" >"$summary_temp"
score_status=$?
set -e

lifecycle_status=0
if [[ "$campaign_timed_out" -eq 1 ]]; then
  lifecycle_status=124
  printf 'tool lifecycle gate: FAIL (campaign timeout after %s seconds; %s/12 contracts complete; exit %s)\n' \
    "$campaign_timeout_seconds" "$completed_contracts" "$tool_status" >>"$summary_temp"
elif [[ "$post_report_timeout" -eq 1 ]]; then
  lifecycle_status=124
  printf 'tool lifecycle gate: FAIL (post-report timeout at %s; %s/12 contracts complete; exit %s)\n' \
    "$current_contract" "$completed_contracts" "$tool_status" >>"$summary_temp"
elif [[ "$group_leak" -ne 0 ]]; then
  lifecycle_status=125
  printf 'tool lifecycle gate: FAIL (orphan process group at %s; %s/12 contracts complete)\n' \
    "$current_contract" "$completed_contracts" >>"$summary_temp"
elif [[ "$tool_status" -ne 0 ]]; then
  lifecycle_status=$tool_status
  printf 'tool lifecycle gate: FAIL (exit %s at %s; %s/12 contracts complete)\n' \
    "$tool_status" "$current_contract" "$completed_contracts" >>"$summary_temp"
else
  printf '%s\n' 'tool lifecycle gate: PASS' >>"$summary_temp"
fi

if [[ "$completed_contracts" -eq 12 && "$score_status" -eq 0 && "$lifecycle_status" -eq 0 ]]; then
  tool_status=0
  validator_status=0
else
  validator_status=1
  if [[ "$tool_status" -eq 0 && "$completed_contracts" -ne 12 ]]; then tool_status=255; fi
fi
publish_summary_file "$summary_temp"
write_evidence

if [[ "$score_status" -ne 0 ]]; then exit "$score_status"; fi
if [[ "$lifecycle_status" -ne 0 ]]; then exit "$lifecycle_status"; fi
if [[ "$completed_contracts" -ne 12 ]]; then exit 1; fi
