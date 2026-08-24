#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Permit2's pinned 0.8.17 implementation and the canonical fifteen-field EIP-712 reference
# vector require viaIR in legacy codegen. Gas thresholds are likewise meaningful only for the
# production viaIR build and are enforced separately by scripts/gas-gates.sh. The protocol
# sources and all non-gas behavioral tests are compiled and executed through non-IR here.
FOUNDRY_PROFILE=non_ir bash "$repo_root/scripts/forge.sh" build "$repo_root/src"
FOUNDRY_PROFILE=non_ir bash "$repo_root/scripts/forge.sh" test \
    --no-match-path 'test/{unit/Permit2Flows.t.sol,viair/*.t.sol}' \
    --no-match-test '^testGasGate' \
    "$@"
