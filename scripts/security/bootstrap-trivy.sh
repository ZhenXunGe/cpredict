#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tool_root="$repo_root/.tools/trivy"
trivy_bin="$tool_root/bin/trivy"
expected_version="0.73.0"

if [[ -x "$trivy_bin" ]]; then
  version_output="$($trivy_bin --version)"
  if [[ "$version_output" == *"Version: $expected_version"* ]]; then
    printf 'Trivy %s already verified.\n' "$expected_version"
    exit 0
  fi
  printf 'Trivy exists at %s but does not match the pinned version; refusing to overwrite it.\n' "$trivy_bin" >&2
  exit 1
fi

case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    archive_name="trivy_0.73.0_macOS-ARM64.tar.gz"
    archive_sha256="80cc25faaf6378e37701202d0b4f9f43d9e413d198d594ba60fdf559fe44a683"
    ;;
  Linux:x86_64)
    archive_name="trivy_0.73.0_Linux-64bit.tar.gz"
    archive_sha256="2edd39da482bb4e9831962487b68f68e3928ec3137794757f54d00383d79547b"
    ;;
  *)
    printf 'Unsupported Trivy bootstrap platform: %s/%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

release_url="https://github.com/aquasecurity/trivy/releases/download/v0.73.0/$archive_name"
work_root="$(mktemp -d)"
archive_path="$work_root/$archive_name"
unpack_root="$work_root/unpacked"

cleanup() {
  rm -rf "$work_root"
}
trap cleanup EXIT

mkdir -p "$unpack_root"
curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
  --output "$archive_path" "$release_url"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
else
  actual_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
fi
if [[ "$actual_sha256" != "$archive_sha256" ]]; then
  printf 'Trivy archive checksum mismatch: expected %s got %s\n' "$archive_sha256" "$actual_sha256" >&2
  exit 1
fi

tar -xzf "$archive_path" -C "$unpack_root" trivy
[[ -x "$unpack_root/trivy" ]] || { printf 'Trivy archive is missing its executable.\n' >&2; exit 1; }
mkdir -p "$tool_root/bin" "$tool_root/cache"
mv "$unpack_root/trivy" "$trivy_bin"
version_output="$($trivy_bin --version)"
[[ "$version_output" == *"Version: $expected_version"* ]] || {
  printf 'Installed Trivy binary does not identify as the pinned release.\n' >&2
  exit 1
}
printf 'Installed and verified Trivy %s.\n' "$expected_version"
