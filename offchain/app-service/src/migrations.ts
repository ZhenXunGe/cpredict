import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { AppError } from "../../app-core/src/contracts.js";

export const migrationPaths = [
  ...[
    "001_indexer.sql",
    "002_settlement_evidence.sql",
    "003_read_api_indexes.sql",
    "004_market_metadata.sql",
    "005_activity_catalog.sql",
    "006_financial_facts.sql",
    "007_legacy_deployment.sql",
    "008_orderbook.sql",
    "009_sparse_canonical_ranges.sql",
    "010_orderbook_watermark.sql",
  ].map((n) => `offchain/indexer/migrations/${n}`),
  "offchain/app-service/migrations/001_application.sql",
  "offchain/app-service/migrations/002_operational_queries.sql",
  "offchain/app-service/migrations/003_usdc_deposits.sql",
  "offchain/app-service/migrations/004_deployment_carryover.sql",
  "offchain/app-service/migrations/005_gas_accounting.sql",
  "offchain/app-service/migrations/006_trading_sessions.sql",
  "offchain/app-service/migrations/007_order_automation.sql",
  "offchain/app-service/migrations/008_automation_status_scope.sql",
  "offchain/app-service/migrations/009_automation_canonical_audit.sql",
  "offchain/app-service/migrations/010_automation_cleanup_quotas.sql",
];

/** Existing migration registry and checksums, shared by maintenance commands. */
export async function applyPublicSiteMigrations(sql: Sql): Promise<void> {
  await sql`SELECT pg_advisory_lock(hashtextextended('public-site-migrations',0))`;
  try {
    await sql`CREATE TABLE IF NOT EXISTS public_site_migrations(path text PRIMARY KEY,digest text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const path of migrationPaths) {
      const source = await readFile(resolve(path), "utf8"),
        digest = createHash("sha256").update(source).digest("hex"),
        old = (
          await sql<
            { digest: string }[]
          >`SELECT digest FROM public_site_migrations WHERE path=${path}`
        )[0];
      if (old) {
        if (old.digest !== digest)
          throw new AppError("applied_migration_changed", 409);
        continue;
      }
      await sql.unsafe(source);
      await sql`INSERT INTO public_site_migrations(path,digest) VALUES(${path},${digest})`;
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtextextended('public-site-migrations',0))`;
  }
}
