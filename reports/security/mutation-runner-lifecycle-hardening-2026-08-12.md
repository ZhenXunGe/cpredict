# Mutation runner lifecycle hardening

Status date: 2026-08-12.

## Outcome

The previously observed FeeVault numeric result remains `133/135` (`98.52%`), but its retained
campaign is still **FAIL** because the original `slither-mutate` process exited `143` after the
post-report watchdog terminated it. No existing result or evidence file was promoted to PASS.

The runner implementation has been hardened and synthetic/focused checks pass. A fresh FeeVault
campaign and the required 12-contract campaign were **NOT RUN**, so the bounded and protocol-wide
mutation release gates remain open.

## Root cause and repair

The bounded command targeted the project directory (`.`). After emitting `Done mutating FeeVaultV1`
and all three summaries, `slither-mutate` continued its recursive Solidity-file traversal, logged
`No contracts were found in None`, and failed to exit before the 120-second watchdog. The hardened
runner targets the exact `src/core/FeeVaultV1.sol` file.

Both mutation runners now also:

- isolate each tool subprocess in its own process group;
- terminate and reap the entire group with bounded TERM/KILL handling;
- fail on an orphan group even when the parent exits zero;
- retain parent signal/EXIT cleanup while clearing inherited traps only in child wrappers;
- publish log/summary files through same-filesystem temporary rename;
- stage, verify, then publish evidence metadata and its sidecar fail-closed;
- bind summary triplets to the exact ordered contract inventory;
- keep the `>=90%` threshold and exact `12/12` full-campaign requirement;
- keep the explicit full-campaign opt-in guard.

## Focused verification

```text
bash syntax checks: PASS
mutation parser/lifecycle plus security gate parsers: 30/30 PASS
standalone lifecycle fixture repeated five times: 5/5 PASS
retained FeeVault raw-log parser replay: 133/135, 98.52%, numeric threshold PASS only
full runner without explicit confirmation: exit 64, no lock created
```

The lifecycle fixture covers clean exit, zero-exit orphan detection/cleanup, TERM/KILL cleanup,
parent EXIT-trap isolation, invalid timeout input, and atomic copy/write/append behavior.

An attempted exact-target smoke invocation was rejected before the mutator started because the
helper was sourced by the outer zsh instead of Bash (`set -m` unsupported in that context). It is
recorded as **NOT RUN**, not a retry or mutation result. Per the active execution boundary, it was
not retried and no real mutation campaign was started.

## Remaining acceptance

To close mutation gates, run on an exclusive Bash/macOS security runner and retain source-bound
evidence for:

1. a fresh exact-file FeeVault campaign with raw exit `0`, lifecycle PASS, validator `0`, and score
   `>=90%`;
2. all 12 production contracts, each with one completion marker and exact Revert/Comment/Tweak
   summaries, raw lifecycle success, aggregate score `>=90%`, and evidence verification PASS.

The prior full run spent `38:03` without completing the first contract. Existing six-hour CI/release
timeouts therefore have no demonstrated capacity margin; reserve an exclusive long-running runner
window or implement same-SHA per-contract sharding plus strict aggregation before scheduling the
formal 12-contract gate.
