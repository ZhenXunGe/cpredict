#!/usr/bin/env bash
set -euo pipefail

lcov_file="${1:-reports/coverage/full.lcov}"

if [[ ! -f "$lcov_file" ]]; then
  echo "coverage file not found: $lcov_file" >&2
  exit 1
fi

awk '
  function percent(hit, found) {
    return found == 0 ? "n/a" : sprintf("%.2f%%", hit * 100 / found)
  }
  /^SF:/ {
    file = substr($0, 4)
    production = file ~ /^src\//
    next
  }
  /^(LF|LH|FNF|FNH|BRF|BRH):/ {
    split($0, parts, ":")
    raw[parts[1]] += parts[2]
    if (production) src[parts[1]] += parts[2]
  }
  END {
    printf "raw lines:     %d/%d (%s)\n", raw["LH"], raw["LF"], percent(raw["LH"], raw["LF"])
    printf "raw functions: %d/%d (%s)\n", raw["FNH"], raw["FNF"], percent(raw["FNH"], raw["FNF"])
    printf "raw branches:  %d/%d (%s)\n", raw["BRH"], raw["BRF"], percent(raw["BRH"], raw["BRF"])
    printf "src lines:     %d/%d (%s)\n", src["LH"], src["LF"], percent(src["LH"], src["LF"])
    printf "src functions: %d/%d (%s)\n", src["FNH"], src["FNF"], percent(src["FNH"], src["FNF"])
    printf "src branches:  %d/%d (%s)\n", src["BRH"], src["BRF"], percent(src["BRH"], src["BRF"])
  }
' "$lcov_file"
