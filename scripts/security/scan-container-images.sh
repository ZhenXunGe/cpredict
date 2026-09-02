#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
trivy_bin="$repo_root/.tools/trivy/bin/trivy"
cache_root="$repo_root/.tools/trivy/cache"
postgres_image="postgres:17.10-bookworm@sha256:9b18b78397054fce88a9552e9d5a3ad5bb7fd258c5b3cc1c5028e46373d6ea8f"

[[ -x "$trivy_bin" ]] || {
  printf 'Pinned Trivy is missing; run bash scripts/security/bootstrap-trivy.sh first.\n' >&2
  exit 1
}

if [[ $# -eq 0 ]]; then
  images=(cpredict-indexer:ci cpredict-paymaster:ci cpredict-permit2-relay:ci cpredict-metadata:ci cpredict-web-demo:ci "$postgres_image")
else
  images=("$@")
fi

for image in "${images[@]}"; do
  [[ "$image" =~ ^[A-Za-z0-9._/@:-]+$ ]] || {
    printf 'Unsafe image reference: %s\n' "$image" >&2
    exit 1
  }
  printf 'Scanning %s for fixable HIGH/CRITICAL vulnerabilities.\n' "$image"
  scanner_options=()
  if [[ "$image" == "$postgres_image" ]]; then
    printf 'Applying the reviewed gosu reachability exception; PostgreSQL OS packages remain in scope.\n'
    scanner_options+=(--skip-files usr/local/bin/gosu)
  fi
  "$trivy_bin" image \
    --cache-dir "$cache_root" \
    --scanners vuln \
    --severity HIGH,CRITICAL \
    --ignore-unfixed \
    --exit-code 1 \
    --no-progress \
    --skip-version-check \
    --disable-telemetry \
    "${scanner_options[@]}" \
    "$image"
done
