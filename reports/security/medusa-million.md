# Medusa 1.5.1 million-call campaign

- Executed: 2026-08-08 (Asia/Shanghai)
- Target: `EchidnaMarketAccounting`
- Configuration: `scripts/security/medusa.json`
- Sequence length: 128
- Workers: 4
- Actual calls: 1,024,046
- Failing sequences observed during campaign: 0
- Final result: 27 tests passed, 0 failed; process exit code 0
- Raw evidence: `reports/security/medusa-million.log`
- Coverage artifact: `reports/security/medusa-corpus/coverage/lcov.info`

The four economic properties cover Vault asset/liability solvency, aggregate ERC-1155 supply,
conservative Launch Guard reporting, and FeeVault/BondEscrow credit solvency. Stateful actions cover
primary buy, transfer, resolve/creator-void/timeout, bond settlement, all claims, losing-position
burn, Guard sync, and fee/bond credit claims.

This passes the Medusa `>=1,000,000 calls` lane. Echidna arm64 subsequently passed its own
1,000,053-call campaign; x86_64 lifecycle, mutation, external-audit, commercial-load and
deployed-runtime lanes remain separate. Halmos and SMTChecker results have their own bounded-scope
reports and are not inferred from this campaign.
