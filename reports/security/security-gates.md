# Security gate status

Status date: 2026-08-24. This is local pre-audit evidence. It is not an external audit,
deployment result, or production-safety statement.

## Current local gates

| Gate | Result | Exact boundary |
|---|---|---|
| Foundry coverage | PASS | 20 suites, 121/121 tests; `src/**` line 100%, function 100%, branch 99.13%; see `reports/coverage/REPORT.md` |
| Slither 0.11.6 | STALE / REVALIDATION REQUIRED | Retained raw rc 255 and reviewed baseline passed on the prior snapshot; current verifier rejects `foundry.toml` input drift |
| Aderyn 0.6.8 | STALE / REVALIDATION REQUIRED | Retained raw rc 0 passed on the prior snapshot; current verifier rejects `foundry.toml` input drift |
| Echidna 2.3.3 arm64 | STALE / REVALIDATION REQUIRED | Retained run reached 1,000,053 calls and 4/4 properties; current verifier rejects `foundry.toml` input drift |
| Echidna 2.3.3 x86_64 under Rosetta | PARTIAL / FAIL | Harness fix removes the 0-call crash: diagnostic reached 1,032 calls and 4/4 passing, but hung at `Saving coverage...`; no million-call lifecycle PASS |
| Medusa 1.5.1 | STALE / REVALIDATION REQUIRED | Retained run reached 1,024,046 calls and 27/27 properties; current verifier rejects `foundry.toml` input drift |
| Halmos 0.3.3 | STALE / REVALIDATION REQUIRED | Retained bounded run proved 3/3 properties; current verifier rejects `foundry.toml` input drift |
| Solidity SMTChecker | STALE / REVALIDATION REQUIRED | Retained CHC/BMC run proved 10 expected conditions per engine; current verifier rejects validator-input drift |
| Evidence parser/runner tests | PASS | 30/30 Node tests, standalone mutation lifecycle fixture and relevant shell syntax checks passed |
| Mutation score | ABORTED / PARTIAL / FAIL | Retained FeeVault score 133/135 has raw rc 143; old full campaign completed 0/12. Exact-target/process-group/atomic-evidence runner hardening is focused-tested, but fresh FeeVault/full campaigns are NOT RUN |
| Independent audits / fix reviews | NOT RUN | No external-audit evidence or frozen audit tag |

## Fail-closed evidence model

Each executed tool retains the raw log/report, raw tool exit code, validator exit code, exact accepted
exit-code inventory, tool artifact SHA-256, input hashes, evidence hashes, source snapshot hash, and a
SHA-256 sidecar for the metadata document. `verify-gate-evidence.mjs --require-pass` currently rejects
every retained deep-security record because its input inventory no longer equals the candidate, and it
also rejects incomplete x86_64 and mutation evidence. A tool process returning zero therefore cannot
hide a crash, zero-call run or stale source snapshot.

## Release conclusion

The retained arm64 Echidna run completed one million calls on its prior snapshot, but no deep-security
record is current-source-bound after the candidate input drift. The local security aggregate remains
**FAIL**; x86_64 has no completed million-call lifecycle, fresh bounded/full mutation evidence does not
exist, and independent external audits remain unrun.
