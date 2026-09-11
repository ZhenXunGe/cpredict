import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import {
  AppError,
  accountSchema,
  environmentKey,
  sameAddress,
  type Environment,
} from "../../app-core/src/contracts.js";
import { applyPublicSiteMigrations } from "./migrations.js";
import { quotaHistoryStart } from "./budget.js";

export function assertDeploymentRollover(
  previous: Environment,
  next: Environment,
): void {
  if (
    previous.id !== next.id ||
    previous.asset !== "ctUSD" ||
    next.asset !== "ctUSD" ||
    previous.deployment.chainId !== next.deployment.chainId ||
    !sameAddress(
      previous.deployment.paymentToken,
      next.deployment.paymentToken,
    ) ||
    previous.decimals !== next.decimals ||
    JSON.stringify(previous.account) !== JSON.stringify(next.account) ||
    previous.privyAppId !== next.privyAppId ||
    previous.walletConnectProjectId !== next.walletConnectProjectId
  )
    throw new AppError("rollover_account_or_asset_changed");
  if (
    previous.deployment.protocolVersion !== "legacy-v1" ||
    next.deployment.protocolVersion !== "time-v2" ||
    previous.deployment.id === next.deployment.id ||
    BigInt(next.deployment.deploymentBlock) <=
      BigInt(previous.deployment.deploymentBlock)
  )
    throw new AppError("rollover_requires_new_time_v2_deployment");
  for (const name of [
    "factory",
    "marketplace",
    "bondEscrow",
    "feeVault",
  ] as const)
    if (sameAddress(previous.deployment[name], next.deployment[name]))
      throw new AppError("rollover_reuses_legacy_contract");
}

const identifier = (value: string): string => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new AppError("invalid_rollover_schema");
  return value;
};

/** Offline cutover in the existing database. Current data is renamed intact;
 * only verified identities and admission quota history cross deployments.
 * The caller must use one DB connection and stop indexer/app before applying.
 */
export async function rolloverDeployment(
  sql: Sql,
  previous: Environment,
  next: Environment,
  apply = false,
) {
  assertDeploymentRollover(previous, next);
  const oldIdentity = environmentKey(previous),
    newIdentity = environmentKey(next);
  const active = identifier(
    (await sql<{ name: string }[]>`SELECT current_schema() AS name`)[0]!.name,
  );
  const suffix = (s: string) =>
    createHash("sha256").update(s).digest("hex").slice(0, 16);
  const archive = `cpredict_archive_${suffix(oldIdentity)}`;
  const staging = `cpredict_next_${suffix(newIdentity)}`;
  const identity = (
    await sql<
      { identity: string }[]
    >`SELECT identity FROM cpredict_environment_identity WHERE singleton`
  )[0]?.identity;
  if (identity === newIdentity) {
    const done = await sql<
      { previous_identity: string; archive_schema: string }[]
    >`SELECT previous_identity,archive_schema FROM app_deployment_rollover WHERE singleton`;
    if (
      done[0]?.previous_identity !== oldIdentity ||
      done[0].archive_schema !== archive
    )
      throw new AppError("rollover_record_mismatch");
    return {
      status: "already-applied",
      archiveSchema: archive,
      deploymentBlock: next.deployment.deploymentBlock,
    };
  }
  if (identity !== oldIdentity)
    throw new AppError("database_environment_mismatch");
  const pending = await sql<
    { count: string }[]
  >`SELECT count(*)::text AS count FROM app_operations
    WHERE state IN ('preparing','awaiting-signature','submitted','confirming','unknown')
      OR (state IN ('confirmed','reverted') AND coalesce(record->>'finality','pending') <> 'finalized')`;
  const deposits = await sql<
    { count: string }[]
  >`SELECT count(*)::text AS count FROM app_deposits
    WHERE operation_id IS NULL AND state <> 'cancelled' AND expires_at > now()`;
  if (pending[0]!.count !== "0" || deposits[0]!.count !== "0")
    throw new AppError("rollover_operations_need_recovery", 409);
  const accounts = await sql<
    { record: unknown }[]
  >`SELECT record FROM app_accounts ORDER BY id`;
  for (const row of accounts) {
    const a = accountSchema.parse(row.record);
    if (
      a.environment !== previous.id ||
      a.deploymentId !== previous.deployment.id ||
      a.index !== next.account.index ||
      a.kernelVersion !== next.account.kernelVersion ||
      a.entryPointVersion !== next.account.entryPointVersion ||
      a.derivationVersion !== next.account.derivationVersion
    )
      throw new AppError("rollover_account_mismatch");
  }
  const report = {
    status: apply ? "applied" : "ready-not-applied",
    archiveSchema: archive,
    accounts: accounts.length,
    deploymentBlock: next.deployment.deploymentBlock,
    previousIdentity: oldIdentity,
    currentIdentity: newIdentity,
  };
  if (!apply) return report;
  const live = await sql<
    { count: string }[]
  >`SELECT count(*)::text AS count FROM pg_stat_activity
    WHERE datname=current_database() AND usename='cpredict_indexer' AND pid<>pg_backend_pid()`;
  if (live[0]!.count !== "0")
    throw new AppError("rollover_stop_app_and_indexer_first", 409);
  if (
    (
      await sql`SELECT FROM pg_namespace WHERE nspname IN (${archive},${staging})`
    ).length
  )
    throw new AppError(
      "rollover_schema_already_exists_inspect_before_retry",
      409,
    );
  // Reuse the normal migration runner and registry in a private staging schema.
  // A failure leaves the live schema and every old row untouched.
  await sql`CREATE SCHEMA ${sql(staging)}`;
  try {
    await sql`SELECT set_config('search_path',${staging},false)`;
    await applyPublicSiteMigrations(sql);
  } finally {
    await sql`SELECT set_config('search_path',${active},false)`;
  }
  await sql.begin(async (tx) => {
    await tx`LOCK TABLE app_accounts,app_account_subjects,app_operations,app_deposits IN ACCESS EXCLUSIVE MODE`;
    const currentAccounts = await tx<
      { record: unknown }[]
    >`SELECT record FROM app_accounts ORDER BY id`;
    if (JSON.stringify(currentAccounts) !== JSON.stringify(accounts))
      throw new AppError(
        "rollover_accounts_changed_retry_after_inspection",
        409,
      );
    // Recheck after acquiring locks; an operation registered during preparation
    // must prevent a cutover, never be orphaned or sent again.
    const changed =
      await tx`SELECT FROM app_operations WHERE state IN ('preparing','awaiting-signature','submitted','confirming','unknown')
      OR (state IN ('confirmed','reverted') AND coalesce(record->>'finality','pending') <> 'finalized') LIMIT 1`;
    const newDeposits =
      await tx`SELECT FROM app_deposits WHERE operation_id IS NULL AND state <> 'cancelled' AND expires_at>now() LIMIT 1`;
    if (changed.length || newDeposits.length)
      throw new AppError("rollover_operations_need_recovery", 409);
    await tx`INSERT INTO ${tx(staging)}.cpredict_environment_identity(singleton,identity) VALUES(true,${newIdentity})`;
    await tx`INSERT INTO ${tx(staging)}.app_environment(singleton,identity) VALUES(true,${newIdentity})`;
    await tx`INSERT INTO ${tx(staging)}.ledger_environment(singleton,identity,deployment_block) VALUES(true,${newIdentity},${next.deployment.deploymentBlock})`;
    for (const row of accounts) {
      const a = accountSchema.parse({
        ...accountSchema.parse(row.record),
        deploymentId: next.deployment.id,
      });
      await tx`INSERT INTO ${tx(staging)}.app_accounts(id,environment,deployment_id,controller,address,record)
        VALUES(${a.id},${a.environment},${a.deploymentId},${a.controller},${a.address},${tx.json(a)})`;
      await tx`INSERT INTO ${tx(staging)}.ledger_tracked_accounts(address,from_block) VALUES(${a.address.toLowerCase()},${next.deployment.deploymentBlock})`;
    }
    await tx`INSERT INTO ${tx(staging)}.app_account_subjects SELECT * FROM app_account_subjects`;
    const hasCarryover = (
      await tx<
        { present: string | null }[]
      >`SELECT to_regclass('app_quota_operations')::text AS present`
    )[0]!.present;
    const source = hasCarryover ? "app_quota_operations" : "app_operations";
    const cutoff = quotaHistoryStart(new Date().toISOString());
    await tx`INSERT INTO ${tx(staging)}.app_quota_carryover
      SELECT id,subject,idempotency_key,request_hash,created_at,updated_at,state,lane,max_gas_cost,record
      FROM ${tx(source)} WHERE created_at>=${cutoff} OR updated_at>=${cutoff}`;
    await tx`INSERT INTO ${tx(staging)}.app_provider_invoice_lines SELECT * FROM app_provider_invoice_lines`;
    await tx`INSERT INTO ${tx(staging)}.app_deployment_rollover(singleton,previous_identity,current_identity,archive_schema)
      VALUES(true,${oldIdentity},${newIdentity},${archive})`;
    await tx`ALTER SCHEMA ${tx(active)} RENAME TO ${tx(archive)}`;
    await tx`ALTER SCHEMA ${tx(staging)} RENAME TO ${tx(active)}`;
    const runtimeRole = (
      await tx`SELECT FROM pg_roles WHERE rolname='cpredict_indexer'`
    ).length;
    if (runtimeRole) {
      await tx`REVOKE ALL ON SCHEMA ${tx(archive)} FROM cpredict_indexer`;
      await tx`REVOKE ALL ON SCHEMA ${tx(archive)} FROM PUBLIC`;
      await tx`GRANT USAGE ON SCHEMA ${tx(active)} TO cpredict_indexer`;
      await tx`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${tx(active)} TO cpredict_indexer`;
      await tx`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${tx(active)} TO cpredict_indexer`;
      await tx`REVOKE INSERT,UPDATE,DELETE ON public_site_migrations,app_quota_carryover,app_deployment_rollover FROM cpredict_indexer`;
    }
    if (
      (await tx`SELECT FROM pg_roles WHERE rolname='cpredict_backup'`).length
    ) {
      for (const schema of [archive, active]) {
        await tx`GRANT USAGE ON SCHEMA ${tx(schema)} TO cpredict_backup`;
        await tx`GRANT SELECT ON ALL TABLES IN SCHEMA ${tx(schema)} TO cpredict_backup`;
        await tx`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${tx(schema)} TO cpredict_backup`;
      }
    }
  });
  return report;
}
