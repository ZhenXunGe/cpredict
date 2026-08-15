#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
verifier="$repo_root/scripts/security/verify-gate-evidence.mjs"

cd "$repo_root"
node --test \
  scripts/security/parse-mutation-summary.test.mjs \
  scripts/security/validate-gate-evidence.test.mjs \
  scripts/security/scan-delivery-secrets.test.mjs \
  scripts/security/write-gate-evidence.test.mjs

required=(
  aderyn-evidence.json
  echidna-evidence.json
  echidna-x86_64-evidence.json
  halmos-evidence.json
  medusa-evidence.json
  slither-evidence.json
  smtchecker-evidence.json
  mutation-full-evidence.json
)
for evidence in "${required[@]}"; do
  node "$verifier" "reports/security/$evidence" --require-pass
done

printf '%s\n' 'all required security tool evidence is current, hash-bound, and PASS'
