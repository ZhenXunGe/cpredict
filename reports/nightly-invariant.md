# Nightly invariant execution report

- Executed: 2026-08-08 (Asia/Shanghai)
- Command: `FOUNDRY_PROFILE=nightly bash scripts/forge.sh test --match-path test/invariant/MarketAccounting.invariant.t.sol -vv`
- Profile: Foundry `nightly`; Solidity 0.8.36; production `viaIR`; invariant runs 10,000;
  invariant depth 256; `fail_on_revert=true`
- Result: PASS, process exit code 0
- Suite wall time: 326.86 seconds (1,012.66 seconds reported CPU time)

| Invariant | Runs | Calls | Reverts | Result |
|---|---:|---:|---:|---|
| `invariantGuardNeverUnderReportsMarketExposure` | 10,000 | 2,560,000 | 0 | PASS |
| `invariantSegregatedVaultsRemainSolvent` | 10,000 | 2,560,000 | 0 | PASS |
| `invariantSupplyAccountingIsInternallyConsistent` | 10,000 | 2,560,000 | 0 | PASS |
| `invariantVaultAssetsCoverAllLiveLiabilities` | 10,000 | 2,560,000 | 0 | PASS |

The deterministic call distribution reported for each invariant was 512,151 `buy`, 511,644
`creatorVoid`, 512,489 `refund`, 512,725 `syncGuard`, and 510,991 `transfer` handler calls.

After the successful suite result, Forge emitted a warning that it could not write
`/Users/undef1ned/.foundry/cache/signatures` because the workspace sandbox does not permit that
user-level cache write. The warning occurred after the PASS summary and did not change exit code 0.
It is retained here as an environment note and is not represented as a protocol test failure.
