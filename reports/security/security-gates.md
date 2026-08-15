# Security gate status

Status date: 2026-08-12. This is local pre-audit evidence. It is not an external audit,
deployment result, or production-safety statement.

## Current local gates

| Gate | Result | Exact boundary |
|---|---|---|
| Foundry coverage | PASS | 20 suites, 121/121 tests; `src/**` line 100%, function 100%, branch 99.13%; see `reports/coverage/REPORT.md` |
| Slither 0.11.6 | PASS | Raw rc 255 (findings emitted), reviewed High/Medium baseline validator rc 0; exact installed Python payloads and launchers verified |
| Aderyn 0.6.8 | PASS | Raw rc 0 with official `--skip-update-check`; report inventory validator rc 0 |
| Echidna 2.3.3 arm64 | PASS | Raw rc 0; 1,000,053 calls; exact 4/4 properties passing; 24,373 unique instructions; validator/evidence verifier rc 0 |
| Echidna 2.3.3 x86_64 under Rosetta | PARTIAL / FAIL | Harness fix removes the 0-call crash: diagnostic reached 1,032 calls and 4/4 passing, but hung at `Saving coverage...`; no million-call lifecycle PASS |
| Medusa 1.5.1 | PASS | Raw rc 0; 1,024,046 calls; 27/27 tests passed; validator rc 0 |
| Halmos 0.3.3 | PASS (bounded scope) | Raw rc 0; 3/3 protocol-math properties; validator rc 0 |
| Solidity SMTChecker | PASS (bounded scope) | solc 0.8.36 plus Z3 4.12.6; CHC and BMC each proved 10 expected assertion conditions; validator rc 0 |
| Evidence parser/runner tests | PASS | 30/30 Node tests, standalone mutation lifecycle fixture and relevant shell syntax checks passed |
| Mutation score | ABORTED / PARTIAL / FAIL | Retained FeeVault score 133/135 has raw rc 143; old full campaign completed 0/12. Exact-target/process-group/atomic-evidence runner hardening is focused-tested, but fresh FeeVault/full campaigns are NOT RUN |
| Independent audits / fix reviews | NOT RUN | No external-audit evidence or frozen audit tag |

## Fail-closed evidence model

Each executed tool retains the raw log/report, raw tool exit code, validator exit code, exact accepted
exit-code inventory, tool artifact SHA-256, input hashes, evidence hashes, source snapshot hash, and a
SHA-256 sidecar for the metadata document. `verify-gate-evidence.mjs --require-pass` accepts the new
arm64 evidence and still rejects incomplete x86_64 and mutation evidence. A tool process returning
zero therefore cannot hide a crash or zero-call run.

## Release conclusion

The arm64 Echidna million-call gate is now **PASS**. The broader local security aggregate remains
**FAIL** because x86_64 has no completed million-call lifecycle, fresh bounded/full mutation evidence
does not exist, and independent external audits remain unrun. Medusa, Slither, Aderyn, Halmos, and
SMTChecker retain their stated source-bound PASS evidence.
