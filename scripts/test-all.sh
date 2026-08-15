#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$repo_root/scripts/forge.sh" build "$repo_root/lib/permit2/src/Permit2.sol"
bash "$repo_root/scripts/forge.sh" test "$@"

