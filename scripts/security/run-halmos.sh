#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
python_bin="$repo_root/.tools/halmos/bin/python"
z3_bin="$repo_root/.tools/halmos/bin/z3"
report_path="$repo_root/reports/security/halmos-protocol-math.log"
json_path="$repo_root/reports/security/halmos-protocol-math.json"
validator_log="$repo_root/reports/security/halmos-validator.log"
validator="$repo_root/scripts/security/validate-gate-evidence.mjs"
evidence_writer="$repo_root/scripts/security/write-gate-evidence.mjs"
tool_root="$(mktemp -d "${TMPDIR:-/tmp}/cpredict-halmos.XXXXXX")"
work_repo="$tool_root/repo"
entrypoint="$work_repo/scripts/security/halmos-entry.py"
fresh_log="$tool_root/halmos.log"
fresh_json="$tool_root/halmos.json"
halmos_wheel_sha="3967291bdd4aaac96a4c42dd18bf25bd76215acad53697d98f02b986ac8d3f67"
z3_sha="6a445d914dce13d8bc6ef0d7c39fb88582ff2258a28e031975b798cd62cf7af5"
halmos_record_sha="24f6dc420fc4e41bdae91d96babad9e549187b2784a3f7df1e9438893498c1ff"
record_verifier="$repo_root/scripts/security/verify-python-record.mjs"
cleanup() { rm -rf "$tool_root"; }
trap cleanup EXIT INT TERM

[[ -x "$python_bin" ]] || {
  printf 'Missing project-local Halmos environment: %s\n' "$python_bin" >&2
  exit 1
}
[[ -x "$z3_bin" ]] || {
  printf 'Missing project-local Halmos Z3 solver: %s\n' "$z3_bin" >&2
  exit 1
}
if [[ "$(shasum -a 256 "$z3_bin" | awk '{print $1}')" != "$z3_sha" ]]; then
  printf '%s\n' 'Halmos Z3 binary checksum mismatch' >&2
  exit 1
fi
if [[ "$($python_bin -c 'import importlib.metadata; print(importlib.metadata.version("halmos"))')" != '0.3.3' ]]; then
  printf '%s\n' 'Halmos package version mismatch' >&2
  exit 1
fi
record_candidates=("$repo_root"/.tools/halmos/lib/python*/site-packages/halmos-0.3.3.dist-info/RECORD)
if [[ "${#record_candidates[@]}" -ne 1 || ! -f "${record_candidates[0]}" ]]; then
  printf '%s\n' 'Expected exactly one Halmos 0.3.3 Python RECORD' >&2
  exit 1
fi
node "$record_verifier" "${record_candidates[0]}" "$halmos_record_sha"

mkdir -p "$(dirname "$report_path")" "$repo_root/.tools/halmos-home" "$work_repo/scripts/security" "$work_repo/test/security"
cp -R "$repo_root/src" "$work_repo/"
cp "$repo_root/test/security/ProtocolMath.smt.sol" "$work_repo/test/security/"
cp "$repo_root/scripts/security/halmos-entry.py" "$work_repo/scripts/security/"
cp "$repo_root/foundry.toml" "$repo_root/remappings.txt" "$work_repo/"
ln -s "$repo_root/lib" "$work_repo/lib"
ln -s "$repo_root/.tools" "$work_repo/.tools"
export PATH="$repo_root/.tools/foundry/bin:$PATH"
export SVM_HOME="$repo_root/.tools/svm"

cd "$work_repo"
set +e
"$python_bin" "$entrypoint" \
  --contract ProtocolMathSmt \
  --function 'check_' \
  --solver z3 \
  --solver-timeout-assertion 0 \
  --json-output "$fresh_json" \
  >"$fresh_log" 2>&1
tool_status=$?
set -e

cp "$fresh_log" "$report_path"
validator_status=1
if [[ -f "$fresh_json" ]]; then
  cp "$fresh_json" "$json_path"
  set +e
  node "$validator" halmos "$json_path" "$report_path" >"$validator_log" 2>&1
  validator_status=$?
  set -e
else
  printf '%s\n' 'Halmos did not produce the required JSON report' >"$validator_log"
fi

evidence_args=(
  --root "$repo_root"
  --gate halmos
  --tool halmos
  --version 0.3.3
  --artifact-sha256 "$halmos_wheel_sha"
  --tool-exit "$tool_status"
  --accepted-tool-exits 0
  --validator-exit "$validator_status"
  --output reports/security/halmos-evidence.json
  --input src
  --input test/security/ProtocolMath.smt.sol
  --input scripts/security/halmos-entry.py
  --input scripts/security/run-halmos.sh
  --input scripts/security/validate-gate-evidence.mjs
  --input scripts/security/write-gate-evidence.mjs
  --input scripts/security/verify-gate-evidence.mjs
  --input scripts/security/verify-python-record.mjs
  --input manifests/security-tools.lock
  --input manifests/halmos-wheels.lock
  --input foundry.toml
  --input remappings.txt
  --evidence reports/security/halmos-protocol-math.log
  --evidence reports/security/halmos-validator.log
)
if [[ -f "$json_path" ]]; then evidence_args+=(--evidence reports/security/halmos-protocol-math.json); fi
node "$evidence_writer" "${evidence_args[@]}"

if [[ "$tool_status" -ne 0 ]]; then
  printf 'Halmos exited %s; see %s\n' "$tool_status" "$report_path" >&2
  exit "$tool_status"
fi
if [[ "$validator_status" -ne 0 ]]; then
  printf 'Halmos evidence validation failed; inspect %s\n' "$validator_log" >&2
  exit "$validator_status"
fi

printf 'Halmos protocol math properties passed; see %s\n' "$report_path"
