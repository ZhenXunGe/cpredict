#!/usr/bin/env bash
set -euo pipefail

for name in CPREDICT_STACK_MIGRATOR_PASSWORD CPREDICT_STACK_INDEXER_PASSWORD CPREDICT_STACK_PAYMASTER_PASSWORD CPREDICT_STACK_METADATA_PASSWORD CPREDICT_STACK_BACKUP_PASSWORD; do
  value="${!name:-}"
  [[ "$value" =~ ^[A-Za-z0-9_-]{24,128}$ ]] || {
    printf '%s\n' "$name must be 24-128 URL-safe characters" >&2
    exit 1
  }
done

psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv migrator_password CPREDICT_STACK_MIGRATOR_PASSWORD
\getenv indexer_password CPREDICT_STACK_INDEXER_PASSWORD
\getenv paymaster_password CPREDICT_STACK_PAYMASTER_PASSWORD
\getenv metadata_password CPREDICT_STACK_METADATA_PASSWORD
\getenv backup_password CPREDICT_STACK_BACKUP_PASSWORD
SELECT format('CREATE ROLE cpredict_migrator LOGIN PASSWORD %L', :'migrator_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cpredict_migrator') \gexec
SELECT format('CREATE ROLE cpredict_indexer LOGIN PASSWORD %L', :'indexer_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cpredict_indexer') \gexec
SELECT format('CREATE ROLE cpredict_paymaster LOGIN PASSWORD %L', :'paymaster_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cpredict_paymaster') \gexec
SELECT format('CREATE ROLE cpredict_metadata LOGIN PASSWORD %L', :'metadata_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cpredict_metadata') \gexec
SELECT format('CREATE ROLE cpredict_backup LOGIN PASSWORD %L', :'backup_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cpredict_backup') \gexec
SELECT format('ALTER ROLE cpredict_migrator LOGIN PASSWORD %L', :'migrator_password') \gexec
SELECT format('ALTER ROLE cpredict_indexer LOGIN PASSWORD %L', :'indexer_password') \gexec
SELECT format('ALTER ROLE cpredict_paymaster LOGIN PASSWORD %L', :'paymaster_password') \gexec
SELECT format('ALTER ROLE cpredict_metadata LOGIN PASSWORD %L', :'metadata_password') \gexec
SELECT format('ALTER ROLE cpredict_backup LOGIN PASSWORD %L', :'backup_password') \gexec
SELECT 'CREATE DATABASE cpredict_indexer OWNER cpredict_migrator'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cpredict_indexer') \gexec
SELECT 'CREATE DATABASE cpredict_paymaster OWNER cpredict_migrator'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cpredict_paymaster') \gexec
SELECT 'CREATE DATABASE cpredict_metadata OWNER cpredict_migrator'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'cpredict_metadata') \gexec
SQL
