import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { backupColumnsSql, buildSnapshotSql } from "./backup.mjs";

/** Called only by test-postgres.mjs inside the disposable cluster it owns.
 * Never run against an operator's TEST_DATABASE_URL: bootstrap creates roles. */
export async function verifyInPlaceUpgrade({ root, pg, directory, port }) {
  assert.match(directory, /^\/private\/tmp\/cpredict-public-pg-[A-Za-z0-9]+$/);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  const env = {
    ...process.env, PATH: `${pg}:${process.env.PATH}`,
    PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "cpredict_test", PGDATABASE: "postgres",
    POSTGRES_USER: "cpredict_test", POSTGRES_DB: "postgres",
  };
  for (const key of ["MIGRATOR", "INDEXER", "PAYMASTER", "METADATA", "BACKUP", "USDC_INDEXER", "USDC_METADATA"])
    env[`CPREDICT_STACK_${key}_PASSWORD`] = `disposable_${key}_${"x".repeat(24)}`;
  const checks = [];
  function run(file, args, extra = {}, expected = 0) {
    const result = spawnSync(file, args, { cwd: root, env: { ...env, ...extra }, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    if (expected === 0) assert.equal(result.status, 0, `${file}: ${(result.stderr || result.stdout).slice(-1800)}`);
    else assert.notEqual(result.status, 0, `${file}: expected rejection`);
    return result;
  }
  const sql = (database, command, user = "cpredict_migrator", expected = 0) => run(resolve(pg, "psql"), ["-XAt", "-v", "ON_ERROR_STOP=1", "-d", database, "-U", user, "-c", command], {}, expected);
  const bootstrap = resolve(root, "deploy/compose/postgres/init/00-create-databases.sh");
  const runner = resolve(root, "deploy/compose/postgres/run-migrations.sh");
  const migrate = (database, kind, usdc = false, migrationPath = resolve(root, `offchain/${kind === "app" ? "app-service" : kind === "indexer" ? "indexer" : `${kind}-service`}/migrations`), expected = 0) =>
    run("bash", [runner, kind, migrationPath], { PGDATABASE: database, PGUSER: "cpredict_migrator", CPREDICT_STACK_DATABASE_ENVIRONMENT: usdc ? "usdc" : "ctusd" }, expected);

  run("bash", [bootstrap]);
  // Simulate the existing database before migration tracking and application tables.
  const oldMigrations = ["001_indexer.sql", "002_settlement_evidence.sql", "003_read_api_indexes.sql", "004_market_metadata.sql", "005_activity_catalog.sql"];
  for (const file of oldMigrations) run(resolve(pg, "psql"), ["-X", "-v", "ON_ERROR_STOP=1", "-U", "cpredict_migrator", "-d", "cpredict_indexer", "-f", resolve(root, "offchain/indexer/migrations", file)]);
  const hash = (n) => `0x${String(n).repeat(64)}`;
  const address = `0x${"1".repeat(40)}`;
  sql("cpredict_indexer", `INSERT INTO canonical_blocks VALUES(421614,1,'${hash(1)}','${hash(0)}',1,'confirmed');
    INSERT INTO chain_events(chain_id,block_number,block_hash,transaction_hash,transaction_index,log_index,contract_address,topics,data,confirmation_status)
    VALUES(421614,1,'${hash(1)}','${hash(2)}',0,0,'${address}','[]','0x','confirmed');
    INSERT INTO chain_checkpoints(chain_id,block_number,block_hash) VALUES(421614,1,'${hash(1)}');`);
  const historySql = "SELECT jsonb_agg(to_jsonb(e) ORDER BY chain_id,transaction_hash,log_index)::text FROM chain_events e";
  const oldHistory = sql("cpredict_indexer", historySql).stdout.trim();
  const oldColumns = JSON.parse(sql("cpredict_indexer", backupColumnsSql).stdout.trim());
  const oldBackupSql = buildSnapshotSql("indexer", Object.keys(oldColumns), { fingerprints: true, columns: oldColumns });
  const oldBackup = sql("cpredict_indexer", oldBackupSql).stdout.trim();
  migrate("cpredict_indexer", "indexer");
  migrate("cpredict_indexer", "app");
  migrate("cpredict_metadata", "metadata");
  migrate("cpredict_paymaster", "paymaster");
  assert.equal(sql("cpredict_indexer", historySql, "cpredict_indexer").stdout.trim(), oldHistory);
  assert.equal(sql("cpredict_indexer", oldBackupSql, "cpredict_backup").stdout.trim(), oldBackup);
  checks.push("legacy rows preserved and readable by original runtime role");

  sql("cpredict_indexer", `INSERT INTO app_accounts VALUES('10000000-0000-4000-8000-000000000001','ctusd-proof','deployment-proof','${address}','${address}','{}');
    INSERT INTO app_operations(id,subject,idempotency_key,request_hash,account_id,sender,nonce,call_hash,state,kind,lane,created_at,updated_at,expires_at,max_gas_cost,record)
    VALUES('20000000-0000-4000-8000-000000000001','did:privy:proof','30000000-0000-4000-8000-000000000001','request-proof','10000000-0000-4000-8000-000000000001','${address}',0,'${hash(3)}','unknown','transfer','exit',now(),now(),now()+interval '5 minutes',1000,'{"userOperationHash":"${hash(4)}","providerOperationId":"proof"}');
    INSERT INTO ledger_facts(chain_id,block_number,transaction_hash,transaction_index,log_index,fact_index,occurred_at,kind,owner,fact)
    VALUES(421614,1,'${hash(2)}',0,0,0,1,'proof','${address}','{"amount":"1000000"}');`, "cpredict_indexer");
  const snapshotSql = `SELECT jsonb_build_object(
    'events',(SELECT jsonb_agg(to_jsonb(e)) FROM chain_events e),
    'operations',(SELECT jsonb_agg(to_jsonb(o)) FROM app_operations o),
    'facts',(SELECT jsonb_agg(to_jsonb(f)) FROM ledger_facts f),
    'migrations',(SELECT jsonb_agg(to_jsonb(m) ORDER BY path) FROM public_site_migrations m))::text`;
  const before = sql("cpredict_indexer", snapshotSql).stdout.trim();
  migrate("cpredict_indexer", "indexer");
  migrate("cpredict_indexer", "app");
  assert.equal(sql("cpredict_indexer", snapshotSql).stdout.trim(), before);
  checks.push("repeat migrations preserve unknown operation identity, hashes, amounts and migration records");
  sql("cpredict_indexer", "DELETE FROM public_site_migrations", "cpredict_indexer", 1);
  checks.push("runtime cannot rewrite migration history");
  const altered = resolve(directory, "altered-migrations");
  await cp(resolve(root, "offchain/indexer/migrations"), altered, { recursive: true });
  const changed = resolve(altered, "006_financial_facts.sql");
  await writeFile(changed, `${await readFile(changed, "utf8")}\n-- checksum drift\n`);
  const rejected = migrate("cpredict_indexer", "indexer", false, altered, 1);
  assert.match(rejected.stderr, /checksum changed/);
  assert.equal(sql("cpredict_indexer", snapshotSql).stdout.trim(), before);
  checks.push("changed applied SQL rejected without altering data");

  run("bash", [bootstrap, "usdc"]);
  run("bash", [bootstrap, "usdc"]);
  migrate("cpredict_usdc_indexer", "indexer", true);
  migrate("cpredict_usdc_indexer", "app", true);
  migrate("cpredict_usdc_metadata", "metadata", true);
  assert.equal(sql("cpredict_usdc_indexer", "SELECT count(*) FROM app_operations", "cpredict_usdc_indexer").stdout.trim(), "0");
  for (const [database, user] of [["cpredict_indexer", "cpredict_usdc_indexer"], ["cpredict_usdc_indexer", "cpredict_indexer"], ["cpredict_metadata", "cpredict_usdc_metadata"], ["cpredict_usdc_metadata", "cpredict_metadata"]]) {
    const denied = sql(database, "SELECT 1", user, 1);
    assert.match(denied.stderr, /permission denied for database/);
  }
  checks.push("USDC databases independently bootstrapped and runtime roles cannot connect across environments");
  for (const database of ["cpredict_indexer", "cpredict_usdc_indexer"]) {
    const dump = resolve(directory, `${database}.dump`);
    const expected = sql(database, snapshotSql, "cpredict_backup").stdout.trim();
    const columns = JSON.parse(sql(database, backupColumnsSql, "cpredict_backup").stdout.trim());
    const completeSql = buildSnapshotSql("indexer", Object.keys(columns), { fingerprints: true, columns });
    const allContents = sql(database, completeSql, "cpredict_backup").stdout.trim();
    run(resolve(pg, "pg_dump"), ["-U", "cpredict_backup", "-d", database, "-Fc", "--no-owner", "--no-privileges", "-f", dump]);
    const restored = `${database}_restored`;
    sql("postgres", `CREATE DATABASE ${restored}`, "cpredict_test");
    run(resolve(pg, "pg_restore"), ["-U", "cpredict_test", "-d", restored, "--no-owner", "--no-privileges", "--exit-on-error", dump]);
    assert.equal(sql(restored, snapshotSql, "cpredict_test").stdout.trim(), expected);
    assert.equal(sql(restored, completeSql, "cpredict_test").stdout.trim(), allContents);
    checks.push(`${database} custom-format backup restores exact history, financial facts and operation recovery records`);
  }
  const binaryEvidence = {};
  for (const name of ["pg_dump", "pg_restore"]) binaryEvidence[name] = {
    version: run(resolve(pg, name), ["--version"]).stdout.trim(),
    sha256: createHash("sha256").update(await readFile(resolve(pg, name))).digest("hex"),
  };
  return { status: "PASS", evidenceClass: "LOCAL_DISPOSABLE_POSTGRES_UPGRADE", generatedAt: new Date().toISOString(), checks, binaryEvidence };
}
