import { Counter, Gauge, type Registry } from "prom-client";
import { z } from "zod";
import { READ_METHODS } from "../../app-core/src/rpc-pool.js";

export const rpcAdmissionConfigSchema = z
  .strictObject({
    mode: z.enum(["observe", "enforce"]).default("observe"),
    perClientUnitsPerMinute: z
      .number()
      .int()
      .min(64)
      .max(1_000_000)
      .default(1_200),
    globalUnitsPerMinute: z
      .number()
      .int()
      .min(64)
      .max(10_000_000)
      .default(12_000),
    maxConcurrentCalls: z.number().int().min(4).max(1_024).default(64),
  })
  .refine(
    (value) => value.perClientUnitsPerMinute <= value.globalUnitsPerMinute,
    {
      message: "per-client RPC budget cannot exceed the global budget",
    },
  );
export type RpcAdmissionConfig = z.infer<typeof rpcAdmissionConfigSchema>;

export function parseRpcAdmissionConfig(
  env: Readonly<Record<string, string | undefined>>,
): RpcAdmissionConfig {
  return rpcAdmissionConfigSchema.parse({
    mode: env.CPREDICT_RPC_ADMISSION_MODE,
    perClientUnitsPerMinute: optionalNumber(
      env.CPREDICT_RPC_CLIENT_UNITS_PER_MINUTE,
    ),
    globalUnitsPerMinute: optionalNumber(
      env.CPREDICT_RPC_GLOBAL_UNITS_PER_MINUTE,
    ),
    maxConcurrentCalls: optionalNumber(env.CPREDICT_RPC_MAX_CONCURRENT_CALLS),
  });
}

function optionalNumber(value: string | undefined): number | undefined {
  return value === undefined ? undefined : Number(value);
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export type RpcAdmissionReason =
  | "client_budget"
  | "global_budget"
  | "concurrency";
export interface RpcAdmissionDecision {
  allowed: boolean;
  reason?: RpcAdmissionReason;
  release: () => void;
}

/** A stable, deliberately conservative estimate; provider CU remains the billing authority. */
function cost(method: string, params: readonly unknown[]): number {
  if (!READ_METHODS.has(method)) return 8;
  if (method === "eth_getLogs") {
    const filter = params[0];
    if (!filter || typeof filter !== "object" || Array.isArray(filter))
      return 256;
    const range = filter as Record<string, unknown>;
    if (range.blockHash) return 16;
    if (
      typeof range.fromBlock !== "string" ||
      typeof range.toBlock !== "string" ||
      !/^0x[0-9a-f]+$/i.test(range.fromBlock) ||
      !/^0x[0-9a-f]+$/i.test(range.toBlock)
    )
      return 256;
    const from = BigInt(range.fromBlock);
    const to = BigInt(range.toBlock);
    if (to < from) return 256;
    const chunks = (to - from) / 100n + 1n;
    return Number(chunks > 16n ? 256n : chunks * 16n);
  }
  if (method === "eth_estimateGas") return 8;
  if (method === "eth_call" || method === "eth_feeHistory") return 4;
  if (/^eth_get(Block|Transaction|Proof)/.test(method)) return 2;
  return 1;
}

/** Counts JSON-RPC operations, not HTTP envelopes; no client identity is exported as a metric. */
export class RpcAdmission {
  private readonly clients = new Map<string, Bucket>();
  private readonly global: Bucket;
  private inFlight = 0;
  private readonly decisions?: Counter<"decision" | "lane" | "reason">;
  private readonly estimatedUnits?: Counter<"lane">;
  private readonly active?: Gauge<string>;

  constructor(
    readonly config: RpcAdmissionConfig = rpcAdmissionConfigSchema.parse({}),
    registry?: Registry,
    private readonly now: () => number = Date.now,
  ) {
    this.global = { tokens: config.globalUnitsPerMinute, updatedAt: now() };
    if (registry) {
      this.decisions = new Counter({
        name: "cpredict_rpc_admission_total",
        help: "Public RPC admission decisions by bounded lane",
        labelNames: ["decision", "lane", "reason"],
        registers: [registry],
      });
      this.estimatedUnits = new Counter({
        name: "cpredict_rpc_admission_estimated_units_total",
        help: "Estimated public RPC work admitted or observed; not provider billing CU",
        labelNames: ["lane"],
        registers: [registry],
      });
      this.active = new Gauge({
        name: "cpredict_rpc_admission_inflight",
        help: "Reserved public RPC concurrency slots",
        registers: [registry],
      });
    }
  }

  enter(
    client: string,
    calls: readonly { method: string; params: readonly unknown[] }[],
    slots = Math.min(4, calls.length),
  ): RpcAdmissionDecision {
    if (!calls.length) return { allowed: true, release: () => undefined };
    const now = this.now();
    const clientBucket = this.clientBucket(client, now);
    this.refill(clientBucket, this.config.perClientUnitsPerMinute, now);
    this.refill(this.global, this.config.globalUnitsPerMinute, now);
    const units = calls.reduce(
      (sum, call) => sum + cost(call.method, call.params),
      0,
    );
    const reason: RpcAdmissionReason | undefined =
      this.inFlight + slots > this.config.maxConcurrentCalls
        ? "concurrency"
        : units > clientBucket.tokens
          ? "client_budget"
          : units > this.global.tokens
            ? "global_budget"
            : undefined;
    const lane = calls.some((call) => !READ_METHODS.has(call.method))
      ? "includes_write"
      : "read";
    const allowed = !reason || this.config.mode === "observe";
    this.decisions?.inc({
      decision: reason ? (allowed ? "would_reject" : "rejected") : "allowed",
      lane,
      reason: reason ?? "none",
    });
    if (!allowed) return { allowed: false, reason, release: () => undefined };
    this.estimatedUnits?.inc({ lane }, units);
    clientBucket.tokens = Math.max(0, clientBucket.tokens - units);
    this.global.tokens = Math.max(0, this.global.tokens - units);
    this.inFlight += slots;
    this.active?.set(this.inFlight);
    let released = false;
    return {
      allowed: true,
      ...(reason ? { reason } : {}),
      release: () => {
        if (released) return;
        released = true;
        this.inFlight -= slots;
        this.active?.set(this.inFlight);
      },
    };
  }

  private clientBucket(client: string, now: number): Bucket {
    const existing = this.clients.get(client);
    if (existing) {
      this.clients.delete(client);
      this.clients.set(client, existing);
      return existing;
    }
    // A rotating-address attacker cannot grow process memory without bound.
    if (this.clients.size >= 4_096)
      this.clients.delete(this.clients.keys().next().value!);
    const bucket = {
      tokens: this.config.perClientUnitsPerMinute,
      updatedAt: now,
    };
    this.clients.set(client, bucket);
    return bucket;
  }

  private refill(bucket: Bucket, capacity: number, now: number) {
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + (Math.max(0, now - bucket.updatedAt) * capacity) / 60_000,
    );
    bucket.updatedAt = now;
  }
}
