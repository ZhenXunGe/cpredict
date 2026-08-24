#!/usr/bin/env bash
set -euo pipefail

kind="${1:-}"
case "$kind" in
  indexer)
    runtime_role=cpredict_indexer
    password_var=CPREDICT_STACK_INDEXER_PASSWORD
    migrations=(/migrations/001_indexer.sql /migrations/002_settlement_evidence.sql /migrations/003_read_api_indexes.sql)
    ;;
  paymaster)
    runtime_role=cpredict_paymaster
    password_var=CPREDICT_STACK_PAYMASTER_PASSWORD
    migrations=(/migrations/001_sponsor_budget.sql)
    ;;
  *) printf '%s\n' 'usage: run-cpredict-migrations indexer|paymaster' >&2; exit 2 ;;
esac

runtime_password="${!password_var:-}"
backup_password="${CPREDICT_STACK_BACKUP_PASSWORD:-}"
[[ "$runtime_password" =~ ^[A-Za-z0-9_-]{24,128}$ ]] || exit 2
[[ "$backup_password" =~ ^[A-Za-z0-9_-]{24,128}$ ]] || exit 2

for migration in "${migrations[@]}"; do
  psql --set=ON_ERROR_STOP=1 --file "$migration"
done

psql --set=ON_ERROR_STOP=1 --set=runtime_role="$runtime_role" <<'SQL'
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'runtime_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'runtime_role') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'runtime_role') \gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'runtime_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE cpredict_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'runtime_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE cpredict_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', :'runtime_role') \gexec
GRANT CONNECT ON DATABASE cpredict_indexer TO cpredict_backup;
GRANT CONNECT ON DATABASE cpredict_paymaster TO cpredict_backup;
GRANT USAGE ON SCHEMA public TO cpredict_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cpredict_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE cpredict_migrator IN SCHEMA public GRANT SELECT ON TABLES TO cpredict_backup;
SQL
