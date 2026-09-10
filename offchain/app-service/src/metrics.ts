import type { FastifyInstance } from "fastify";
import { Counter, Gauge, Histogram, Registry } from "prom-client";

export interface ApplicationMonitorState {
  pending: number;
  unknown: number;
  oldestPendingSeconds: number;
  indexedBlock: string | null;
  budget: {
    lane: "exposure" | "exit";
    reservedWei: string;
    remainingWei: string;
  }[];
}

/** Process metrics contain bounded route/category labels, never identities or payloads. */
export class ApplicationMetrics {
  readonly registry = new Registry();
  private readonly requests = new Counter({
    name: "cpredict_app_http_requests_total",
    help: "Completed application HTTP requests",
    labelNames: ["route", "status_class"],
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: "cpredict_app_http_duration_seconds",
    help: "Application request duration",
    labelNames: ["route"],
    buckets: [0.005, 0.025, 0.1, 0.3, 0.75, 1, 2, 5, 15],
    registers: [this.registry],
  });
  private readonly failures = new Counter({
    name: "cpredict_app_failures_total",
    help: "Application failures grouped by bounded category",
    labelNames: ["category"],
    registers: [this.registry],
  });
  private readonly policy = new Counter({
    name: "cpredict_app_policy_total",
    help: "Local sponsored-operation policy decisions",
    labelNames: ["decision"],
    registers: [this.registry],
  });
  private readonly recovery = new Counter({
    name: "cpredict_app_recovery_queries_total",
    help: "Recovery queries, including failed observations; never submissions",
    labelNames: ["outcome"],
    registers: [this.registry],
  });
  private readonly dependency = new Gauge({
    name: "cpredict_app_dependency_available",
    help: "Last observed dependency availability; missing series means not observed",
    labelNames: ["service"],
    registers: [this.registry],
  });
  private readonly lastSuccess = new Gauge({
    name: "cpredict_app_dependency_last_success_timestamp_seconds",
    help: "Last successful observation time",
    labelNames: ["service"],
    registers: [this.registry],
  });
  private readonly pending = new Gauge({
    name: "cpredict_app_operations_pending",
    help: "All submitted, confirming and unknown operations in this environment",
    registers: [this.registry],
  });
  private readonly unknown = new Gauge({
    name: "cpredict_app_operations_unknown",
    help: "Operations with unknown chain outcome",
    registers: [this.registry],
  });
  private readonly oldest = new Gauge({
    name: "cpredict_app_oldest_pending_seconds",
    help: "Age of the oldest pending operation by original creation time",
    registers: [this.registry],
  });
  private readonly indexed = new Gauge({
    name: "cpredict_app_indexed_block",
    help: "Observed indexed block; absent when unknown",
    registers: [this.registry],
  });
  private readonly chainHead = new Gauge({
    name: "cpredict_app_chain_head",
    help: "Last observed chain head",
    registers: [this.registry],
  });
  private readonly lag = new Gauge({
    name: "cpredict_app_index_delay_blocks",
    help: "Difference between observed chain head and indexed block",
    registers: [this.registry],
  });
  private readonly remaining = new Gauge({
    name: "cpredict_app_weekly_remaining_eth",
    help: "Approximate native ETH units for alerting; exact integer wei remains in authenticated reports",
    labelNames: ["lane"],
    registers: [this.registry],
  });
  private readonly reserved = new Gauge({
    name: "cpredict_app_weekly_reserved_eth",
    help: "Conservative weekly gas reservation, approximate ETH units",
    labelNames: ["lane"],
    registers: [this.registry],
  });
  private readonly memory = new Gauge({
    name: "cpredict_app_resident_memory_bytes",
    help: "Application process resident memory",
    registers: [this.registry],
  });

  constructor() {
    for (const gauge of [
      this.pending,
      this.unknown,
      this.oldest,
      this.indexed,
      this.chainHead,
      this.lag,
    ])
      gauge.remove();
  }

  attach(app: FastifyInstance) {
    const routes = new Set<string>();
    const starts = new WeakMap<object, bigint>();
    app.addHook("onRoute", (route) => {
      routes.add(route.url);
    });
    app.addHook("onRequest", async (request) => {
      starts.set(request, process.hrtime.bigint());
    });
    app.addHook("onResponse", async (request, reply) => {
      const template = request.routeOptions.url;
      const route = template && routes.has(template) ? template : "unmatched";
      if (route === "/metrics") return;
      this.requests.inc({
        route,
        status_class: `${Math.floor(reply.statusCode / 100)}xx`,
      });
      const started = starts.get(request);
      if (started)
        this.duration.observe(
          { route },
          Number(process.hrtime.bigint() - started) / 1e9,
        );
    });
    app.get("/metrics", async (_request, reply) => {
      this.memory.set(process.memoryUsage().rss);
      return reply
        .type(this.registry.contentType)
        .send(await this.registry.metrics());
    });
  }
  failure(code: string) {
    const category = /budget|quota|cooldown/.test(code)
      ? "quota"
      : /provider|upstream|receipt/.test(code)
        ? "provider"
        : /unauthorized|forbidden|control/.test(code)
          ? "authorization"
          : /chain|rpc/.test(code)
            ? "chain"
            : "application";
    this.failures.inc({ category });
  }
  policyDecision(allowed: boolean) {
    this.policy.inc({ decision: allowed ? "allowed" : "denied" });
  }
  recoveryResults(result: { attempted: number; failed: number }) {
    this.recovery.inc(
      { outcome: "observed" },
      result.attempted - result.failed,
    );
    this.recovery.inc({ outcome: "failed" }, result.failed);
  }
  observeDependency(
    service:
      | "database"
      | "chain"
      | "bundler"
      | "paymaster"
      | "privy"
      | "management",
    available: boolean,
  ) {
    this.dependency.set({ service }, available ? 1 : 0);
    if (available) this.lastSuccess.set({ service }, Date.now() / 1000);
  }
  observeState(state: ApplicationMonitorState, head: bigint | null) {
    this.pending.set(state.pending);
    this.unknown.set(state.unknown);
    this.oldest.set(state.oldestPendingSeconds);
    this.indexed.remove();
    this.lag.remove();
    this.remaining.reset();
    this.reserved.reset();
    if (state.indexedBlock !== null) {
      this.indexed.set(Number(state.indexedBlock));
      if (head !== null)
        this.lag.set(
          Number(
            head > BigInt(state.indexedBlock)
              ? head - BigInt(state.indexedBlock)
              : 0n,
          ),
        );
    }
    if (head !== null) this.chainHead.set(Number(head));
    for (const b of state.budget) {
      this.remaining.set({ lane: b.lane }, Number(b.remainingWei) / 1e18);
      this.reserved.set({ lane: b.lane }, Number(b.reservedWei) / 1e18);
    }
  }
}
