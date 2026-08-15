#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
record_verifier="$repo_root/scripts/security/verify-python-record.mjs"

verify_distribution() {
  local distribution="$1"
  local version="$2"
  local expected="$3"
  local candidates=("$repo_root"/.tools/slither/lib/python*/site-packages/"${distribution}-${version}.dist-info"/RECORD)
  if [[ "${#candidates[@]}" -ne 1 || ! -f "${candidates[0]}" ]]; then
    printf 'Expected exactly one %s %s Python RECORD\n' "$distribution" "$version" >&2
    exit 1
  fi
  node "$record_verifier" "${candidates[0]}" "$expected"
}

verify_distribution slither_analyzer 0.11.6 1a60e3eb9e7e7b5697a19cc3a59fddd0e22a5e4540aee5c95908f1e1d5c412ec
verify_distribution crytic_compile 0.4.2 d4e37d6e763c747b5d4d48a3fa834bb358b7b48caaf1d84fa780e50dd0384de7
verify_distribution solc_select 1.2.0 c7c49dece16640d325251412df53f533ec722d7250c2f67e8a632f2b344ccf60

if [[ "$(shasum -a 256 "$repo_root/.tools/slither/bin/slither" | awk '{print $1}')" \
  != 'b250afc857097d248ce0bdf515b8ac7774b205b6ce805bea177139dd3c174834' ]]; then
  printf '%s\n' 'Slither launcher SHA-256 mismatch' >&2
  exit 1
fi
if [[ "$(shasum -a 256 "$repo_root/.tools/slither/bin/slither-mutate" | awk '{print $1}')" \
  != '571171d30274975c3f62122a41bb814e7d1969886ede245bfb911bffe54e2f3c' ]]; then
  printf '%s\n' 'slither-mutate launcher SHA-256 mismatch' >&2
  exit 1
fi

printf '%s\n' 'verified pinned Slither, crytic-compile, solc-select, and launcher payloads'
