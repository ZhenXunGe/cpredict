#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tool_root="$repo_root/.tools/foundry"
forge_bin="$tool_root/bin/forge"
expected_version="1.7.1"
expected_commit="4072e48705af9d93e3c0f6e29e93b5e9a40caed8"

if [[ -x "$forge_bin" ]]; then
  version_output="$($forge_bin --version)"
  if [[ "$version_output" == *"Version: $expected_version"* && "$version_output" == *"Commit SHA: $expected_commit"* ]]; then
    printf 'Foundry %s (%s) already verified.\n' "$expected_version" "$expected_commit"
    exit 0
  fi

  printf 'Foundry exists at %s but does not match the pinned version; refusing to overwrite it.\n' "$forge_bin" >&2
  exit 1
fi

case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    archive_name="foundry_v1.7.1_darwin_arm64.tar.gz"
    archive_sha256="eacdc67718fac857cad9e19c7f6729dd80de731d09df81856391d093cfcab547"
    ;;
  Linux:x86_64)
    archive_name="foundry_v1.7.1_linux_amd64.tar.gz"
    archive_sha256="cf7e688ed0c4c48adffca788b496076e31060b67ac5afe1e43dbb5499c20c88b"
    ;;
  *)
    printf 'Unsupported Foundry bootstrap platform: %s/%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

release_url="https://github.com/foundry-rs/foundry/releases/download/v1.7.1/$archive_name"
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
  printf 'Foundry archive checksum mismatch: expected %s got %s\n' "$archive_sha256" "$actual_sha256" >&2
  exit 1
fi

tar -xzf "$archive_path" -C "$unpack_root"
for binary in forge cast anvil chisel; do
  [[ -x "$unpack_root/$binary" ]] || {
    printf 'Foundry archive is missing executable %s.\n' "$binary" >&2
    exit 1
  }
done

mkdir -p "$tool_root/bin"
for binary in forge cast anvil chisel; do
  mv "$unpack_root/$binary" "$tool_root/bin/$binary"
done

version_output="$($forge_bin --version)"
if [[ "$version_output" != *"Version: $expected_version"* || "$version_output" != *"Commit SHA: $expected_commit"* ]]; then
  printf 'Installed Foundry binary does not identify as the pinned release.\n' >&2
  exit 1
fi

printf 'Installed and verified Foundry %s (%s).\n' "$expected_version" "$expected_commit"
