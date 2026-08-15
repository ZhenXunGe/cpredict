#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
validator="$repo_root/scripts/security/validate-gate-evidence.mjs"
evidence_writer="$repo_root/scripts/security/write-gate-evidence.mjs"
install_verifier="$repo_root/scripts/security/verify-slither-install.sh"
report="$repo_root/reports/security/slither-latest.json"
log="$repo_root/reports/security/slither-latest.log"
validator_log="$repo_root/reports/security/slither-validator.log"
evidence_root="$(mktemp -d "${TMPDIR:-/tmp}/cpredict-slither.XXXXXX")"
work_repo="$evidence_root/repo"
fresh_report="$work_repo/reports/security/slither.json"
run_log="$evidence_root/slither.log"
record_sha="1a60e3eb9e7e7b5697a19cc3a59fddd0e22a5e4540aee5c95908f1e1d5c412ec"
cleanup() { rm -rf "$evidence_root"; }
trap cleanup EXIT INT TERM

if [[ ! -x .tools/slither/bin/slither ]]; then
  printf '%s\n' 'Missing project-local Slither at .tools/slither/bin/slither' >&2
  exit 1
fi
bash "$install_verifier"

mkdir -p "$work_repo/reports/security" "$repo_root/reports/security"
cp -R "$repo_root/src" "$work_repo/"
cp "$repo_root/foundry.toml" "$repo_root/remappings.txt" "$work_repo/"
ln -s "$repo_root/lib" "$work_repo/lib"
ln -s "$repo_root/.tools" "$work_repo/.tools"

cd "$work_repo"

set +e
PATH="$repo_root/.tools/foundry/bin:$PATH" .tools/slither/bin/slither . \
  --filter-paths 'lib|test|script' \
  --exclude-dependencies \
  --json "$fresh_report" >"$run_log" 2>&1
status=$?
set -e

cp "$run_log" "$log"
validator_status=1
if [[ -f "$fresh_report" ]]; then
  cp "$fresh_report" "$report"
  set +e
  node "$validator" slither "$report" >"$validator_log" 2>&1
  validator_status=$?
  set -e
else
  printf '%s\n' 'Slither did not produce the required JSON report' >"$validator_log"
fi

evidence_args=(
  --root "$repo_root"
  --gate slither
  --tool slither-analyzer
  --version 0.11.6
  --artifact-sha256 "$record_sha"
  --tool-exit "$status"
  --accepted-tool-exits 0,255
  --validator-exit "$validator_status"
  --output reports/security/slither-evidence.json
  --input src
  --input foundry.toml
  --input remappings.txt
  --input manifests/security-tools.lock
  --input scripts/security/run-slither.sh
  --input scripts/security/validate-gate-evidence.mjs
  --input scripts/security/verify-python-record.mjs
  --input scripts/security/verify-slither-install.sh
  --input scripts/security/write-gate-evidence.mjs
  --input scripts/security/verify-gate-evidence.mjs
  --evidence reports/security/slither-latest.log
  --evidence reports/security/slither-validator.log
)
if [[ -f "$report" ]]; then evidence_args+=(--evidence reports/security/slither-latest.json); fi
node "$evidence_writer" "${evidence_args[@]}"

# Slither exits 255 when findings exist. The validated JSON is authoritative in that case;
# every other nonzero status remains an execution failure.
if [[ "$status" -ne 0 && "$status" -ne 255 ]]; then
  printf 'Slither execution failed with exit code %s; inspect %s\n' "$status" "$log" >&2
  exit "$status"
fi
if [[ "$validator_status" -ne 0 ]]; then
  printf 'Slither evidence validation failed; inspect %s\n' "$validator_log" >&2
  exit "$validator_status"
fi
printf '%s\n' 'Slither report schema and reviewed High/Medium finding baseline validated'
