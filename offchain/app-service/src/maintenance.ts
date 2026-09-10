import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { z } from "zod";
import { createPublicClient, http, parseUnits } from "viem";
import { arbitrumSepolia } from "viem/chains";
import {
  AppError,
  environmentKey,
  jsonSafe,
  secureUrl,
  siteConfigSchema,
  uint,
} from "../../app-core/src/contracts.js";
import { leaderboardPeriodSchema } from "../../app-core/src/report-contracts.js";
import { appRuntimeSchema } from "./config.js";
import { verifyDeployment } from "./chain.js";
import { PostgresEventStore } from "../../indexer/src/postgres-store.js";
import { Leaderboards } from "../../indexer/src/leaderboards.js";
import {
  activateLedger,
  digestCode,
  reconcileLedger,
} from "../../indexer/src/reconciliation.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    environment: { type: "string" },
    input: { type: "string" },
    output: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    id: { type: "string" },
    batches: { type: "string", default: "1" },
  },
});
const command = positionals[0];
const required = (v: string | undefined, name: string) => {
  if (!v) throw new AppError(`missing_${name}`);
  return v;
};
const readJson = async (path: string) =>
  JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
const migrationPaths = [
  ...[
    "001_indexer.sql",
    "002_settlement_evidence.sql",
    "003_read_api_indexes.sql",
    "004_market_metadata.sql",
    "005_activity_catalog.sql",
    "006_financial_facts.sql",
  ].map((n) => `offchain/indexer/migrations/${n}`),
  "offchain/app-service/migrations/001_application.sql",
  "offchain/app-service/migrations/002_operational_queries.sql",
];
async function run() {
  if (command === "validate-site") {
    const paths = z.array(z.string()).min(1).max(8).parse(positionals.slice(1)),
      configs = await Promise.all(
        paths.map(async (p) => appRuntimeSchema.parse(await readJson(p))),
      );
    siteConfigSchema.parse({
      version: 1,
      defaultEnvironment: configs[0]!.environment.id,
      environments: configs.map((c) => c.environment),
    });
    const projects = configs
      .map((c) => c.sponsor?.projectId)
      .filter((v): v is string => !!v);
    if (new Set(projects).size !== projects.length)
      throw new AppError("provider_projects_must_be_separate");
    if (values.output) {
      await writeFile(
        resolve(values.output),
        JSON.stringify(
          {
            version: 1,
            defaultEnvironment: configs[0]!.environment.id,
            environments: configs.map((c) => c.environment),
          },
          null,
          2,
        ) + "\n",
        // This contains only the public environment fields and must be readable
        // by the unprivileged static server when bind-mounted from the host.
        { flag: "wx", mode: 0o644 },
      );
      await chmod(resolve(values.output), 0o644);
    }
    console.log(
      "Environment schemas and cross-environment separation validated. Provider dashboards and deployments still require verification.",
    );
    return;
  }
  if (
    ![
      "migrate",
      "status",
      "replay",
      "backfill",
      "reconcile",
      "activate",
      "shadow",
      "register-period",
      "publish-period",
      "import-invoice",
    ].includes(command ?? "")
  )
    throw new AppError("unknown_maintenance_command");
  const runtime = appRuntimeSchema.parse(
      await readJson(required(values.config, "config")),
    ),
    env = runtime.environment;
  if (values.environment !== env.id)
    throw new AppError("environment_confirmation_required");
  const databaseUrl = required(
      process.env.CPREDICT_MAINTENANCE_DATABASE_URL,
      "maintenance_database_url",
    ),
    dbUrl = new URL(databaseUrl);
  if (
    !["postgres:", "postgresql:"].includes(dbUrl.protocol) ||
    (!["localhost", "127.0.0.1", "[::1]"].includes(dbUrl.hostname) &&
      !["require", "verify-full"].includes(
        dbUrl.searchParams.get("sslmode") ?? "",
      ))
  )
    throw new AppError("database_tls_required");
  const sql = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 5,
    onnotice: () => undefined,
  });
  let store: PostgresEventStore | undefined;
  try {
    const exists = (
      await sql<
        { present: string | null }[]
      >`SELECT to_regclass('cpredict_environment_identity')::text AS present`
    )[0]?.present;
    if (exists) {
      const bound = (
        await sql<
          { identity: string }[]
        >`SELECT identity FROM cpredict_environment_identity WHERE singleton`
      )[0];
      if (bound && bound.identity !== environmentKey(env))
        throw new AppError("database_environment_mismatch");
    }
    if (command === "migrate") {
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
    store = new PostgresEventStore(databaseUrl, 2, env);
    await store.ready();
    const ledger = store.financial!;
    if (command === "migrate") {
      console.log(
        `Applied additive migrations for ${env.id}; legacy tables retained.`,
      );
      return;
    }
    if (command === "status") {
      const snapshot = await ledger.snapshot();
      console.log(
        JSON.stringify(
          jsonSafe({
            snapshot,
            backfill: await ledger.accountBackfillRange(
              BigInt(snapshot.blockNumber),
            ),
          }),
          null,
          2,
        ),
      );
      return;
    }
    if (command === "shadow") {
      await sql`UPDATE ledger_environment SET status='shadow' WHERE singleton`;
      console.log(
        "Financial reads remain available as shadow; leaderboard publication is paused.",
      );
      return;
    }
    if (command === "replay") {
      const from = BigInt(uint.parse(required(values.from, "from"))),
        to = BigInt(uint.parse(required(values.to, "to"))),
        snapshot = await ledger.snapshot();
      if (to > BigInt(snapshot.blockNumber) || to - from > 100000n)
        throw new AppError("replay_range_invalid");
      await store.replayFinancial(from, to);
      console.log(
        "Shadow replay complete. Coverage was not promoted; reconcile before activation.",
      );
      return;
    }
    if (command === "register-period" || command === "publish-period") {
      const boards = new Leaderboards(ledger);
      if (command === "register-period") {
        const fields = leaderboardPeriodSchema.shape,
          period = z
            .strictObject({
              id: fields.id,
              startsAt: fields.startsAt,
              endsAt: fields.endsAt,
              markets: fields.markets,
            })
            .parse(await readJson(required(values.input, "input"))),
          now = new Date();
        await boards.register(
          { ...period, publishedAt: String(Math.floor(now.getTime() / 1000)) },
          now,
        );
      } else await boards.publish(required(values.id, "id"));
      console.log(
        "Leaderboard database operation completed; roster and historical versions retained.",
      );
      return;
    }
    if (command === "import-invoice") {
      const invoice = z
        .strictObject({
          reference: z.string().min(1).max(160),
          start: z.string().datetime(),
          end: z.string().datetime(),
          amount: z.string().regex(/^\d{1,16}(\.\d{1,8})?$/),
          currency: z.string().regex(/^[A-Z]{3}$/),
        })
        .parse(await readJson(required(values.input, "input")));
      if (invoice.start >= invoice.end)
        throw new AppError("invalid_invoice_window");
      await sql`INSERT INTO app_provider_invoice_lines(reference,starts_at,ends_at,amount,currency) VALUES(${invoice.reference},${invoice.start},${invoice.end},${invoice.amount},${invoice.currency}) ON CONFLICT DO NOTHING`;
      const old = (
        await sql<
          { amount: string; currency: string; starts_at: Date; ends_at: Date }[]
        >`SELECT * FROM app_provider_invoice_lines WHERE reference=${invoice.reference}`
      )[0]!;
      if (
        old.currency !== invoice.currency ||
        parseUnits(old.amount, 8) !== parseUnits(invoice.amount, 8) ||
        old.starts_at.toISOString() !== new Date(invoice.start).toISOString() ||
        old.ends_at.toISOString() !== new Date(invoice.end).toISOString()
      )
        throw new AppError("invoice_reference_conflict", 409);
      console.log(
        "Original billing interval imported without daily prorating.",
      );
      return;
    }
    const codeDigest = digestCode(
      await Promise.all(
        [
          "offchain/indexer/src/reconciliation.js",
          "offchain/indexer/src/financial-facts.js",
          "offchain/indexer/src/financial-store.js",
          "offchain/app-core/src/pnl.js",
        ].map((p) => readFile(resolve("dist", p), "utf8")),
      ),
    );
    const client = createPublicClient({
      chain: arbitrumSepolia,
      transport: http(
        secureUrl.parse(
          required(
            process.env.CPREDICT_MAINTENANCE_RPC_URL,
            "maintenance_rpc_url",
          ),
        ),
        { retryCount: 0, timeout: 10000 },
      ),
    });
    await verifyDeployment(client, env);
    if (command === "backfill") {
      const count = z.coerce
        .number()
        .int()
        .min(1)
        .max(1000)
        .parse(values.batches);
      for (let i = 0; i < count; i++)
        await store.backfillFinancialAccounts(client);
      console.log(
        "Scoped account backfill batches complete; inspect status for remaining coverage.",
      );
      return;
    }
    if (command === "reconcile") {
      const report = await reconcileLedger(ledger, client, codeDigest);
      if (values.output)
        await writeFile(
          resolve(values.output),
          JSON.stringify(report, null, 2) + "\n",
          { flag: "wx", mode: 0o600 },
        );
      console.log(
        JSON.stringify({
          id: report.id,
          environment: env.id,
          passed: report.passed,
          checks: report.results.length,
          failed: report.results.filter((r) => !r.passed).length,
          block: report.snapshot.blockNumber,
        }),
      );
      if (!report.passed) process.exitCode = 1;
      return;
    }
    if (command === "activate") {
      const id = required(values.id, "id"),
        row = (
          await sql<
            { report: unknown }[]
          >`SELECT report FROM ledger_reconciliations WHERE id=${z.string().uuid().parse(id)}`
        )[0],
        report = z
          .object({
            snapshot: z.object({ blockNumber: uint, blockHash: z.string() }),
          })
          .parse(row?.report);
      if (
        (
          await client.getBlock({
            blockNumber: BigInt(report.snapshot.blockNumber),
          })
        ).hash !== report.snapshot.blockHash
      )
        throw new AppError("snapshot_invalidated", 409);
      await activateLedger(ledger, id, codeDigest);
      console.log(
        "Reconciled financial projection activated at the exact checked database snapshot.",
      );
    }
  } finally {
    await store?.close();
    await sql.end({ timeout: 5 });
  }
}
run().catch((error) => {
  console.error(
    error instanceof AppError
      ? error.code
      : error instanceof z.ZodError
        ? "configuration_or_input_invalid"
        : "maintenance_failed; check service connectivity, schema and input without logging credentials",
  );
  process.exitCode = 1;
});
