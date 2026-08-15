#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deps_root="$repo_root/lib"
mkdir -p "$deps_root"

install_dep() {
  local name="$1"
  local url="$2"
  local revision="$3"
  local target="$deps_root/$name"

  if [[ -e "$target" ]]; then
    actual="$(git -C "$target" rev-parse HEAD)"
    [[ "$actual" == "$revision" ]] || {
      printf 'dependency mismatch: %s expected %s got %s\n' "$name" "$revision" "$actual" >&2
      return 1
    }
    return 0
  fi

  git clone --quiet "$url" "$target"
  git -C "$target" checkout --quiet "$revision"
  actual="$(git -C "$target" rev-parse HEAD)"
  [[ "$actual" == "$revision" ]]
}

install_dep openzeppelin-contracts https://github.com/OpenZeppelin/openzeppelin-contracts.git cab19933c33c2ad1d4c7a84864a3601dddfd16f3
install_dep forge-std https://github.com/foundry-rs/forge-std.git 8e40513d678f392f398620b3ef2b418648b33e89
install_dep permit2 https://github.com/Uniswap/permit2.git cc56ad0f3439c502c246fc5cfcc3db92bb8b7219
git -C "$deps_root/permit2" submodule update --init --depth 1 lib/solmate
[[ "$(git -C "$deps_root/permit2/lib/solmate" rev-parse HEAD)" == "8d910d876f51c3b2585c9109409d601f600e68e1" ]]
install_dep account-abstraction https://github.com/eth-infinitism/account-abstraction.git 4cbc06072cdc19fd60f285c5997f4f7f57a588de

printf '%s\n' 'Dependencies match manifests/dependencies.lock.'
