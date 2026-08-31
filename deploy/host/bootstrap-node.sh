#!/usr/bin/env bash
set -Eeuo pipefail

readonly NODE_VERSION="22.22.2"
readonly NODE_ARCHIVE="node-v${NODE_VERSION}-linux-x64.tar.xz"
readonly NODE_SHA256="88fd1ce767091fd8d4a99fdb2356e98c819f93f3b1f8663853a2dee9b438068a"
readonly NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"
readonly INSTALL_ROOT="/opt/cpredict/node-v${NODE_VERSION}"

if [[ ${1:-} != "--apply" || $# -ne 1 ]]; then
  echo "usage: sudo bash deploy/host/bootstrap-node.sh --apply" >&2
  echo "Installs the pinned official Node.js release without editing PATH or shell configuration." >&2
  exit 2
fi
if [[ $EUID -ne 0 ]]; then
  echo "run this installer as root" >&2
  exit 1
fi
if [[ $(uname -s) != "Linux" || $(uname -m) != "x86_64" ]]; then
  echo "this installer supports Linux x86_64 only" >&2
  exit 1
fi
for command in curl sha256sum tar install mktemp mv ln readlink; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

temporary="$(mktemp -d /tmp/cpredict-node.XXXXXX)"
trap 'rm -rf -- "$temporary"' EXIT

if [[ -e "$INSTALL_ROOT" ]]; then
  if [[ ! -x "$INSTALL_ROOT/bin/node" || "$($INSTALL_ROOT/bin/node --version)" != "v${NODE_VERSION}" ]]; then
    echo "$INSTALL_ROOT exists but is not the expected Node.js release; refusing to overwrite it" >&2
    exit 1
  fi
else
  curl --fail --location --proto '=https' --tlsv1.2 --output "$temporary/$NODE_ARCHIVE" "$NODE_URL"
  printf '%s  %s\n' "$NODE_SHA256" "$temporary/$NODE_ARCHIVE" | sha256sum --check --strict
  install -d -m 0755 "$temporary/extracted" /opt/cpredict
  tar --extract --xz --file "$temporary/$NODE_ARCHIVE" --directory "$temporary/extracted" --strip-components=1
  [[ "$($temporary/extracted/bin/node --version)" == "v${NODE_VERSION}" ]] || {
    echo "downloaded Node.js archive did not report the pinned version" >&2
    exit 1
  }
  mv -- "$temporary/extracted" "$INSTALL_ROOT"
fi

for command in node npm npx corepack; do
  source_path="$INSTALL_ROOT/bin/$command"
  target_path="/usr/local/bin/$command"
  [[ -x "$source_path" ]] || { echo "$source_path is missing" >&2; exit 1; }
  if [[ -e "$target_path" || -L "$target_path" ]]; then
    if [[ "$(readlink -f -- "$target_path")" != "$source_path" ]]; then
      echo "$target_path already exists and is not managed by this installer; refusing to overwrite it" >&2
      exit 1
    fi
  else
    ln -s -- "$source_path" "$target_path"
  fi
done

if [[ "$(command -v node)" != "/usr/local/bin/node" || "$(node --version)" != "v${NODE_VERSION}" ]]; then
  echo "the current PATH did not resolve the pinned /usr/local/bin/node" >&2
  exit 1
fi
node --version
npm --version
echo "Pinned Node.js installed at $INSTALL_ROOT"
