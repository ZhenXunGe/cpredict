# Security gate status

Status date: 2026-09-01. This is local pre-audit evidence. It is not an external audit,
deployment result, or production-safety statement.

## Current local gates

| Gate | Result | Exact boundary |
|---|---|---|
| Foundry coverage | PASS | 24 suites, 137/137 tests; `src/**` line 100%, function 100%, branch 99.15%; forced production-viaIR build and 10/10 gas/size assertions pass; see `reports/coverage/REPORT.md` |
| Slither 0.11.6 | STALE / REVALIDATION REQUIRED | Retained raw rc 255 and reviewed baseline passed on the prior snapshot; current verifier rejects input drift after the evidence writer and candidate source changed |
| Aderyn 0.6.8 | STALE / REVALIDATION REQUIRED | Retained raw rc 0 passed on the prior snapshot; current verifier rejects input drift after the evidence writer and candidate source changed |
| Echidna 2.3.3 arm64 | STALE / REVALIDATION REQUIRED | Retained run reached 1,000,053 calls and 4/4 properties on its prior snapshot; not rerun in this batch |
| Echidna 2.3.3 x86_64 under Rosetta | PARTIAL / FAIL | Harness fix removes the 0-call crash: diagnostic reached 1,032 calls and 4/4 passing, but hung at `Saving coverage...`; no million-call lifecycle PASS |
| Medusa 1.5.1 | STALE / REVALIDATION REQUIRED | Retained run reached 1,024,046 calls and 27/27 properties; current verifier rejects `foundry.toml` input drift |
| Halmos 0.3.3 | STALE / REVALIDATION REQUIRED | Retained bounded run proved 3/3 properties; current verifier rejects `foundry.toml` input drift |
| Solidity SMTChecker | STALE / REVALIDATION REQUIRED | Retained CHC/BMC run proved 10 expected conditions per engine; current verifier rejects validator-input drift |
| Evidence parser/runner tests | PASS | 35/35 Node tests and the standalone mutation lifecycle fixture pass; they cover text-log normalization, exact inventories, process-group cleanup, atomic publication and input-snapshot drift rejection |
| FeeVault bounded mutation | PASS | Fresh current-input run compiled 135 mutants and caught 133 (98.52%); raw rc 0, validator rc 0, lifecycle PASS and input snapshot PASS |
| Whole-protocol mutation | PARTIAL / FAIL | Retained full campaign completed only 2/12 contracts and has no release score; no fresh full campaign was run |
| Independent audits / fix reviews | NOT RUN | No external-audit evidence or frozen audit tag |

## Fail-closed evidence model

Each executed tool retains the raw log/report, raw tool exit code, validator exit code, exact accepted
exit-code inventory, tool artifact SHA-256, input hashes, evidence hashes, source snapshot hash, and a
SHA-256 sidecar for the metadata document. Mutation runners now capture the complete `src/**`, `test/**`
and `script/**` inventory plus runner inputs before execution, verify the same snapshot again before
publishing, and pass the expected snapshot into the evidence writer. The fresh FeeVault record satisfies
that model. `verify-security-gates.sh` still fails closed at the first retained stale deep-security record;
incomplete x86_64 and whole-protocol mutation evidence remain failures. A tool process returning zero
therefore cannot hide a crash, zero-call run, mid-campaign input drift or stale source snapshot.

## Release conclusion

The fresh bounded FeeVault mutation result is current-source-bound, but it is not a whole-protocol score.
The retained arm64 Echidna run completed one million calls only on its prior snapshot. The local security
aggregate remains **FAIL**: other deep-security records require revalidation, x86_64 has no completed
million-call lifecycle, the fresh whole-protocol mutation campaign was not run, and independent external
audits remain unrun.
