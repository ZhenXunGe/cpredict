# Aderyn 0.6.8 execution status

Executed 2026-08-08 against the frozen `src/**` inventory. The official macOS arm64 archive was
verified against `manifests/security-tools.lock` and executed from a temporary isolated repository.

## Gate result: PASS

- raw tool exit code: `0`;
- validator exit code: `0`;
- source units: `20`;
- SLOC: `2,331`;
- detector inventory: `88`;
- emitted categories: `2` High and `8` Low;
- report: `reports/security/aderyn.json`;
- raw log: `reports/security/aderyn-latest.log`;
- source/evidence metadata: `reports/security/aderyn-evidence.json`.

The runner uses Aderyn's official `--skip-update-check` option. This prevents the post-report update
request that previously caused the macOS binary to terminate after writing a valid report. The current
PASS is bound to the exact report inventory and tool rc; it does not replace independent review.

Finding dispositions remain encoded in the reviewed validator baseline. This status file intentionally
does not reproduce vulnerability or exploitation analysis.
