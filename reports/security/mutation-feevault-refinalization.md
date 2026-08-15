# FeeVault mutation parser-only re-finalization

Status date: 2026-08-09.

This report reconstructs the bounded FeeVault score and evidence metadata from the retained canonical
raw log. The mutation tool was **not rerun**. The raw log was not edited and remains SHA-256
`2d0bc7743cb2742ef96fcb421b3a18eec5a92f3e47aeed677140f4e8b01e329f`.

## Mechanical score

- compiled mutants: 135;
- caught mutants: 133;
- raw score: 98.52%;
- score threshold result: PASS (`>=90%`).

The two raw UNCAUGHT rows are the `amount == 0` to `amount <= 0` mutation on uint256 values at
FeeVault source lines 71 and 94. They are semantically equivalent over the unsigned integer domain,
but remain counted as two UNCAUGHT mutants. The raw result is not reclassified or raised to 100%.

## Lifecycle and final gate

The tool emitted all three final class summaries, then did not exit cleanly. The runner's 120-second
post-report timeout terminated it with raw tool exit code 143. Therefore:

- score parser exit: 0;
- tool lifecycle: FAIL;
- final evidence result: FAIL;
- evidence integrity verification: PASS;
- `--require-pass`: FAIL.

The initial finalization also encountered a macOS awk portability error because `index` was used as a
loop variable. The bounded and full runners now share the pure Node parser
`scripts/security/parse-mutation-summary.mjs`; its tests cover the passing inventory plus missing class,
duplicate class, sub-90 score, malformed data, and impossible accounting. This parser repair changes
only evidence finalization and does not alter the retained tool execution.
