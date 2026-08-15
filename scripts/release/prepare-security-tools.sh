#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
configured_root="${CPREDICT_SECURITY_TOOLS_ROOT:-}"

fail() {
  printf 'security runner tool preparation failed: %s\n' "$1" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

[[ -n "$configured_root" ]] || fail "CPREDICT_SECURITY_TOOLS_ROOT is required"
[[ -d "$configured_root" ]] || fail "configured tool root is not a directory"
tool_root="$(cd "$configured_root" && pwd -P)"
case "$tool_root" in
  "$repo_root"|"$repo_root"/*)
    fail "tool root must be outside the checkout so actions/checkout cannot erase it"
    ;;
esac
for tool in slither halmos; do
  [[ -d "$tool_root/$tool" ]] || fail "missing tool directory $tool"
  [[ "$(cd "$tool_root/$tool" && pwd -P)" == "$tool_root/$tool" ]] || fail "tool directory symlink is forbidden: $tool"
done

for executable in \
  slither/bin/python \
  slither/bin/slither \
  slither/bin/slither-mutate \
  halmos/bin/python \
  halmos/bin/z3
do
  [[ -x "$tool_root/$executable" ]] || fail "missing executable $executable"
done

[[ "$("$tool_root/slither/bin/slither" --version)" == "0.11.6" ]] || fail "Slither version drift"
[[ "$("$tool_root/halmos/bin/python" --version 2>&1)" == "Python 3.12.13" ]] || fail "Halmos Python version drift"
[[ "$("$tool_root/halmos/bin/python" -c 'import importlib.metadata; print(importlib.metadata.version("halmos"))')" == "0.3.3" ]] || fail "Halmos version drift"
[[ "$("$tool_root/slither/bin/python" -c 'import importlib.metadata; print(importlib.metadata.version("slither-analyzer"))')" == "0.11.6" ]] || fail "slither-analyzer package drift"
[[ "$("$tool_root/slither/bin/python" -c 'import importlib.metadata; print(importlib.metadata.version("crytic-compile"))')" == "0.4.2" ]] || fail "crytic-compile package drift"
[[ "$("$tool_root/slither/bin/python" -c 'import importlib.metadata; print(importlib.metadata.version("solc-select"))')" == "1.2.0" ]] || fail "solc-select package drift"
[[ "$(sha256_file "$tool_root/halmos/bin/z3")" == "6a445d914dce13d8bc6ef0d7c39fb88582ff2258a28e031975b798cd62cf7af5" ]] || fail "Halmos z3 binary hash drift"

mkdir -p "$repo_root/.tools"
for tool in slither halmos; do
  target="$repo_root/.tools/$tool"
  [[ ! -e "$target" && ! -L "$target" ]] || fail "checkout tool target already exists: .tools/$tool"
  ln -s "$tool_root/$tool" "$target"
done

printf '%s\n' 'Pinned external security tool environments linked into the clean checkout'
