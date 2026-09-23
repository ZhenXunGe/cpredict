import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import postgres from "postgres";
import Fastify from "fastify";
import { Registry, Counter, Gauge } from "prom-client";
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import {
  environmentSchema,
  secureUrl,
  positive,
  address,
} from "../../app-core/src/contracts.js";
import {
  RpcReadPool,
  parseRpcFallbackConfig,
  READ_METHODS,
} from "../../app-core/src/rpc-pool.js";
import { verifyDeployment } from "../../app-service/src/chain.js";
import { PostgresFinancialLedger } from "../../indexer/src/financial-store.js";
import { AutomaticClaimsWorker } from "./automatic-claims.js";
import { PostgresAutomaticStore } from "./automatic-store.js";
import { ViemAutomationChain } from "./automatic-chain.js";
import { LedgerAutomaticSource } from "./automatic-source.js";
import { submissionEndpointReady } from "./automatic-submission.js";
import { MatchingSource } from "./matching-source.js";
const databaseUrl = z
  .string()
  .url()
  .refine((value) => {
    const u = new URL(value);
    return (
      ["postgres:", "postgresql:"].includes(u.protocol) &&
      (["127.0.0.1", "localhost", "[::1]", "postgres"].includes(u.hostname) ||
        ["require", "verify-full"].includes(
          u.searchParams.get("sslmode") ?? "",
        ))
    );
  }, "database requires TLS or local endpoint");
export const automationConfigSchema = z.object({
  CPREDICT_AUTOMATION_ENVIRONMENT_FILE: z.string().startsWith("/"),
  CPREDICT_AUTOMATION_KEY_FILE: z.string().startsWith("/"),
  CPREDICT_AUTOMATION_EXPECTED_SIGNER: address,
  CPREDICT_AUTOMATION_RPC_URL: secureUrl,
  CPREDICT_AUTOMATION_WRITE_RPC_URL: secureUrl.optional(),
  CPREDICT_AUTOMATION_DATABASE_URL: databaseUrl,
  CPREDICT_AUTOMATION_CONTROL_DATABASE_URL: databaseUrl,
  CPREDICT_AUTOMATION_DAILY_BUDGET_WEI: positive,
  CPREDICT_AUTOMATION_CONFIRMATIONS: z.coerce.number().int().min(1).max(1000),
  CPREDICT_AUTOMATION_LANE: z.enum(["claims", "matching"]),
  CPREDICT_AUTOMATION_PORT: z.coerce.number().int().min(1024).max(65535),
  CPREDICT_AUTOMATION_IDLE_POLL_MS: z.coerce
    .number()
    .int()
    .min(1000)
    .max(300000)
    .optional(),
});
export async function startAutomaticService(
  env: NodeJS.ProcessEnv = process.env,
) {
  const cfg = automationConfigSchema.parse(env);
  const idlePollMs =
    cfg.CPREDICT_AUTOMATION_IDLE_POLL_MS ??
    (cfg.CPREDICT_AUTOMATION_LANE === "matching" ? 2000 : 30000);
  const keyInfo = await stat(cfg.CPREDICT_AUTOMATION_KEY_FILE);
  if (!keyInfo.isFile() || (keyInfo.mode & 0o077) !== 0)
    throw new Error("automation_key_permissions");
  const key = (await readFile(cfg.CPREDICT_AUTOMATION_KEY_FILE, "utf8")).trim();
  if (!/^0x[\da-fA-F]{64}$/.test(key)) throw new Error("automation_key_format");
  const account = privateKeyToAccount(key as Hex);
  if (
    account.address.toLowerCase() !==
    cfg.CPREDICT_AUTOMATION_EXPECTED_SIGNER.toLowerCase()
  )
    throw new Error("automation_signer_mismatch");
  const environment = environmentSchema.parse(
    JSON.parse(
      await readFile(cfg.CPREDICT_AUTOMATION_ENVIRONMENT_FILE, "utf8"),
    ),
  );
  if (
    cfg.CPREDICT_AUTOMATION_LANE === "claims" &&
    !environment.features.automaticClaims
  )
    throw new Error("automatic_claims_not_enabled");
  if (
    cfg.CPREDICT_AUTOMATION_LANE === "matching" &&
    environment.deployment.marketplaceVersion !== "orderbook-v2"
  )
    throw new Error("orderbook_not_enabled");
  const registry = new Registry();
  const ticks = new Counter({
    name: "cpredict_automation_ticks_total",
    help: "Completed or failed read/submit cycles",
    labelNames: ["lane", "result"],
    registers: [registry],
  });
  const blocked = new Gauge({
    name: "cpredict_automation_blocked",
    help: "Accounts with a queued or failed automatic operation; alert on positive counts",
    labelNames: ["reason"],
    registers: [registry],
  });
  const pending = new Gauge({
    name: "cpredict_automation_pending",
    help: "Transactions awaiting canonical confirmation",
    registers: [registry],
  });
  const missingFacts = new Gauge({
    name: "cpredict_automation_confirmed_missing_facts",
    help: "Canonical confirmed payout transactions past the index checkpoint without a matching financial fact",
    labelNames: ["kind"],
    registers: [registry],
  });
  const pool = new RpcReadPool({
    url: cfg.CPREDICT_AUTOMATION_RPC_URL,
    chainId: environment.deployment.chainId,
    timeoutMs: 8000,
    service: `automation-${cfg.CPREDICT_AUTOMATION_LANE}`,
    capabilities: ["read", "history", "receipt"],
    fallback: parseRpcFallbackConfig(env),
    registry,
  });
  const client = createPublicClient({
    chain: arbitrumSepolia,
    transport: pool.transport,
  });
  const writer = http(
    cfg.CPREDICT_AUTOMATION_WRITE_RPC_URL ?? cfg.CPREDICT_AUTOMATION_RPC_URL,
    {
      retryCount: 0,
      timeout: 8000,
    },
  )({ chain: arbitrumSepolia });
  const wallet = createWalletClient({
    chain: arbitrumSepolia,
    account,
    transport: custom(
      {
        request: async ({ method, params }) =>
          READ_METHODS.has(method)
            ? pool.request(method, (params as readonly unknown[]) ?? [])
            : writer.request({ method, params } as never),
      },
      { retryCount: 0 },
    ),
  });
  const sql = postgres(cfg.CPREDICT_AUTOMATION_DATABASE_URL, {
    max: 4,
    connect_timeout: 5,
    onnotice: () => undefined,
  });
  const control = postgres(cfg.CPREDICT_AUTOMATION_CONTROL_DATABASE_URL, {
    max: 4,
    connect_timeout: 5,
    onnotice: () => undefined,
  });
  const store = new PostgresAutomaticStore(
    control,
    environment.deployment.chainId,
    environment.deployment.id,
    account.address,
    cfg.CPREDICT_AUTOMATION_LANE,
  );
  const ledger = new PostgresFinancialLedger(sql, environment);
  const source =
    cfg.CPREDICT_AUTOMATION_LANE === "claims"
      ? new LedgerAutomaticSource(ledger, client, store)
      : new MatchingSource(sql, client, environment);
  const chain = new ViemAutomationChain(
    client,
    wallet,
    account,
    BigInt(cfg.CPREDICT_AUTOMATION_CONFIRMATIONS),
    source instanceof LedgerAutomaticSource
      ? (action) => source.stillEligible(action)
      : undefined,
    () =>
      submissionEndpointReady(
        (input) => writer.request(input),
        environment.deployment.chainId,
      ),
  );
  const worker = new AutomaticClaimsWorker(
    store,
    chain,
    source,
    BigInt(cfg.CPREDICT_AUTOMATION_DAILY_BUDGET_WEI),
  );
  const pendingAge = new Gauge({
    name: "cpredict_automation_oldest_pending_seconds",
    help: "Age of oldest pending transaction; over 120 seconds blocks readiness",
    registers: [registry],
  });
  const app = Fastify({ logger: false });
  let stopped = false,
    lastOk = 0,
    oldestPending = 0;
  let lastBlocked = "";
  let lastMissingFacts = "";
  let timer: ReturnType<typeof setTimeout> | undefined,
    active: Promise<void> | undefined;
  app.get("/metrics", async (_, reply) =>
    reply.type(registry.contentType).send(await registry.metrics()),
  );
  app.get("/readyz", async (_, reply) =>
    reply
      .code(
        lastOk && Date.now() - lastOk < 120000 && oldestPending < 120
          ? 200
          : 503,
      )
      .send({
        status:
          lastOk && Date.now() - lastOk < 120000 && oldestPending < 120
            ? "ready"
            : "not-ready",
      }),
  );
  const tick = async () => {
    let pendingCount = 0;
    try {
      await worker.tick();
      pendingCount = (await store.pending()).length;
      pending.set(pendingCount);
      oldestPending = await store.oldestPendingSeconds();
      pendingAge.set(oldestPending);
      blocked.reset();
      const blockedRows = await store.blockedCounts();
      for (const row of blockedRows)
        blocked.set({ reason: row.reason }, row.count);
      const warning = JSON.stringify(blockedRows);
      if (warning !== lastBlocked && blockedRows.length)
        console.warn(
          JSON.stringify({
            event: "automation_attention",
            lane: cfg.CPREDICT_AUTOMATION_LANE,
            counts: blockedRows,
          }),
        );
      lastBlocked = warning;
      if (cfg.CPREDICT_AUTOMATION_LANE === "claims") {
        const missing = await store.missingFinancialFacts();
        missingFacts.reset();
        for (const kind of ["winner", "early-bird", "refund", "timeout-bonus", "fees", "bond"])
          missingFacts.set({ kind }, 0);
        for (const row of missing)
          missingFacts.set({ kind: row.kind }, row.count);
        const missingWarning = JSON.stringify(missing);
        if (missingWarning !== lastMissingFacts && missing.length)
          console.warn(JSON.stringify({
            event: "confirmed_automation_financial_fact_missing",
            counts: missing,
          }));
        lastMissingFacts = missingWarning;
      }
      lastOk = Date.now();
      ticks.inc({ lane: cfg.CPREDICT_AUTOMATION_LANE, result: "ok" });
    } catch {
      ticks.inc({ lane: cfg.CPREDICT_AUTOMATION_LANE, result: "error" });
    }
    if (!stopped)
      timer = setTimeout(
        () => {
          active = tick();
        },
        pendingCount ? 2000 : idlePollMs,
      );
  };
  const stop = async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await active;
    await app.close();
    pool.close();
    await sql.end({ timeout: 5 });
    await control.end({ timeout: 5 });
  };
  try {
    await pool.start();
    await verifyDeployment(client, environment);
    // Check existing identity and schema, never silently migrate a live database from a worker.
    const [identity] =
      await sql`SELECT identity FROM ledger_environment WHERE singleton`;
    const { environmentKey } = await import("../../app-core/src/contracts.js");
    if (identity?.identity !== environmentKey(environment))
      throw new Error("automation_deployment_database_mismatch");
    await store.pending();
    await ledger.snapshot();
    await app.listen({ host: "127.0.0.1", port: cfg.CPREDICT_AUTOMATION_PORT });
    active = tick();
    return stop;
  } catch (e) {
    await stop();
    throw e;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startAutomaticService()
    .then((stop) => {
      for (const signal of ["SIGINT", "SIGTERM"] as const)
        process.once(signal, () => {
          void stop();
        });
    })
    .catch(() => {
      console.error("automation_startup_failed");
      process.exitCode = 1;
    });
}
