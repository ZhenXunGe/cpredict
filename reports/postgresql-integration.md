# PostgreSQL integration gate report

Date: 2026-08-08  
Status: pass (local real-database lane)  
Scope: Paymaster PostgreSQL budget store and Indexer PostgreSQL event store

## Toolchain evidence

- PostgreSQL: `postgres (PostgreSQL) 17.10`
- Installation: project-local `.tools/postgresql-17.10`
- Official source archive: `.tools/postgresql-src/postgresql-17.10.tar.bz2`
- Source archive SHA-256:
  `078a03516dcdbdb705fecaf415ea3d13a956c589e46f09fed68a06fb00598c90`
- Installed `postgres` binary SHA-256:
  `4f11ae3d583b906fbc6a1714ef2d2ed274db68e39b1cd73f26f0e1fd7ce370f8`
- Complete tool hashes: `manifests/postgresql-tools.lock`
- No global package, PATH, shell configuration, or machine runtime was changed.

## Defect and repair

`PostgresSponsorBudgetStore.ready()` previously treated an empty query result as ready because
optional chaining compared `undefined` only with `null`. A focused regression test reproduced the
failure (`4 total, 3 passed, 1 failed`). Readiness now requires:

1. a result row;
2. a non-null `sponsor_budget_user_usage` registration;
3. a non-null `sponsor_budget_leases` registration.

The regression suite covers an empty row set, either missing table, and a complete migration. A
real PostgreSQL integration case also creates an intentionally incomplete schema and verifies that
readiness fails closed.

## Final command

```bash
bash scripts/postgres-integration.sh
```

The script verifies the source archive, installed binary hashes and version before creating a new
`/private/tmp/cpredict-postgres.XXXXXX` cluster. It selects an unused port, binds PostgreSQL only to
`127.0.0.1`, passes `TEST_DATABASE_URL` directly to Vitest, validates JSON test reports, stops the
server in an exit trap and removes the temporary cluster only after shutdown succeeds.

## Final results

| Lane | Total | Passed | Failed | Skipped | Todo |
|---|---:|---:|---:|---:|---:|
| Paymaster readiness regression | 4 | 4 | 0 | 0 | 0 |
| Paymaster real PostgreSQL integration | 2 | 2 | 0 | 0 | 0 |
| Indexer real PostgreSQL integration | 3 | 3 | 0 | 0 | 0 |
| Total | 9 | 9 | 0 | 0 | 0 |

The Indexer lane applied the fresh-schema migration and the idempotent evidence upgrade, then
verified canonical rollback plus persistence of the terminal evidence hash and reconstruction of
its raw CID URI. A separate legacy-equivalent schema had its evidence column removed, proved that
`ready()` failed closed, applied `002_settlement_evidence.sql`, and proved readiness recovered.

The final temporary instance used `127.0.0.1:54020`. Cleanup evidence:

- `POSTGRES_STATUS_AFTER_STOP=3` (`pg_ctl`: no server running)
- `POSTGRES_READY_AFTER_STOP=2` (`pg_isready`: no response)
- independent `pg_isready` recheck returned `2`
- `/private/tmp/cpredict-postgres.bRfB4p` was absent after the gate
- no `cpredict-pg.*` or `cpredict-postgres.*` directory remained under `/private/tmp`

The JSON-result assertion was also exercised against an intentionally skipped run and rejected
`total=2 passed=0 failed=0 skipped=2 todo=0`; skipped integration tests therefore cannot satisfy
this gate.

## Additional checks

```bash
bash -n scripts/postgres-integration.sh
./node_modules/.bin/tsc -p tsconfig.json --noEmit
shasum -a 256 .tools/postgresql-src/postgresql-17.10.tar.bz2 \
  .tools/postgresql-17.10/bin/postgres
```

All completed successfully. This report is local runtime evidence only; it is not evidence for a
managed production PostgreSQL service, production TLS, backups, replication, restore drills or
failover.
