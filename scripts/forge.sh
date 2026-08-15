#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export SVM_HOME="$repo_root/.tools/svm"
exec "$repo_root/.tools/foundry/bin/forge" "$@"

