#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
report_dir="$repo_root/reports/gas-gates"
mkdir -p "$report_dir"

cd "$repo_root"
bash scripts/forge.sh test \
  --match-path test/gas/ProtocolGasGates.t.sol \
  -vv | tee "$report_dir/protocol.log"
bash scripts/test-permit2.sh \
  --match-test '^testGasGate' \
  -vv | tee "$report_dir/permit2.log"
bash scripts/forge.sh test \
  --match-path test/unit/PaymasterEdges.t.sol \
  --match-test '^testGasGate' \
  -vv | tee "$report_dir/paymaster.log"
bash scripts/forge.sh build src --sizes | tee "$report_dir/code-sizes.log"

printf '%s\n' 'All executable gas and production runtime size gates passed'
