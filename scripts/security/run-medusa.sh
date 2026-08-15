#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
validator="$repo_root/scripts/security/validate-gate-evidence.mjs"
evidence_writer="$repo_root/scripts/security/write-gate-evidence.mjs"
tool_root="$(mktemp -d "${TMPDIR:-/tmp}/cpredict-medusa.XXXXXX")"
archive="$tool_root/medusa.tar.gz"
expected="a8b38bbd07a60f51e1b96304db58dba441b5053d7a61d1749458f3f7eaf5d3ce"
url="https://github.com/crytic/medusa/releases/download/v1.5.1/medusa-mac-arm64.tar.gz"
log="$repo_root/reports/security/medusa-latest.log"
coverage="$repo_root/reports/security/medusa-latest.lcov"
validator_log="$repo_root/reports/security/medusa-validator.log"
work_repo="$tool_root/repo"
run_log="$tool_root/medusa.log"
fresh_coverage="$work_repo/reports/security/medusa-corpus/coverage/lcov.info"
cleanup() { rm -rf "$tool_root"; }
trap cleanup EXIT INT TERM

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  printf '%s\n' 'The pinned Medusa artifact is Darwin arm64 only; add and verify a platform-specific lock before running elsewhere' >&2
  exit 69
fi

if [[ -n "${MEDUSA_ARCHIVE:-}" ]]; then
  cp "$MEDUSA_ARCHIVE" "$archive"
else
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    --output "$archive" "$url"
fi
actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
if [[ "$actual" != "$expected" ]]; then
  printf 'Medusa checksum mismatch: expected %s, got %s\n' "$expected" "$actual" >&2
  exit 1
fi

tar -xzf "$archive" -C "$tool_root"
mkdir -p "$work_repo/scripts/security" "$work_repo/reports/security" "$repo_root/reports/security"
cp -R "$repo_root/src" "$repo_root/test" "$repo_root/script" "$work_repo/"
cp "$repo_root/scripts/forge.sh" "$work_repo/scripts/forge.sh"
cp "$repo_root/scripts/security/medusa.json" "$work_repo/scripts/security/medusa.json"
cp "$repo_root/foundry.toml" "$repo_root/remappings.txt" "$work_repo/"
ln -s "$repo_root/lib" "$work_repo/lib"
ln -s "$repo_root/.tools" "$work_repo/.tools"

cd "$work_repo"
set +e
PATH="$repo_root/.tools/slither/bin:$repo_root/.tools/foundry/bin:$PATH" \
  "$tool_root/medusa" fuzz --config scripts/security/medusa.json --no-color >"$run_log" 2>&1
status=$?
set -e

cp "$run_log" "$log"
validator_status=1
if [[ -f "$fresh_coverage" ]]; then
  cp "$fresh_coverage" "$coverage"
  set +e
  node "$validator" medusa "$log" "$coverage" >"$validator_log" 2>&1
  validator_status=$?
  set -e
else
  printf '%s\n' 'Medusa did not produce the required LCOV evidence' >"$validator_log"
fi

evidence_args=(
  --root "$repo_root"
  --gate medusa
  --tool medusa
  --version 1.5.1
  --artifact-sha256 "$expected"
  --tool-exit "$status"
  --accepted-tool-exits 0
  --validator-exit "$validator_status"
  --output reports/security/medusa-evidence.json
  --input src
  --input test/security/EchidnaMarketAccounting.sol
  --input test/mocks
  --input scripts/security/medusa.json
  --input scripts/security/run-medusa.sh
  --input scripts/security/validate-gate-evidence.mjs
  --input scripts/security/write-gate-evidence.mjs
  --input scripts/security/verify-gate-evidence.mjs
  --input foundry.toml
  --input remappings.txt
  --evidence reports/security/medusa-latest.log
  --evidence reports/security/medusa-validator.log
)
if [[ -f "$coverage" ]]; then evidence_args+=(--evidence reports/security/medusa-latest.lcov); fi
node "$evidence_writer" "${evidence_args[@]}"

if [[ $status -ne 0 ]]; then
  printf 'Medusa execution failed with exit code %s; inspect %s\n' "$status" "$log" >&2
  exit "$status"
fi
if [[ $validator_status -ne 0 ]]; then
  printf 'Medusa evidence validation failed; inspect %s\n' "$validator_log" >&2
  exit "$validator_status"
fi
printf 'Medusa million-call gate passed with the exact 27-test inventory; evidence: %s\n' "$log"
