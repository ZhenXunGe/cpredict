#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"

K6_VERSION="1.8.0"
ARCHIVE="k6-v${K6_VERSION}-macos-arm64.zip"
ARCHIVE_SHA256="6869e9ebdf51f7450c9ba160b5d0aa0d7224186d976bc0bc8e7ead91a7104cce"
DOWNLOAD_URL="https://github.com/grafana/k6/releases/download/v${K6_VERSION}/${ARCHIVE}"
TEMP_DIR="$(mktemp -d /tmp/cpredict-k6.XXXXXX)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT INT TERM

curl -sS -L -o "$TEMP_DIR/$ARCHIVE" "$DOWNLOAD_URL"
printf '%s  %s\n' "$ARCHIVE_SHA256" "$TEMP_DIR/$ARCHIVE" | shasum -a 256 -c -
unzip -q "$TEMP_DIR/$ARCHIVE" -d "$TEMP_DIR/extracted"
mkdir -p .tools/k6
install -m 0755 "$TEMP_DIR/extracted/k6-v${K6_VERSION}-macos-arm64/k6" .tools/k6/k6
.tools/k6/k6 version
shasum -a 256 .tools/k6/k6
