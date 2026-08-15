#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
validator="$repo_root/scripts/security/validate-gate-evidence.mjs"
evidence_writer="$repo_root/scripts/security/write-gate-evidence.mjs"
expected="d4abcf0b3e24b7948ddfd64c374d26c3214648717777790ecb936979054a129d"
expected_z3="6a445d914dce13d8bc6ef0d7c39fb88582ff2258a28e031975b798cd62cf7af5"

solc_bin="${SOLC_BIN:-}"
if [[ -z "$solc_bin" ]]; then
  candidates=(
    "$repo_root/.tools/svm/0.8.36/solc-0.8.36"
    "${HOME:-}/Library/Application Support/svm/0.8.36/solc-0.8.36"
  )
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      solc_bin="$candidate"
      break
    fi
  done
fi

if [[ -z "$solc_bin" || ! -x "$solc_bin" ]]; then
  printf '%s\n' 'Missing exact solc 0.8.36 binary; set SOLC_BIN explicitly' >&2
  exit 1
fi
actual="$(shasum -a 256 "$solc_bin" | awk '{print $1}')"
if [[ "$actual" != "$expected" ]]; then
  printf 'solc checksum mismatch: expected %s, got %s\n' "$expected" "$actual" >&2
  exit 1
fi

z3_bin="${Z3_BIN:-$repo_root/.tools/halmos/bin/z3}"
if [[ ! -x "$z3_bin" ]]; then
  printf '%s\n' 'Missing exact project-local Z3 4.12.6 binary; set Z3_BIN explicitly' >&2
  exit 1
fi
actual_z3="$(shasum -a 256 "$z3_bin" | awk '{print $1}')"
if [[ "$actual_z3" != "$expected_z3" ]]; then
  printf 'Z3 checksum mismatch: expected %s, got %s\n' "$expected_z3" "$actual_z3" >&2
  exit 1
fi
if [[ "$($z3_bin --version)" != 'Z3 version 4.12.6 - 64 bit' ]]; then
  printf '%s\n' 'Z3 version mismatch; expected 4.12.6' >&2
  exit 1
fi

mkdir -p "$repo_root/reports/security"
stdout_path="$repo_root/reports/security/smtchecker.stdout.txt"
stderr_path="$repo_root/reports/security/smtchecker.stderr.txt"
validator_log="$repo_root/reports/security/smtchecker-validator.log"
cd "$repo_root"
set +e
PATH="$(dirname "$z3_bin"):$PATH" "$solc_bin" test/security/ProtocolMath.smt.sol \
  --model-checker-engine chc \
  --model-checker-solvers z3 \
  --model-checker-targets assert \
  --model-checker-timeout 30000 \
  --model-checker-show-proved-safe \
  >"$stdout_path" \
  2>"$stderr_path"
chc_status=$?
PATH="$(dirname "$z3_bin"):$PATH" "$solc_bin" test/security/ProtocolMath.smt.sol \
  --model-checker-engine bmc \
  --model-checker-solvers z3 \
  --model-checker-targets assert \
  --model-checker-timeout 30000 \
  --model-checker-show-proved-safe \
  >>"$stdout_path" \
  2>>"$stderr_path"
bmc_status=$?
set -e

tool_status="$chc_status"
if [[ "$tool_status" -eq 0 ]]; then tool_status="$bmc_status"; fi
set +e
node "$validator" smt "$stdout_path" "$stderr_path" >"$validator_log" 2>&1
validator_status=$?
set -e
node "$evidence_writer" \
  --root "$repo_root" \
  --gate solidity-smtchecker \
  --tool solc \
  --version 0.8.36+commit.8a079791 \
  --artifact-sha256 "$expected" \
  --tool-exit "$tool_status" \
  --accepted-tool-exits 0 \
  --validator-exit "$validator_status" \
  --output reports/security/smtchecker-evidence.json \
  --input src \
  --input test/security/ProtocolMath.smt.sol \
  --input scripts/security/run-smt.sh \
  --input scripts/security/validate-gate-evidence.mjs \
  --input scripts/security/write-gate-evidence.mjs \
  --input scripts/security/verify-gate-evidence.mjs \
  --input manifests/security-tools.lock \
  --evidence reports/security/smtchecker.stdout.txt \
  --evidence reports/security/smtchecker.stderr.txt \
  --evidence reports/security/smtchecker-validator.log

if [[ "$tool_status" -ne 0 ]]; then exit "$tool_status"; fi
if [[ "$validator_status" -ne 0 ]]; then exit "$validator_status"; fi
printf '%s\n' 'SMTChecker proved at least the 10 expected assertion conditions in both CHC and BMC engines'
