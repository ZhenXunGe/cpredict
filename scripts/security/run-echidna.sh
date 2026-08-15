#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
validator="$repo_root/scripts/security/validate-gate-evidence.mjs"
evidence_writer="$repo_root/scripts/security/write-gate-evidence.mjs"
tool_root="$(mktemp -d "${TMPDIR:-/tmp}/cpredict-echidna.XXXXXX")"
archive="$tool_root/echidna.tar.gz"
expected="8e16a43d8c37b74365ef259ea986e074b8a717309f770c7ff3d1f9fb891a7902"
url="https://github.com/crytic/echidna/releases/download/v2.3.3/echidna-2.3.3-aarch64-macos.tar.gz"
log="$repo_root/reports/security/echidna-latest.log"
validator_log="$repo_root/reports/security/echidna-validator.log"
work_repo="$tool_root/repo"
run_log="$tool_root/echidna.log"
cleanup() { rm -rf "$tool_root"; }
trap cleanup EXIT INT TERM

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  printf '%s\n' 'The pinned Echidna artifact is Darwin arm64 only; add and verify a platform-specific lock before running elsewhere' >&2
  exit 69
fi

curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  --output "$archive" "$url"
actual="$(shasum -a 256 "$archive" | awk '{print $1}')"
if [[ "$actual" != "$expected" ]]; then
  printf 'Echidna checksum mismatch: expected %s, got %s\n' "$expected" "$actual" >&2
  exit 1
fi

tar -xzf "$archive" -C "$tool_root"
mkdir -p "$work_repo/scripts/security" "$work_repo/reports/security" "$repo_root/reports/security"
cp -R "$repo_root/src" "$repo_root/test" "$repo_root/script" "$work_repo/"
cp "$repo_root/scripts/forge.sh" "$work_repo/scripts/forge.sh"
cp "$repo_root/scripts/security/echidna.yaml" "$work_repo/scripts/security/echidna.yaml"
cp "$repo_root/foundry.toml" "$repo_root/remappings.txt" "$work_repo/"
ln -s "$repo_root/lib" "$work_repo/lib"
ln -s "$repo_root/.tools" "$work_repo/.tools"

cd "$work_repo"
set +e
PATH="$repo_root/.tools/slither/bin:$repo_root/.tools/foundry/bin:$PATH" \
  "$tool_root/echidna" test/security/EchidnaMarketAccounting.sol \
  --contract EchidnaMarketAccounting \
  --config scripts/security/echidna.yaml \
  --format text >"$run_log" 2>&1
status=$?
set -e

cp "$run_log" "$log"
set +e
node "$validator" echidna "$log" >"$validator_log" 2>&1
validator_status=$?
set -e
node "$evidence_writer" \
  --root "$repo_root" \
  --gate echidna \
  --tool echidna \
  --version 2.3.3 \
  --artifact-sha256 "$expected" \
  --tool-exit "$status" \
  --accepted-tool-exits 0 \
  --validator-exit "$validator_status" \
  --output reports/security/echidna-evidence.json \
  --input src \
  --input test/security/EchidnaMarketAccounting.sol \
  --input test/mocks \
  --input scripts/security/echidna.yaml \
  --input scripts/security/run-echidna.sh \
  --input scripts/security/validate-gate-evidence.mjs \
  --input scripts/security/write-gate-evidence.mjs \
  --input scripts/security/verify-gate-evidence.mjs \
  --input foundry.toml \
  --input remappings.txt \
  --evidence reports/security/echidna-latest.log \
  --evidence reports/security/echidna-validator.log

if [[ $status -ne 0 ]]; then
  printf 'Echidna execution failed with exit code %s; inspect %s\n' "$status" "$log" >&2
  exit "$status"
fi
if [[ $validator_status -ne 0 ]]; then
  printf 'Echidna evidence validation failed; inspect %s\n' "$validator_log" >&2
  exit "$validator_status"
fi
printf 'Echidna million-call gate passed with the exact four-property inventory; evidence: %s\n' "$log"
