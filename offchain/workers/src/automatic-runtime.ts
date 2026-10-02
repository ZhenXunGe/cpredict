import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import postgres from "postgres";
import Fastify from "fastify";
import { Registry, Counter, Gauge, Histogram } from "prom-client";
import { backfillAutomaticGas } from "./automatic-gas.js";
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
import {
  SubmissionEndpointPool,
  parseSubmissionUrls,
  type SubmissionEndpoint,
} from "./automatic-submission.js";
import {
  AutomationRecovery,
  PostgresRecoveryStore,
  RecoveryQuorum,
} from "./automatic-recovery.js";
import { AutomationAlerts, smtpDelivery } from "./automatic-alerts.js";
import { PostgresClaimQueue } from "./automatic-queue.js";
import {
  AutomaticClaimDiscovery,
  discoveryFailure,
} from "./automatic-discovery.js";
import { AutomaticReadLimit, claimPollDelay } from "./automatic-read-limit.js";
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
  CPREDICT_AUTOMATION_WRITE_RPC_FALLBACKS_JSON: z.string().optional(),
  CPREDICT_AUTOMATION_DATABASE_URL: databaseUrl,
  CPREDICT_AUTOMATION_CONTROL_DATABASE_URL: databaseUrl,
  CPREDICT_AUTOMATION_DAILY_BUDGET_WEI: positive,
  CPREDICT_AUTOMATION_MAX_TX_COST_WEI: positive.optional(),
  CPREDICT_AUTOMATION_CONFIRMATIONS: z.coerce.number().int().min(1).max(1000),
  CPREDICT_AUTOMATION_LANE: z.enum(["claims", "matching"]),
  CPREDICT_AUTOMATION_PORT: z.coerce.number().int().min(1024).max(65535),
  CPREDICT_AUTOMATION_AUTO_RECOVERY_ENABLED: z
    .enum(["true", "false"])
    .default("false"),
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
  const dailyBudget = BigInt(cfg.CPREDICT_AUTOMATION_DAILY_BUDGET_WEI);
  const maxTransactionCost = cfg.CPREDICT_AUTOMATION_MAX_TX_COST_WEI
    ? BigInt(cfg.CPREDICT_AUTOMATION_MAX_TX_COST_WEI)
    : dailyBudget;
  if (maxTransactionCost > dailyBudget)
    throw new Error("automation_tx_cap_exceeds_daily_budget");
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
  const cleanupQuotaDenials = new Counter({
    name: "cpredict_automation_cleanup_quota_denials_total",
    help: "Sponsored cleanup candidates rejected by the account or market rolling quota",
    labelNames: ["lane", "reason"],
    registers: [registry],
  });
  const quotaLogAt = new Map<string, number>();
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
  let rpcReadCount = 0,
    lastDiscoveryRpcCount = 0;
  const rpcReads = new Counter({
    name: "cpredict_automation_read_requests_total",
    help: "All keeper RPC reads, including failing requests",
    registers: [registry],
  });
  const queueCounts = new Gauge({
    name: "cpredict_automation_claim_queue",
    help: "Unsigned claim candidates by durable state",
    labelNames: ["state"],
    registers: [registry],
  });
  const queueAge = new Gauge({
    name: "cpredict_automation_oldest_queued_seconds",
    help: "Age of oldest unsigned candidate; errors do not clear the value",
    registers: [registry],
  });
  const cursorBlock = new Gauge({
    name: "cpredict_automation_discovery_block",
    help: "Last atomically processed complete ledger block",
    registers: [registry],
  });
  const readLimit = new AutomaticReadLimit(4);
  const limitedRead = <T>(work: () => Promise<T>, priority = 1) => {
    rpcReads.inc();
    rpcReadCount++;
    return cfg.CPREDICT_AUTOMATION_LANE === "claims"
      ? readLimit.run(work, priority)
      : work();
  };
  const client = createPublicClient({
    chain: arbitrumSepolia,
    transport:
      cfg.CPREDICT_AUTOMATION_LANE === "claims"
        ? custom(
            {
              request: ({ method, params }) =>
                limitedRead(
                  () =>
                    pool.request(method, (params as readonly unknown[]) ?? []),
                  method === "eth_getTransactionReceipt" ? 0 : 1,
                ),
            },
            { retryCount: 0 },
          )
        : pool.transport,
  });
  const writeUrls = parseSubmissionUrls(
    cfg.CPREDICT_AUTOMATION_WRITE_RPC_URL ?? cfg.CPREDICT_AUTOMATION_RPC_URL,
    cfg.CPREDICT_AUTOMATION_WRITE_RPC_FALLBACKS_JSON,
  );
  const writerSelected = new Gauge({
    name: "cpredict_automation_writer_selected",
    help: "Selected preflight-qualified writer (one-based index); zero means none",
    registers: [registry],
  });
  const writer = new SubmissionEndpointPool(
    writeUrls.map((url, index) => {
      const transport = http(url, { retryCount: 0, timeout: 2500 })({
        chain: arbitrumSepolia,
      });
      return {
        name: `writer-${index + 1}`,
        request: (input: Parameters<SubmissionEndpoint["request"]>[0]) =>
          READ_METHODS.has(input.method)
            ? limitedRead(() => transport.request(input as never), 0)
            : transport.request(input as never),
      };
    }),
    environment.deployment.chainId,
    Date.now,
    (index) => writerSelected.set(index === undefined ? 0 : index + 1),
  );
  const validationClient = createPublicClient({
    chain: arbitrumSepolia,
    transport: custom(
      {
        request: ({ method, params }) =>
          writer.readSelected(method, (params as readonly unknown[]) ?? []),
      },
      { retryCount: 0 },
    ),
  });
  const wallet = createWalletClient({
    chain: arbitrumSepolia,
    account,
    transport: custom(
      {
        request: async ({ method, params }) =>
          READ_METHODS.has(method)
            ? limitedRead(
                () =>
                  pool.request(method, (params as readonly unknown[]) ?? []),
                0,
              )
            : method === "eth_sendRawTransaction"
              ? writer.sendRaw((params as readonly string[])[0]!)
              : Promise.reject(
                  new Error("unsupported_automation_write_method"),
                ),
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
  const stages = new Histogram({
    name: "cpredict_automation_stage_seconds",
    help: "Keeper phase duration, including failed cycles",
    labelNames: ["phase", "result"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120],
    registers: [registry],
  });
  const discovered = new Counter({
    name: "cpredict_automation_discovery_items_total",
    help: "Discovery items processed",
    labelNames: ["kind"],
    registers: [registry],
  });
  const store = new PostgresAutomaticStore(
    control,
    environment.deployment.chainId,
    environment.deployment.id,
    account.address,
    cfg.CPREDICT_AUTOMATION_LANE,
    (reason) => {
      cleanupQuotaDenials.inc({ lane: cfg.CPREDICT_AUTOMATION_LANE, reason });
      const now = Date.now();
      if (now - (quotaLogAt.get(reason) ?? 0) >= 60000) {
        console.warn(
          JSON.stringify({
            event: "sponsored_cleanup_quota_reached",
            lane: cfg.CPREDICT_AUTOMATION_LANE,
            reason,
          }),
        );
        quotaLogAt.set(reason, now);
      }
    },
    cfg.CPREDICT_AUTOMATION_LANE === "claims",
    (phase, seconds) => stages.observe({ phase, result: "ok" }, seconds),
  );
  const ledger = new PostgresFinancialLedger(sql, environment);
  const legacySource =
    cfg.CPREDICT_AUTOMATION_LANE === "claims"
      ? new LedgerAutomaticSource(ledger, client, store)
      : new MatchingSource(sql, client, environment, Date.now, 30000, store);
  const chain = new ViemAutomationChain(
    client,
    wallet,
    account,
    BigInt(cfg.CPREDICT_AUTOMATION_CONFIRMATIONS),
    legacySource instanceof LedgerAutomaticSource
      ? (action) => legacySource.stillEligible(action)
      : undefined,
    async () => {
      const head = await client.getBlockNumber();
      return writer.ready(head > 120n ? head - 120n : 1n);
    },
    maxTransactionCost,
    validationClient,
    () => writer.provider(),
    cfg.CPREDICT_AUTOMATION_LANE === "claims",
  );
  const recovery = new AutomationRecovery(
    new PostgresRecoveryStore(store),
    chain,
    new RecoveryQuorum(
      writeUrls.map((url, index) => ({
        name: `writer-${index + 1}`,
        client: createPublicClient({
          chain: arbitrumSepolia,
          transport: custom(
            {
              request: (input) =>
                limitedRead(
                  () =>
                    http(url, { retryCount: 0, timeout: 2500 })({
                      chain: arbitrumSepolia,
                    }).request(input as never),
                  0,
                ),
            },
            { retryCount: 0 },
          ),
        }),
      })),
      environment.deployment.chainId,
      account.address,
    ),
    dailyBudget,
    maxTransactionCost,
  );
  const claimQueue =
    cfg.CPREDICT_AUTOMATION_LANE === "claims"
      ? new PostgresClaimQueue(
          control,
          environment.deployment.chainId,
          environment.deployment.id,
        )
      : undefined;
  const discovery =
    claimQueue && legacySource instanceof LedgerAutomaticSource
      ? new AutomaticClaimDiscovery(
          claimQueue,
          ledger,
          legacySource,
          (phase, seconds, counts) => {
            stages.observe({ phase, result: "ok" }, seconds);
            for (const [kind, count] of Object.entries(counts))
              if (
                ["events", "accounts", "markets", "candidates"].includes(kind)
              )
                discovered.inc({ kind }, count);
            if (counts.events || counts.candidates)
              console.info(
                JSON.stringify({
                  event: "automation_discovery_progress",
                  phase,
                  seconds,
                  ...counts,
                  sharedRpcRequests: rpcReadCount - lastDiscoveryRpcCount,
                }),
              );
            if (phase !== "index-lag") lastDiscoveryRpcCount = rpcReadCount;
          },
        )
      : undefined;
  const source =
    claimQueue && discovery
      ? {
          async *candidates() {
            const snapshot = await discovery.assertCurrent();
            const [progress] =
              await control`SELECT epoch::text FROM automation_discovery WHERE chain_id=${claimQueue.chainId} AND deployment_id=${claimQueue.deploymentId}`;
            if (progress?.epoch !== snapshot.epoch) return;
            yield* claimQueue.candidates();
          },
          reject: (
            action: Parameters<PostgresClaimQueue["reject"]>[0],
            reason: string,
          ) => claimQueue.reject(action, reason),
        }
      : legacySource;
  const worker = new AutomaticClaimsWorker(
    store,
    chain,
    source,
    dailyBudget,
    20,
    maxTransactionCost,
    (tx, failure) => {
      console.warn(
        JSON.stringify({
          event: "automation_submission_failed",
          lane: cfg.CPREDICT_AUTOMATION_LANE,
          transactionHash: tx.hash,
          nonce: tx.nonce.toString(),
          ...failure,
        }),
      );
    },
    cfg.CPREDICT_AUTOMATION_AUTO_RECOVERY_ENABLED === "true"
      ? (tx) => recovery.automatic(tx)
      : undefined,
    (phase, seconds, result) => stages.observe({ phase, result }, seconds),
  );
  const pendingAge = new Gauge({
    name: "cpredict_automation_oldest_pending_seconds",
    help: "Age of oldest pending transaction; over 120 seconds blocks readiness",
    registers: [registry],
  });
  const delivery = smtpDelivery(env);
  const alerts = new AutomationAlerts(store, delivery);
  const alertConfigured = new Gauge({
    name: "cpredict_automation_alert_delivery_configured",
    help: "One only when an email recipient and SMTP transport are configured",
    registers: [registry],
  });
  alertConfigured.set(delivery ? 1 : 0);
  const alertQueue = new Gauge({
    name: "cpredict_automation_alert_unsent",
    help: "Durable unsent notifications, including intentionally disabled email",
    registers: [registry],
  });
  const alertDelivery = new Counter({
    name: "cpredict_automation_alert_delivery_total",
    help: "SMTP outbox delivery results",
    labelNames: ["result"],
    registers: [registry],
  });
  const autoRecovery = new Gauge({
    name: "cpredict_automation_auto_recovery_enabled",
    help: "Bounded same-nonce recovery enabled",
    registers: [registry],
  });
  autoRecovery.set(
    cfg.CPREDICT_AUTOMATION_AUTO_RECOVERY_ENABLED === "true" ? 1 : 0,
  );
  const manualRecovery = new Gauge({
    name: "cpredict_automation_manual_recovery_required",
    help: "Tasks with conflicting evidence or an exhausted replacement still pending after two minutes",
    registers: [registry],
  });
  const app = Fastify({ logger: false });
  let stopped = false,
    lastOk = 0,
    oldestPending = 0,
    lastMonitorOk = 0,
    lastDiscoveryOk = 0;
  let consuming = false;
  let lastBlocked = "";
  let lastMissingFacts = "";
  let timer: ReturnType<typeof setTimeout> | undefined,
    active: Promise<void> | undefined;
  let monitorTimer: ReturnType<typeof setTimeout> | undefined,
    monitorActive: Promise<void> | undefined;
  let discoveryTimer: ReturnType<typeof setTimeout> | undefined,
    discoveryActive: Promise<void> | undefined;
  let gasTimer: ReturnType<typeof setTimeout> | undefined;
  let gasActive: Promise<void> | undefined;
  const gasTick = async () => {
    const started = performance.now();
    try {
      if (
        !(await store.pending()).length &&
        !(claimQueue && (await claimQueue.workPending()))
      ) {
        await backfillAutomaticGas(store, chain, sql);
        stages.observe(
          { phase: "gas-evidence", result: "ok" },
          (performance.now() - started) / 1000,
        );
      }
    } catch {
      stages.observe(
        { phase: "gas-evidence", result: "error" },
        (performance.now() - started) / 1000,
      );
    }
    if (!stopped)
      gasTimer = setTimeout(() => {
        gasActive = gasTick();
      }, 30000);
  };
  const discoverTick = async () => {
    const started = performance.now();
    try {
      await discovery!.tick();
      lastDiscoveryOk = Date.now();
      if ((await claimQueue!.workPending()) && !stopped && !consuming) {
        if (timer) clearTimeout(timer);
        active = tick();
      }
    } catch (error) {
      stages.observe(
        { phase: "discovery", result: "error" },
        (performance.now() - started) / 1000,
      );
      console.warn(
        JSON.stringify({
          event: "automation_discovery_failed",
          reason: discoveryFailure(error),
        }),
      );
    }
    if (!stopped)
      discoveryTimer = setTimeout(() => {
        discoveryActive = discoverTick();
      }, 2000);
  };
  const monitor = async () => {
    try {
      oldestPending = await store.oldestPendingSeconds();
      pendingAge.set(oldestPending);
      pending.set((await store.pending()).length);
      alertQueue.set(await alerts.sync());
      const [r] =
        await control`SELECT count(*)::int AS count FROM automation_transactions t WHERE chain_id=${store.chainId} AND signer=${store.signer.toLowerCase()} AND state IN ('broadcasting','unknown') AND (recovery_manual_required OR EXISTS(SELECT 1 FROM automation_recoveries r WHERE r.transaction_id=t.id AND r.broadcast_at<=now()-interval '2 minutes'))`;
      manualRecovery.set(r?.count ?? 0);
      const result = await alerts.sendOne();
      if (result === "sent" || result === "failed")
        alertDelivery.inc({ result });
      if (claimQueue) {
        const rows =
          await control`SELECT state,count(*)::int AS count,extract(epoch FROM now()-min(queued_at))::float8 AS age FROM automation_claim_candidates WHERE chain_id=${store.chainId} AND deployment_id=${store.deploymentId} AND state IN ('ready','deferred') GROUP BY state`;
        queueCounts.reset();
        for (const state of ["ready", "deferred"])
          queueCounts.set(
            { state },
            rows.find((r) => r.state === state)?.count ?? 0,
          );
        queueAge.set(Math.max(0, ...rows.map((r) => r.age)));
        const [progress] =
          await control`SELECT cursor_block FROM automation_discovery WHERE chain_id=${store.chainId} AND deployment_id=${store.deploymentId}`;
        if (progress) cursorBlock.set(Number(progress.cursor_block));
      }
      lastMonitorOk = Date.now();
    } catch {
      console.warn(
        JSON.stringify({
          event: "automation_monitor_failed",
          lane: store.lane,
        }),
      );
    }
    if (!stopped)
      monitorTimer = setTimeout(() => {
        monitorActive = monitor();
      }, 15000);
  };
  app.get("/metrics", async (_, reply) =>
    reply.type(registry.contentType).send(await registry.metrics()),
  );
  app.get("/readyz", async (_, reply) =>
    reply
      .code(
        lastOk &&
          Date.now() - lastOk < 120000 &&
          lastMonitorOk &&
          Date.now() - lastMonitorOk < 60000 &&
          (!discovery ||
            (lastDiscoveryOk > 0 && Date.now() - lastDiscoveryOk < 120000)) &&
          oldestPending < 120
          ? 200
          : 503,
      )
      .send({
        status:
          lastOk &&
          Date.now() - lastOk < 120000 &&
          lastMonitorOk &&
          Date.now() - lastMonitorOk < 60000 &&
          (!discovery ||
            (lastDiscoveryOk > 0 && Date.now() - lastDiscoveryOk < 120000)) &&
          oldestPending < 120
            ? "ready"
            : "not-ready",
      }),
  );
  const tick = async () => {
    consuming = true;
    let pendingCount: number | null = null,
      busy: boolean | null = null,
      failed = false;
    const started = performance.now();
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
        for (const kind of [
          "winner",
          "early-bird",
          "refund",
          "timeout-bonus",
          "fees",
          "bond",
        ])
          missingFacts.set({ kind }, 0);
        for (const row of missing)
          missingFacts.set({ kind: row.kind }, row.count);
        const missingWarning = JSON.stringify(missing);
        if (missingWarning !== lastMissingFacts && missing.length)
          console.warn(
            JSON.stringify({
              event: "confirmed_automation_financial_fact_missing",
              counts: missing,
            }),
          );
        lastMissingFacts = missingWarning;
      }
      lastOk = Date.now();
      stages.observe(
        { phase: "consume", result: "ok" },
        (performance.now() - started) / 1000,
      );
      ticks.inc({ lane: cfg.CPREDICT_AUTOMATION_LANE, result: "ok" });
    } catch (error) {
      failed = true;
      stages.observe(
        { phase: "consume", result: "error" },
        (performance.now() - started) / 1000,
      );
      console.warn(
        JSON.stringify({
          event: "automation_cycle_failed",
          lane: store.lane,
          reason: discoveryFailure(error),
        }),
      );
      ticks.inc({ lane: cfg.CPREDICT_AUTOMATION_LANE, result: "error" });
    }
    try {
      pendingCount = (await store.pending()).length;
      busy = claimQueue ? await claimQueue.workPending() : false;
    } catch {
      pendingCount = null;
      busy = null;
    }
    consuming = false;
    if (!stopped)
      timer = setTimeout(
        () => {
          active = tick();
        },
        claimPollDelay(pendingCount, busy, failed, idlePollMs),
      );
  };
  const stop = async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (monitorTimer) clearTimeout(monitorTimer);
    if (discoveryTimer) clearTimeout(discoveryTimer);
    if (gasTimer) clearTimeout(gasTimer);
    await Promise.all([active, monitorActive, discoveryActive, gasActive]);
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
    await store.operationalSchemaReady();
    await claimQueue?.ready();
    if (
      cfg.CPREDICT_AUTOMATION_AUTO_RECOVERY_ENABLED === "true" &&
      writeUrls.length < 3
    )
      throw new Error("automation_recovery_requires_three_writers");
    await store.pending();
    await ledger.snapshot();
    await app.listen({ host: "127.0.0.1", port: cfg.CPREDICT_AUTOMATION_PORT });
    monitorActive = monitor();
    active = tick();
    if (discovery) discoveryActive = discoverTick();
    gasTimer = setTimeout(() => {
      gasActive = gasTick();
    }, 30000);
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
