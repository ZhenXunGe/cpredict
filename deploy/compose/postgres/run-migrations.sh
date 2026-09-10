#!/usr/bin/env bash
set -euo pipefail

kind="${1:-}"
case "$kind" in
  indexer)
    runtime_role=cpredict_indexer
    password_var=CPREDICT_STACK_INDEXER_PASSWORD
    migrations=(
      /migrations/001_indexer.sql
      /migrations/002_settlement_evidence.sql
      /migrations/003_read_api_indexes.sql
      /migrations/004_market_metadata.sql
      /migrations/005_activity_catalog.sql
      /migrations/006_financial_facts.sql
    )
    ;;
  paymaster)
    runtime_role=cpredict_paymaster
    password_var=CPREDICT_STACK_PAYMASTER_PASSWORD
    migrations=(
      /migrations/001_sponsor_budget.sql
      /migrations/002_permit2_relay_intents.sql
    )
    ;;
  metadata)
    runtime_role=cpredict_metadata
    password_var=CPREDICT_STACK_METADATA_PASSWORD
    migrations=(/migrations/001_metadata.sql)
    ;;
  app)
    runtime_role=cpredict_indexer
    password_var=CPREDICT_STACK_INDEXER_PASSWORD
    migrations=(/migrations/001_application.sql /migrations/002_operational_queries.sql)
    ;;
  *) printf '%s\n' 'usage: run-cpredict-migrations indexer|paymaster|metadata|app [migration-directory]' >&2; exit 2 ;;
esac

case "${CPREDICT_STACK_DATABASE_ENVIRONMENT:-ctusd}" in
  ctusd) ;;
  usdc)
    case "$kind" in
      indexer|app) runtime_role=cpredict_usdc_indexer; password_var=CPREDICT_STACK_USDC_INDEXER_PASSWORD ;;
      metadata) runtime_role=cpredict_usdc_metadata; password_var=CPREDICT_STACK_USDC_METADATA_PASSWORD ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac

if [[ -n "${2:-}" ]]; then
  [[ "$2" =~ ^/[A-Za-z0-9_./-]+$ && -d "$2" ]] || exit 2
  for i in "${!migrations[@]}"; do migrations[$i]="$2/${migrations[$i]##*/}"; done
fi

runtime_password="${!password_var:-}"
backup_password="${CPREDICT_STACK_BACKUP_PASSWORD:-}"
[[ "$runtime_password" =~ ^[A-Za-z0-9_-]{24,128}$ ]] || exit 2
[[ "$backup_password" =~ ^[A-Za-z0-9_-]{24,128}$ ]] || exit 2

# Share the existing maintenance tool's registry and lock, including its exact
# repository-relative paths. SQL files retain their existing transactions.
case "$kind" in
  indexer) source_directory=offchain/indexer/migrations ;;
  *) source_directory="offchain/${kind}-service/migrations" ;;
esac
{
  printf '%s\n' "SELECT pg_advisory_lock(hashtextextended('public-site-migrations',0));"
  printf '%s\n' 'CREATE TABLE IF NOT EXISTS public_site_migrations(path text PRIMARY KEY,digest text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());'
  for migration in "${migrations[@]}"; do
    name="${migration##*/}"
    if command -v sha256sum >/dev/null; then digest="$(sha256sum "$migration")"; else digest="$(shasum -a 256 "$migration")"; fi
    digest="${digest%% *}"
    [[ "$digest" =~ ^[0-9a-f]{64}$ && "$name" =~ ^[0-9]{3}_[a-z0-9_]+\.sql$ ]] || { printf '%s\n' 'invalid migration filename or digest' >&2; exit 2; }
    source_path="$source_directory/$name"
    printf "SELECT EXISTS(SELECT FROM public_site_migrations WHERE path='%s') AS applied, NOT EXISTS(SELECT FROM public_site_migrations WHERE path='%s' AND digest<>'%s') AS matches \\gset\n" "$source_path" "$source_path" "$digest"
    printf '%s\n' '\if :matches' '\else' 'DO $$ BEGIN RAISE EXCEPTION '\''applied migration checksum changed'\''; END $$;' '\endif' '\if :applied' '\else'
    printf '\\i %s\n' "$migration"
    printf "INSERT INTO public_site_migrations(path,digest) VALUES('%s','%s');\n" "$source_path" "$digest"
    printf '%s\n' '\endif'
  done
} | psql --set=ON_ERROR_STOP=1

psql --set=ON_ERROR_STOP=1 --set=runtime_role="$runtime_role" <<'SQL'
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'runtime_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'runtime_role') \gexec
SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'runtime_role') \gexec
SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'runtime_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE cpredict_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'runtime_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE cpredict_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', :'runtime_role') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO cpredict_backup', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO cpredict_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO cpredict_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO cpredict_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE cpredict_migrator IN SCHEMA public GRANT SELECT ON TABLES TO cpredict_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE cpredict_migrator IN SCHEMA public GRANT SELECT ON SEQUENCES TO cpredict_backup;
SELECT format('REVOKE INSERT,UPDATE,DELETE ON public_site_migrations FROM %I', :'runtime_role') \gexec
SQL
