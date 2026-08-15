# Formal verification status

Status date: 2026-08-08. Both lanes below are bounded protocol-math proofs, not whole-protocol formal
verification.

## Halmos 0.3.3: PASS

The project-local Halmos environment used pinned CPython packages and Z3 4.12.6.0. The Halmos wheel,
installed RECORD payloads, and solver binary were verified before execution. Forge compilation ran in
a complete temporary repository; the shared repository `out/` and `cache/` were not cleaned or used.

| Property | Symbolic paths | Counterexamples | Result |
|---|---:|---:|---|
| C2C gross conservation | 17 | 0 | PASS |
| Rake and winner-pool conservation | 22 | 0 | PASS |
| Remaining-pool final claimant exhaustion | 14 | 0 | PASS |

Raw exit code `0`; validator exit code `0`; summary `3 passed, 0 failed`.

## Solidity SMTChecker: PASS

The exact SHA-256-locked Solidity 0.8.36 compiler was executed with the project-local, hash-verified
Z3 4.12.6 solver. CHC and BMC were separate fail-closed executions. Each engine proved the 10 expected
assertion conditions safe, for 20 proof messages total.

Raw combined exit code `0`; validator exit code `0`.

## Evidence and boundary

- `reports/security/halmos-protocol-math.json`
- `reports/security/halmos-protocol-math.log`
- `reports/security/halmos-evidence.json`
- `reports/security/smtchecker.stdout.txt`
- `reports/security/smtchecker.stderr.txt`
- `reports/security/smtchecker-evidence.json`

These proofs cover the standalone arithmetic model. They do not prove the full authorization graph,
terminal-state transitions, external token behavior, account abstraction, clone initialization, or
cross-contract callbacks. Those remain separate testing, analysis, and audit surfaces.
