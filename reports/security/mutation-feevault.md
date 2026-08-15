# FeeVaultV1 bounded mutation report

Status date: 2026-08-08. This is the current bounded `FeeVaultV1` campaign, not the required
whole-protocol mutation campaign.

## Current result: FAIL

| Class | Caught | Compiled | Score |
|---|---:|---:|---:|
| Revert | 16 | 16 | 100% |
| Comment | 29 | 29 | 100% |
| Tweak | 88 | 90 | 97.78% |
| **Total** | **133** | **135** | **98.52%** |

The numeric score exceeds 90%, but the bounded gate is **FAIL** because the tool/runner lifecycle did
not complete successfully. A score printed before a failed finalization step is evidence, not a gate
PASS.

## Equivalent survivors

The two surviving mutations replace `amount == 0` with `amount <= 0` at the two `uint256` amount
checks. Over the unsigned domain the predicates are equivalent. This explains the survivors but does
not override the lifecycle failure.

## Fail-closed lifecycle evidence

`slither-mutate` emitted `Done mutating FeeVaultV1` and the complete summaries, then hung after
`No contracts were found in None`. The runner's 120-second post-report deadline sent TERM; raw tool
exit code was `143`. The initial macOS `awk` parser then failed on a portability issue; that state is
retained only as pre-refinalization history.

A pure Node parser reconstructed the score from the unchanged canonical log without rerunning the
mutator. Parser-only finalization rc is `0`; metadata validator and evidence-integrity rc are `0`.
The metadata result remains **FAIL** because tool lifecycle failed, and `--require-pass` returns `1`.
Parser success therefore cannot promote the campaign to PASS.

Current evidence hashes:

- raw log SHA-256: `2d0bc7743cb2742ef96fcb421b3a18eec5a92f3e47aeed677140f4e8b01e329f`;
- summary SHA-256: `13b9a15c285e49b60cc6884493aa038182ed25a4f24898322932458fb316c884`;
- evidence JSON SHA-256: `b5fc1b1159596e80d50c29ab5f0d6e1f57eef3d1f2f8258a1d61f644fffd6ec8`;
- evidence sidecar SHA-256: `bef68a029dda176b5700c241fb470547a77a3623581db38ded785feebe67b86b`;
- source snapshot SHA-256: `1ddb1956d6a5a9294b12b6e7fb8021757c52ba43380e44f4a3f22a977fb3fcf3`.

## Whole-protocol boundary

Whole-protocol/full mutation is **NOT RUN**. Even a clean bounded FeeVault PASS would not satisfy that
release requirement.

Evidence:

- `reports/security/mutation-feevault.log`;
- `reports/security/mutation-feevault-summary.txt`;
- `reports/security/mutation-feevault-evidence.json`;
- `reports/security/mutation-feevault-evidence.json.sha256`;
- `reports/security/mutation-feevault-refinalization.md`.
