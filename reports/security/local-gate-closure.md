# Local security gate closure

> **OBSOLETE / historical 2026-08-08 snapshot.** The Echidna rows below preserve the original
> zero-call evidence for forensic comparison. Current arm64 evidence passes 1,000,053 calls; use
> `reports/security/security-gates.md` for the current candidate.

Status date: 2026-08-08. Scope is the current local repository and project-owned runners only.
The bounded FeeVault campaign scored 133/135 but failed its tool/runner lifecycle gate; whole-protocol
mutation has not run. No external audit, deployment, or exploitability analysis is included.

## Executed gates

| Gate | Runner rc | Raw tool rc | Validator rc | Result | Source/input snapshot SHA-256 |
|---|---:|---:|---:|---|---|
| Slither | 0 | 255 | 0 | PASS | `6d274a663fc2c714fd9a0602214cf7ca21d32b3d0db713ec8da61e19746706c0` |
| Aderyn | 0 | 0 | 0 | PASS | `fe976ba5f7e4242dc9a3117d4f137085f3fa732a600aebd23ba6dc7135bf730e` |
| Echidna arm64 | 1 | 0 | 1 | FAIL | `3d94d619e58e2084dc7bdc89d6985eff8535489411712fdfff14f1a837e009da` |
| Echidna x86_64/Rosetta | 1 | 0 | 1 | FAIL | `5d40acdfcde046e1e90f4fa4ed0a46fccf04219f8c4059ca8dedd296e06c1d08` |
| Medusa | 0 | 0 | 0 | PASS | `6e5c8149a995780a392dce31b7ef9e73e6f784a911d5edd83d71d91e9d8aa07e` |
| Halmos | 0 | 0 | 0 | PASS | `163831c47a9a7bbd6974c9a26a6df860b67e5d5c1969c879ae61141ee24cf71c` |
| Solidity SMTChecker | 0 | 0 | 0 | PASS | `ad2ff63218a6adb6a94eb7fa764b951162c2d76d300e3cde655fc1a0ccf4219f` |

`verify-gate-evidence.mjs` returned `0` for the integrity of all seven metadata documents, including
the two retained FAIL documents. `--require-pass` returned `1` for each Echidna document. The aggregate
`verify-security-gates.sh` returned `1` at the first required Echidna PASS check, as intended.

## Finding inventory

- Slither: 25 results: 2 High, 0 Medium, 21 Low, 2 Informational. The two High rows match the exact
  reviewed `reentrancy-balance` baseline; validator rc `0`.
- Aderyn: 2 High and 8 Low categories, exactly matching the reviewed inventory; validator rc `0`.

This inventory statement records parser output and baseline matching only. It is not an external audit
or an exploitability conclusion.

## Fuzz and formal summaries

- Medusa: 1,024,046 calls; 27/27 tests passed; 0 failed.
- Echidna arm64 and x86_64: each crashed before fuzzing; 0/1,000,000 calls. A zero process rc was not
  accepted because the validator found the crash marker and zero-call summary.
- Halmos: 3/3 bounded protocol-math properties passed.
- SMTChecker: CHC and BMC each proved all 10 expected assertion conditions.

## Runner and lock hashes

| File | SHA-256 |
|---|---|
| `manifests/security-tools.lock` | `cabcf4990431fb59269705e009ed3b73158b1df9f951d8d92da803b81a8ee2fc` |
| `scripts/security/run-slither.sh` | `8ef7706760f0640b38b1cefd262c4bcddcf873d4ab025f7da2c0e052ccdbeea4` |
| `scripts/security/run-aderyn.sh` | `43febc38f1ad5fdb3a094f76d5dde963f6dffabfa4406d0891d4b00e20b60325` |
| `scripts/security/run-echidna.sh` | `d20be0c05396a10541ea195902638e804415d20713464b9da8cbb70b6a0bac9d` |
| `scripts/security/run-echidna-x86_64.sh` | `997800f24d1556cb0db1fcb22e2ce9dcdc0f8e9edc916abad1a3509e6b17edb1` |
| `scripts/security/run-medusa.sh` | `2f1927acbbbc3d24b31c6c097418f3828ae96a59ba1bf4765e62ac51d0393881` |
| `scripts/security/run-halmos.sh` | `6f69d117a1511217489eef9178f9a0b0b70319b855b633d6f3ffb98c824acb98` |
| `scripts/security/run-smt.sh` | `c9ca7d6ea48d7880f0c9f94b8a157c6ac96fe684c70215120c09b7a2ed239ae5` |
| `scripts/security/validate-gate-evidence.mjs` | `f91b55ebe0eda11cff339300cfc169f586e559baa6c914aa4a634cb229dff413` |
| `scripts/security/write-gate-evidence.mjs` | `73aeb00b53374c52fd2150d0a875e87408eeff2c29128328dddd75aa44fcf7c0` |
| `scripts/security/verify-gate-evidence.mjs` | `62533fa6fc77ae42c74081a835264339e61c4a390b189fb123bac466defc10e9` |

## Not executed

- passing bounded mutation lifecycle and whole-protocol mutation;
- independent external audits and fix reviews;
- deployment or runtime security exercises.

The overall local security release gate remains FAIL due to Echidna. Medusa is independent passing
evidence and is not used to relabel the required Echidna gate.
