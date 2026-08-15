#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
parser="$repo_root/scripts/security/parse-mutation-summary.mjs"
writer="$repo_root/scripts/security/write-gate-evidence.mjs"
verifier="$repo_root/scripts/security/verify-gate-evidence.mjs"
log_path="$repo_root/reports/security/mutation-feevault.log"
summary_path="$repo_root/reports/security/mutation-feevault-summary.txt"
prior_evidence="$repo_root/reports/security/mutation-feevault-pre-refinalization-evidence.json"
prior_evidence_sidecar="$repo_root/reports/security/mutation-feevault-pre-refinalization-evidence.json.sha256"
prior_summary="$repo_root/reports/security/mutation-feevault-pre-refinalization-summary.txt"
expected_log_sha="2d0bc7743cb2742ef96fcb421b3a18eec5a92f3e47aeed677140f4e8b01e329f"
expected_prior_evidence_sha="c0fde4c914d11b0a31b4bf3751f699e93fd528bf6878a89767c330b974d83604"
expected_prior_summary_sha="9dd0fda63d8bc5747319103ddce94d5da9fbf567cb8c1df7464064d9c4259df5"
slither_record_sha="1a60e3eb9e7e7b5697a19cc3a59fddd0e22a5e4540aee5c95908f1e1d5c412ec"

sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
require_sha() {
  local path="$1"
  local expected="$2"
  [[ -f "$path" ]] || { printf 'missing retained evidence: %s\n' "$path" >&2; exit 1; }
  local actual
  actual="$(sha256 "$path")"
  [[ "$actual" == "$expected" ]] || {
    printf 'retained evidence hash mismatch for %s: expected %s, got %s\n' "$path" "$expected" "$actual" >&2
    exit 1
  }
}

if [[ -e "$repo_root/.tools/locks/mutation" ]]; then
  printf '%s\n' 'refusing parser-only re-finalization while a mutation campaign lock exists' >&2
  exit 75
fi
require_sha "$log_path" "$expected_log_sha"
require_sha "$prior_evidence" "$expected_prior_evidence_sha"
require_sha "$prior_summary" "$expected_prior_summary_sha"

node -e '
  const fs = require("fs");
  const document = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (document.result !== "FAIL" || document.tool?.rawExitCode !== 143 || document.validatorExitCode !== 2) process.exit(1);
' "$prior_evidence"

mkdir -p "$(dirname "$summary_path")"
temporary_summary="$(mktemp "${TMPDIR:-/tmp}/cpredict-mutation-refinalize.XXXXXX")"
cleanup() { rm -f -- "$temporary_summary"; }
trap cleanup EXIT INT TERM

node "$parser" \
  --input "$log_path" \
  --expected-contracts 1 \
  --expected-contract FeeVaultV1 \
  --threshold-percent 90 \
  --label 'bounded mutation gate' >"$temporary_summary"
printf '%s\n' 'tool lifecycle gate: FAIL (post-report timeout; exit 143)' >>"$temporary_summary"
printf '%s\n' 'evidence finalization: parser-only replay of retained canonical log; mutator not rerun' >>"$temporary_summary"
mv "$temporary_summary" "$summary_path"

cd "$repo_root"
node "$writer" \
  --root "$repo_root" \
  --gate mutation-feevault \
  --tool slither-mutate \
  --version 0.11.6 \
  --artifact-sha256 "$slither_record_sha" \
  --tool-exit 143 \
  --accepted-tool-exits 0 \
  --validator-exit 0 \
  --output reports/security/mutation-feevault-evidence.json \
  --input src/core/FeeVaultV1.sol \
  --input test/unit \
  --input scripts/forge.sh \
  --input scripts/security/parse-mutation-summary.mjs \
  --input scripts/security/parse-mutation-summary.test.mjs \
  --input scripts/security/refinalize-mutation-feevault-evidence.sh \
  --input scripts/security/run-mutation-common.sh \
  --input scripts/security/run-mutation-feevault.sh \
  --input scripts/security/run-mutation-lifecycle.test.sh \
  --input scripts/security/write-gate-evidence.mjs \
  --input scripts/security/verify-gate-evidence.mjs \
  --input scripts/security/verify-python-record.mjs \
  --input scripts/security/verify-slither-install.sh \
  --input manifests/security-tools.lock \
  --input foundry.toml \
  --input remappings.txt \
  --evidence reports/security/mutation-feevault.log \
  --evidence reports/security/mutation-feevault-summary.txt \
  --evidence reports/security/mutation-feevault-pre-refinalization-evidence.json \
  --evidence reports/security/mutation-feevault-pre-refinalization-evidence.json.sha256 \
  --evidence reports/security/mutation-feevault-pre-refinalization-summary.txt \
  --evidence reports/security/mutation-feevault-refinalization.md

node "$verifier" reports/security/mutation-feevault-evidence.json
set +e
node "$verifier" reports/security/mutation-feevault-evidence.json --require-pass >/dev/null 2>&1
require_pass_status=$?
set -e
if [[ "$require_pass_status" -ne 1 ]]; then
  printf 'expected require-pass rc 1 for lifecycle failure, got %s\n' "$require_pass_status" >&2
  exit 1
fi
printf '%s\n' 'parser-only FeeVault mutation evidence re-finalized; gate remains FAIL due to tool exit 143'
