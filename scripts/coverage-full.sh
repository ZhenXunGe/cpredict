#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
final_dir="$repo_root/reports/coverage"
isolated_parent="${TMPDIR:-/tmp}"
isolated_root="$(mktemp -d "$isolated_parent/cpredict-coverage-repo.XXXXXX")"
stage_root=""
summary_finalized=false

case "$isolated_root" in
  "$isolated_parent"/cpredict-coverage-repo.*) ;;
  *)
    echo "refusing unsafe isolated repository path: $isolated_root" >&2
    exit 1
    ;;
esac

cleanup() {
  exit_code=$?
  isolated_summary="$isolated_root/reports/coverage/full.summary.txt"
  if [[ "$summary_finalized" != true && -f "$isolated_summary" ]]; then
    echo "coverage-full exit code: $exit_code" | tee -a "$isolated_summary"
  fi
  if [[ "$exit_code" -ne 0 ]]; then
    for failure_log in \
      "$isolated_root/reports/coverage/production-viair-forced-build.log" \
      "$isolated_root/reports/coverage/production-gas-assertion-check.log"
    do
      if [[ -f "$failure_log" ]]; then
        echo "failure evidence tail: ${failure_log#$isolated_root/}" >&2
        tail -n 80 "$failure_log" >&2
      fi
    done
  fi
  if [[ -n "$stage_root" ]]; then
    case "$stage_root" in
      "$repo_root"/reports/.coverage-stage.*) rm -rf -- "$stage_root" ;;
      *) echo "refusing unsafe coverage stage cleanup: $stage_root" >&2 ;;
    esac
  fi
  rm -rf -- "$isolated_root"
}
trap cleanup EXIT

# Copy the complete project source/config/test surface while excluding only VCS metadata,
# prior evidence and generated build/cache directories. Pinned source dependencies are copied so
# Foundry auto-remappings remain byte-for-byte equivalent; out/cache do not exist in the isolated
# repository at this point.
(
  cd "$repo_root"
  tar \
    --exclude='./.git' \
    --exclude='./.tools' \
    --exclude='./node_modules' \
    --exclude='./out' \
    --exclude='./cache' \
    --exclude='./ref' \
    --exclude='./reports' \
    --exclude='./test/coverage' \
    -cf - .
) | tar -xf - -C "$isolated_root"

ln -s "$repo_root/.tools" "$isolated_root/.tools"
mkdir -p "$isolated_root/reports/coverage"
cp "$final_dir/REPORT.md" "$isolated_root/reports/coverage/REPORT.md"

[[ ! -e "$isolated_root/out" ]] || {
  echo "isolated coverage repository unexpectedly contains out/" >&2
  exit 1
}
[[ ! -e "$isolated_root/cache" ]] || {
  echo "isolated coverage repository unexpectedly contains cache/" >&2
  exit 1
}

cd "$isolated_root"
coverage_dir="$isolated_root/reports/coverage"
lcov_path="$coverage_dir/full.lcov"
summary_path="$coverage_dir/full.summary.txt"
hash_path="$coverage_dir/full.sha256"
production_build_log="$coverage_dir/production-viair-forced-build.log"
production_gas_log="$coverage_dir/production-gas-assertion-check.log"

echo "Foundry repository/out/cache: fresh isolated copy with no prior out or cache" \
  | tee "$summary_path"
echo "dependency build command: bash scripts/forge.sh build lib/permit2/src/Permit2.sol" \
  | tee -a "$summary_path"
bash scripts/forge.sh build lib/permit2/src/Permit2.sol \
  > "$production_build_log" 2>&1
echo "pre-coverage pinned Permit2 artifact build: PASS" | tee -a "$summary_path"

echo "coverage command: FOUNDRY_PROFILE=non_ir bash scripts/forge.sh coverage --report summary --report lcov --report-file reports/coverage/full.lcov" \
  | tee -a "$summary_path"
FOUNDRY_PROFILE=non_ir bash scripts/forge.sh coverage \
  --report summary \
  --report lcov \
  --report-file "$lcov_path" 2>&1 | tee -a "$summary_path"

bash scripts/coverage-summary.sh "$lcov_path" | tee -a "$summary_path"

awk '
  /^SF:/ {
    production = substr($0, 4) ~ /^src\//
    next
  }
  /^(LF|LH|FNF|FNH|BRF|BRH):/ && production {
    split($0, parts, ":")
    src[parts[1]] += parts[2]
  }
  END {
    line_ok = src["LF"] > 0 && src["LH"] == src["LF"]
    function_ok = src["FNF"] > 0 && src["FNH"] == src["FNF"]
    branch_ok = src["BRF"] > 0 && src["BRH"] * 100 >= src["BRF"] * 95
    if (!line_ok || !function_ok || !branch_ok) {
      print "production coverage gate: FAIL (lines 100%, functions 100%, branches >=95% required)"
      exit 1
    }
    print "production coverage gate: PASS (lines 100%, functions 100%, branches >=95%)"
  }
' "$lcov_path" | tee -a "$summary_path"

echo "production build commands: bash scripts/forge.sh build --force; bash scripts/forge.sh build lib/permit2/src/Permit2.sol" \
  | tee -a "$summary_path"
bash scripts/forge.sh build --force >> "$production_build_log" 2>&1
bash scripts/forge.sh build lib/permit2/src/Permit2.sol \
  >> "$production_build_log" 2>&1
echo "production viaIR forced build: PASS" | tee -a "$summary_path"

echo "production gas assertion command: bash scripts/forge.sh test --match-test ^testGasGate" \
  | tee -a "$summary_path"
bash scripts/forge.sh test --match-test '^testGasGate' \
  > "$production_gas_log" 2>&1
grep -Eq '10 tests passed, 0 failed, 0 skipped' "$production_gas_log"
echo "production gas assertion context: PASS (10/10, 0 failed, 0 skipped)" \
  | tee -a "$summary_path"

echo "coverage-full exit code: 0" | tee -a "$summary_path"
summary_finalized=true

# Preserve tool semantics while keeping generated evidence reviewable by Git. Forge occasionally
# emits box-drawing rows padded with spaces; normalizing after validation and before hashing prevents
# generated evidence from reintroducing `git diff --check` failures.
for text_log in \
  "$summary_path" \
  "$production_build_log" \
  "$production_gas_log"
do
  node scripts/normalize-text-log.mjs "$text_log"
done

shasum -a 256 \
  reports/coverage/full.lcov \
  reports/coverage/full.summary.txt \
  reports/coverage/REPORT.md \
  reports/coverage/production-viair-forced-build.log \
  reports/coverage/production-gas-assertion-check.log \
  > "$hash_path"
shasum -a 256 -c "$hash_path"

# Publish only a complete passing evidence set. The checksum is moved last as the commit marker.
mkdir -p "$final_dir"
stage_root="$(mktemp -d "$repo_root/reports/.coverage-stage.XXXXXX")"
for evidence in \
  full.lcov \
  full.summary.txt \
  REPORT.md \
  production-viair-forced-build.log \
  production-gas-assertion-check.log \
  full.sha256
do
  cp "$coverage_dir/$evidence" "$stage_root/$evidence"
done
for evidence in \
  full.lcov \
  full.summary.txt \
  REPORT.md \
  production-viair-forced-build.log \
  production-gas-assertion-check.log
do
  mv -f -- "$stage_root/$evidence" "$final_dir/$evidence"
done
mv -f -- "$stage_root/full.sha256" "$final_dir/full.sha256"
rmdir "$stage_root"
stage_root=""
