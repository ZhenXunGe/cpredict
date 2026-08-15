# Full mutation campaign: ABORTED

Status date: 2026-08-09.

The single authorized full mutation campaign was safely stopped after the user requested that the
long-running workflow end. It was not retried and no other heavy security tool was started.

## Partial execution

- elapsed time: 2,283 seconds (`38:03`);
- completed expected contracts: `0/12`;
- active contract at termination: `FeeVaultV1`;
- completed sub-stage: Revert mutator, `16/16` caught;
- interrupted sub-stage: Comment mutator;
- whole-protocol compiled/caught totals and mutation score: unavailable because no contract reached
  its final three-class summary.

## Exit and evidence semantics

- outer runner exit code: `143` after TERM;
- evidence tool raw exit field: `255`, the runner's fail-closed sentinel because termination occurred
  before the normal child `wait` status assignment;
- validator exit code: `1`;
- evidence result: `FAIL`;
- evidence integrity verification: `PASS`;
- `--require-pass`: `FAIL`.

The summary correctly states `runner exited before validated completion`. This is partial/aborted
evidence only and must not be described as a whole-protocol mutation score.

## Cleanup and frozen inputs

- the mutation lock was cleared;
- no runner, mutator, Forge child, or campaign process remained;
- the 14 MiB isolated temporary worktree/artifacts were removed after confirming no open process held
  the exact temporary path;
- the 61-file `src/**` and Solidity `test/**` input inventories matched byte-for-byte before and after;
- both inventory manifests hash to
  `42e6149cbe73edf19ae09bd36cb6d7c9196ed982c98dde287b075ef1f781d759`.
