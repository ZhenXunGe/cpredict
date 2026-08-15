#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$PROJECT_ROOT"
: "${SUT_EVIDENCE_DIR:?SUT_EVIDENCE_DIR is required}"
: "${LOAD_EVIDENCE_DIR:?LOAD_EVIDENCE_DIR is required}"
: "${CHAIN_EVIDENCE_DIR:?CHAIN_EVIDENCE_DIR is required}"
: "${EVIDENCE_SIGNING_PRIVATE_KEY:?EVIDENCE_SIGNING_PRIVATE_KEY is required}"
: "${EVIDENCE_SIGNING_PUBLIC_KEY:?EVIDENCE_SIGNING_PUBLIC_KEY is required}"
: "${EVIDENCE_SIGNING_KEY_ID:?EVIDENCE_SIGNING_KEY_ID is required}"
: "${RUN_ID:?RUN_ID is required}"
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { printf '%s\n' 'invalid RUN_ID' >&2; exit 64; }
OUTPUT_DIR="${OUTPUT_DIR:-$PROJECT_ROOT/reports/performance/distributed-commercial-$RUN_ID}"

node load/distributed/commercial-evidence.mjs collect \
  "$SUT_EVIDENCE_DIR" "$LOAD_EVIDENCE_DIR" "$CHAIN_EVIDENCE_DIR" "$OUTPUT_DIR" \
  "$EVIDENCE_SIGNING_PRIVATE_KEY" "$EVIDENCE_SIGNING_PUBLIC_KEY" "$EVIDENCE_SIGNING_KEY_ID"
node load/distributed/commercial-evidence.mjs validate "$OUTPUT_DIR" "$EVIDENCE_SIGNING_PUBLIC_KEY"
printf '%s\n' "Signed distributed commercial evidence: $OUTPUT_DIR"
