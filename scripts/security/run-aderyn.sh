#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
validator="$repo_root/scripts/security/validate-gate-evidence.mjs"
evidence_writer="$repo_root/scripts/security/write-gate-evidence.mjs"
tool_root="$(mktemp -d "${TMPDIR:-/tmp}/cpredict-aderyn.XXXXXX")"
archive="$tool_root/aderyn.tar.xz"
expected="624c6652bb9478b38ddc255c27819cd5c6cb0448f5deb72036cc9cf5a27d4aac"
url="https://github.com/Cyfrin/aderyn/releases/download/aderyn-v0.6.8/aderyn-aarch64-apple-darwin.tar.xz"
work_repo="$tool_root/repo"
run_log="$tool_root/aderyn.log"
fresh_report="$work_repo/reports/security/aderyn.json"
report="$repo_root/reports/security/aderyn.json"
log="$repo_root/reports/security/aderyn-latest.log"
validator_log="$repo_root/reports/security/aderyn-validator.log"
cleanup() { rm -rf "$tool_root"; }
trap cleanup EXIT INT TERM

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  printf '%s\n' 'The pinned Aderyn artifact is Darwin arm64 only; add and verify a platform-specific lock before running elsewhere' >&2
  exit 69
fi

curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  --output "$archive" "$url"
actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
if [[ "$actual" != "$expected" ]]; then
  printf 'Aderyn checksum mismatch: expected %s, got %s\n' "$expected" "$actual" >&2
  exit 1
fi

mkdir -p "$tool_root/extracted"
tar -xf "$archive" -C "$tool_root/extracted"
binary="$tool_root/extracted/aderyn-aarch64-apple-darwin/aderyn"

mkdir -p "$work_repo/reports/security" "$repo_root/reports/security"
cp -R "$repo_root/src" "$work_repo/"
cp "$repo_root/foundry.toml" "$repo_root/remappings.txt" "$work_repo/"
ln -s "$repo_root/lib" "$work_repo/lib"
ln -s "$repo_root/.tools" "$work_repo/.tools"

cd "$work_repo"
set +e
PATH="$repo_root/.tools/foundry/bin:$PATH" "$binary" . \
  --src src \
  --path-excludes 'lib,test,script,ref,node_modules,out,cache' \
  --skip-update-check \
  --output reports/security/aderyn.json >"$run_log" 2>&1
tool_status=$?
set -e

cp "$run_log" "$log"
validator_status=1
if [[ -f "$fresh_report" ]]; then
  cp "$fresh_report" "$report"
  set +e
  node "$validator" aderyn "$report" >"$validator_log" 2>&1
  validator_status=$?
  set -e
else
  printf '%s\n' 'Aderyn did not produce the required JSON report' >"$validator_log"
fi

evidence_args=(
  --root "$repo_root"
  --gate aderyn
  --tool aderyn
  --version 0.6.8
  --artifact-sha256 "$expected"
  --tool-exit "$tool_status"
  --accepted-tool-exits 0
  --validator-exit "$validator_status"
  --output reports/security/aderyn-evidence.json
  --input src
  --input foundry.toml
  --input remappings.txt
  --input scripts/security/run-aderyn.sh
  --input scripts/security/validate-gate-evidence.mjs
  --input scripts/security/write-gate-evidence.mjs
  --input scripts/security/verify-gate-evidence.mjs
  --evidence reports/security/aderyn-latest.log
  --evidence reports/security/aderyn-validator.log
)
if [[ -f "$report" ]]; then evidence_args+=(--evidence reports/security/aderyn.json); fi
node "$evidence_writer" "${evidence_args[@]}"

if [[ "$tool_status" -ne 0 ]]; then
  printf 'Aderyn execution failed with exit code %s; inspect %s\n' "$tool_status" "$log" >&2
  exit "$tool_status"
fi
if [[ "$validator_status" -ne 0 ]]; then
  printf 'Aderyn evidence validation failed; inspect %s\n' "$validator_log" >&2
  exit "$validator_status"
fi
printf '%s\n' 'Aderyn execution and reviewed finding inventory validated; this does not replace independent audit'
