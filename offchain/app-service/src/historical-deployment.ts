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

export function assertHistoricalSuccessor(
  previous: Environment,
  next: Environment,
) {
  if (
    previous.id === next.id ||
    previous.asset !== "ctUSD" ||
    next.asset !== previous.asset ||
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
    throw new AppError("historical_successor_wallet_or_asset_changed");
  if (
    previous.deployment.protocolVersion !== "time-v2" ||
    next.deployment.protocolVersion !== "time-v2" ||
    previous.deployment.id === next.deployment.id ||
    BigInt(next.deployment.deploymentBlock) <=
      BigInt(previous.deployment.deploymentBlock)
  )
    throw new AppError("historical_successor_requires_new_deployment");
  for (const key of [
    "factory",
    "marketplace",
    "bondEscrow",
    "feeVault",
  ] as const)
    if (sameAddress(previous.deployment[key], next.deployment[key]))
      throw new AppError("historical_successor_reuses_contract");
}
const identifier = (s: string) => {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(s))
    throw new AppError("invalid_history_schema");
  return s;
};
export function successorSchema(next: Environment) {
  return `cpredict_current_${createHash("sha256").update(environmentKey(next)).digest("hex").slice(0, 16)}`;
}

/** Creates a separate current schema. The original schema, deployment identity,
 * pending operations, ledger and claims stay live. Both services must use the
 * shared admission lock before this maintenance step. No chain transaction is sent.
 * Use a dedicated, single-connection maintenance client (prepare: false).
 */
export async function prepareHistoricalSuccessor(
  sql: Sql,
  previous: Environment,
  next: Environment,
  apply = false,
) {
  assertHistoricalSuccessor(previous, next);
  const original = identifier(
    (await sql<{ name: string }[]>`SELECT current_schema() AS name`)[0]!.name,
  );
  const target = successorSchema(next),
    oldIdentity = environmentKey(previous),
    newIdentity = environmentKey(next);
  const binding = (
    await sql<
      { identity: string }[]
    >`SELECT identity FROM cpredict_environment_identity WHERE singleton`
  )[0]?.identity;
  if (binding !== oldIdentity)
    throw new AppError("database_environment_mismatch");
  const report = {
    status: apply ? "prepared" : "ready-not-applied",
    historicalSchema: original,
    currentSchema: target,
    previousIdentity: oldIdentity,
    currentIdentity: newIdentity,
  };
  if (!apply) return report;
  if ((await sql`SELECT FROM pg_namespace WHERE nspname=${target}`).length)
    throw new AppError("successor_schema_exists_inspect_before_retry", 409);
  await sql`CREATE SCHEMA ${sql(target)}`;
  try {
    await sql`SELECT set_config('search_path',${target},false)`;
    await applyPublicSiteMigrations(sql);
  } finally {
    await sql`SELECT set_config('search_path',${original},false)`;
  }
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('cpredict-shared-admission',0))`;
    await tx`LOCK TABLE app_accounts,app_account_subjects,app_operations IN ACCESS EXCLUSIVE MODE`;
    await tx`INSERT INTO ${tx(target)}.cpredict_environment_identity(singleton,identity) VALUES(true,${newIdentity})`;
    await tx`INSERT INTO ${tx(target)}.app_environment(singleton,identity) VALUES(true,${newIdentity})`;
    await tx`INSERT INTO ${tx(target)}.ledger_environment(singleton,identity,deployment_block) VALUES(true,${newIdentity},${next.deployment.deploymentBlock})`;
    const accounts = await tx<
      { record: unknown }[]
    >`SELECT record FROM app_accounts ORDER BY id`;
    for (const row of accounts) {
      const old = accountSchema.parse(row.record);
      if (
        old.environment !== previous.id ||
        old.deploymentId !== previous.deployment.id ||
        old.index !== next.account.index
      )
        throw new AppError("historical_account_mismatch");
      const a = accountSchema.parse({
        ...old,
        environment: next.id,
        deploymentId: next.deployment.id,
      });
      await tx`INSERT INTO ${tx(target)}.app_accounts(id,environment,deployment_id,controller,address,record)
        VALUES(${a.id},${a.environment},${a.deploymentId},${a.controller},${a.address},${tx.json(a)})`;
      await tx`INSERT INTO ${tx(target)}.ledger_tracked_accounts(address,from_block) VALUES(${a.address.toLowerCase()},${next.deployment.deploymentBlock})`;
    }
    await tx`INSERT INTO ${tx(target)}.app_account_subjects SELECT * FROM app_account_subjects`;
    // Views include live reservations and later finalized charges in BOTH directions.
    // Carryover belongs to the old schema only; copying it would double count.
    for (const schema of [original, target]) {
      await tx`CREATE OR REPLACE VIEW ${tx(schema)}.app_quota_operations AS
        SELECT id,subject,idempotency_key,request_hash,created_at,updated_at,state,lane,max_gas_cost,record,billing FROM ${tx(original)}.app_operations
        UNION ALL SELECT id,subject,idempotency_key,request_hash,created_at,updated_at,state,lane,max_gas_cost,record,billing FROM ${tx(original)}.app_quota_carryover
        UNION ALL SELECT id,subject,idempotency_key,request_hash,created_at,updated_at,state,lane,max_gas_cost,record,billing FROM ${tx(target)}.app_operations`;
    }
    await tx`INSERT INTO ${tx(target)}.app_deployment_rollover(singleton,previous_identity,current_identity,archive_schema)
      VALUES(true,${oldIdentity},${newIdentity},${original})`;
    if (
      (await tx`SELECT FROM pg_roles WHERE rolname='cpredict_indexer'`).length
    ) {
      await tx`GRANT USAGE ON SCHEMA ${tx(target)} TO cpredict_indexer`;
      await tx`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${tx(target)} TO cpredict_indexer`;
      await tx`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${tx(target)} TO cpredict_indexer`;
      await tx`REVOKE INSERT,UPDATE,DELETE ON ${tx(target)}.public_site_migrations,${tx(target)}.app_quota_carryover,${tx(target)}.app_deployment_rollover FROM cpredict_indexer`;
    }
    if (
      (await tx`SELECT FROM pg_roles WHERE rolname='cpredict_backup'`).length
    ) {
      await tx`GRANT USAGE ON SCHEMA ${tx(target)} TO cpredict_backup`;
      await tx`GRANT SELECT ON ALL TABLES IN SCHEMA ${tx(target)} TO cpredict_backup`;
      await tx`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${tx(target)} TO cpredict_backup`;
    }
  });
  return report;
}
