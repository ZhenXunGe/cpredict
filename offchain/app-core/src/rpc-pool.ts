import { Counter, Gauge, Histogram, type Registry } from "prom-client";
import { custom } from "viem";
import { z } from "zod";

const endpoint = z.object({
  name: z.enum(["alchemy", "ankr", "drpc"]),
  url: z
    .string()
    .url()
    .refine((v) => {
      const u = new URL(v);
      return (
        !u.username &&
        !u.password &&
        (u.protocol === "https:" ||
          (u.protocol === "http:" &&
            ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)))
      );
    }),
});
const hex = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const quantity = z.string().regex(/^0x[0-9a-fA-F]+$/);
export const rpcProbeSchema = z.object({
  logBlockSpan: z.number().int().min(1).max(10_000).default(100),
  blockNumber: quantity,
  blockHash: hex,
  transactionHash: hex,
  receiptBlockNumber: quantity,
  receiptBlockHash: hex,
  logAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  logIndex: quantity,
});
export type RpcProbe = z.infer<typeof rpcProbeSchema>;
export interface RpcFallbackConfig {
  endpoints: z.infer<typeof endpoint>[];
  probe: RpcProbe;
}
export function parseRpcFallbackConfig(
  env: Readonly<Record<string, string | undefined>>,
): RpcFallbackConfig | undefined {
  const value = env.CPREDICT_RPC_FALLBACKS_JSON;
  if (!value?.trim() || value === "[]") return undefined;
  try {
    const endpoints = z.array(endpoint).min(1).max(2).parse(JSON.parse(value));
    if (
      new Set(endpoints.map((e) => e.name)).size !== endpoints.length ||
      endpoints.some((e) => e.name === "alchemy")
    )
      throw new Error();
    return {
      endpoints,
      probe: rpcProbeSchema.parse(
        JSON.parse(env.CPREDICT_RPC_PROBE_JSON ?? ""),
      ),
    };
  } catch {
    throw new Error("invalid private RPC fallback configuration");
  }
}
export const READ_METHODS = new Set([
  "eth_chainId",
  "net_version",
  "eth_blockNumber",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_getProof",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBlockTransactionCountByHash",
  "eth_getBlockTransactionCountByNumber",
  "eth_getLogs",
  "eth_call",
  "eth_estimateGas",
]);
type Capability = "read" | "history" | "receipt" | "logs";
const capabilities: Capability[] = ["read", "history", "receipt", "logs"];
type Reason =
  | "network"
  | "timeout"
  | "rate_limit"
  | "quota"
  | "server"
  | "invalid_response"
  | "chain"
  | "stale"
  | "capability"
  | "cancelled"
  | "unavailable";
export class RpcUnavailableError extends Error {
  constructor(readonly reason: Reason = "unavailable") {
    super(`rpc_${reason}`);
  }
}
export class RpcResponseError extends Error {
  constructor(
    readonly code: number,
    readonly data?: unknown,
  ) {
    super("execution reverted or RPC request rejected");
  }
}
class AttemptError extends RpcUnavailableError {
  constructor(
    reason: Reason,
    readonly retryAfterMs = 0,
  ) {
    super(reason);
  }
}
interface State {
  failures: number;
  until: number;
  qualified: boolean;
  successes: number;
  nextProbe: number;
  probing: boolean;
  recovering: boolean;
}
interface Node {
  name: string;
  url: string;
  logsOnly: boolean;
  head: bigint;
  states: Record<Capability, State>;
  checking?: Promise<void>;
}
export interface RpcPoolOptions {
  url: string;
  chainId: number;
  timeoutMs: number;
  service: string;
  fallback?: RpcFallbackConfig | undefined;
  logUrl?: string | undefined;
  registry?: Registry | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  observe?: (available: boolean) => void;
}
function category(method: string, params: readonly unknown[]): Capability {
  if (method === "eth_getLogs") return "logs";
  if (method === "eth_getTransactionReceipt") return "receipt";
  if (
    [
      "eth_getBlockByNumber",
      "eth_getBlockByHash",
      "eth_getTransactionByHash",
    ].includes(method)
  )
    return "history";
  if (
    [
      "eth_call",
      "eth_getCode",
      "eth_getBalance",
      "eth_getStorageAt",
      "eth_getTransactionCount",
      "eth_getProof",
    ].includes(method) &&
    params
      .slice(1)
      .some((v) => typeof v === "string" && /^0x[0-9a-f]+$/i.test(v))
  )
    return "history";
  return "read";
}
function quotaReason(code: unknown, message: unknown): Reason | undefined {
  const text = typeof message === "string" ? message.slice(0, 4096) : "";
  if (
    /monthly capacity|quota.*(?:exceeded|exhausted)|(?:credits|compute units).*(?:exhausted|exceeded)|billing limit/i.test(
      text,
    )
  )
    return "quota";
  if (
    code === 429 ||
    /rate.?limit|too many requests|requests per second/i.test(text)
  )
    return "rate_limit";
  return undefined;
}

/** Read retries only. No URLs, payloads or provider diagnostics escape this boundary. */
export class RpcReadPool {
  private readonly nodes: Node[];
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;
  private readonly active = new Map<Capability, number>();
  private readonly selectedAt = new Map<Capability, number>();
  private highWater = 0n;
  private readonly anchors = new Map<
    string,
    { hash: string; provider: string }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly shutdown = new AbortController();
  private readonly metrics:
    | {
        requests: Counter;
        duration: Histogram;
        switches: Counter;
        state: Gauge;
        selected: Gauge;
      }
    | undefined;
  constructor(private readonly options: RpcPoolOptions) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? fetch;
    const raw = [
      ...(options.logUrl && options.logUrl !== options.url
        ? [{ name: "official", url: options.logUrl, logsOnly: true }]
        : []),
      { name: "alchemy", url: options.url, logsOnly: false },
      ...(options.fallback?.endpoints ?? []).map((e) => ({
        ...e,
        logsOnly: false,
      })),
    ];
    if (new Set(raw.map((e) => e.url)).size !== raw.length)
      throw new Error("duplicate RPC endpoint");
    this.nodes = raw.map((e) => ({
      ...e,
      head: 0n,
      states: Object.fromEntries(
        capabilities.map((c) => [
          c,
          {
            failures: 0,
            until: 0,
            qualified: !options.fallback,
            successes: 0,
            nextProbe: 0,
            probing: false,
            recovering: false,
          },
        ]),
      ) as Record<Capability, State>,
    }));
    if (options.registry) {
      const registers = [options.registry];
      const labelNames = ["service", "provider", "category"];
      this.metrics = {
        requests: new Counter({
          name: "cpredict_rpc_requests_total",
          help: "RPC attempts, including probes",
          labelNames: [...labelNames, "outcome"],
          registers,
        }),
        duration: new Histogram({
          name: "cpredict_rpc_duration_seconds",
          help: "RPC attempt latency",
          labelNames,
          buckets: [0.01, 0.05, 0.1, 0.3, 1, 2, 5, 10],
          registers,
        }),
        switches: new Counter({
          name: "cpredict_rpc_switches_total",
          help: "Read provider switches",
          labelNames: ["service", "category", "from", "to", "reason"],
          registers,
        }),
        state: new Gauge({
          name: "cpredict_rpc_eligible",
          help: "Qualified and outside cooldown",
          labelNames,
          registers,
        }),
        selected: new Gauge({
          name: "cpredict_rpc_active",
          help: "Current read provider by category",
          labelNames,
          registers,
        }),
      };
    }
  }
  readonly transport = custom(
    {
      request: (args) =>
        this.request(args.method, (args.params as readonly unknown[]) ?? []),
    },
    { retryCount: 0 },
  );
  private labels(n: Node, c: string) {
    return { service: this.options.service, provider: n.name, category: c };
  }
  private eligible(n: Node, c: Capability) {
    const s = n.states[c];
    return (
      (!n.logsOnly || c === "logs") && s.qualified && s.until <= this.now()
    );
  }
  private publish() {
    for (const [i, n] of this.nodes.entries())
      for (const c of capabilities) {
        this.metrics?.state.set(this.labels(n, c), Number(this.eligible(n, c)));
        this.metrics?.selected.set(
          this.labels(n, c),
          Number(this.active.get(c) === i),
        );
      }
  }
  private select(i: number, c: Capability, reason: string) {
    const old = this.active.get(c);
    if (old === i) return;
    this.nodes[i]!.states[c].recovering = false;
    this.active.set(c, i);
    this.selectedAt.set(c, this.now());
    if (old !== undefined)
      this.metrics?.switches.inc({
        service: this.options.service,
        category: c,
        from: this.nodes[old]!.name,
        to: this.nodes[i]!.name,
        reason,
      });
    this.publish();
  }
  async start() {
    if (this.options.fallback) {
      await Promise.all(this.nodes.map((n) => this.qualify(n, true)));
      this.highWater = this.nodes.reduce(
        (max, n) => (n.head > max ? n.head : max),
        0n,
      );
      // Ignore lagging endpoints at admission. Never interpret a stale head as a reorg.
      for (const n of this.nodes)
        if (n.head + 120n < this.highWater)
          for (const c of capabilities)
            if (n.states[c].qualified) {
              n.states[c].qualified = false;
              n.states[c].nextProbe = this.now() + 30_000;
            }
      for (const c of capabilities) {
        const i = this.nodes.findIndex((n) => this.eligible(n, c));
        if (i >= 0) this.select(i, c, "startup");
      }
      if (!this.active.has("read")) throw new RpcUnavailableError();
      this.timer = setInterval(() => {
        void this.probe().catch(() => undefined);
      }, 1000);
      this.timer.unref();
    }
    this.publish();
  }
  close() {
    this.closed = true;
    this.shutdown.abort();
    if (this.timer) clearInterval(this.timer);
  }
  private fault(n: Node, c: Capability, error: AttemptError) {
    if (!this.options.fallback) return;
    const s = n.states[c];
    s.failures++;
    s.recovering = true;
    s.successes = 0;
    const immediate = [
      "rate_limit",
      "quota",
      "chain",
      "stale",
      "capability",
    ].includes(error.reason);
    if (s.failures >= 2 || immediate) {
      s.qualified = false;
      s.until =
        this.now() +
        Math.max(
          error.reason === "quota" ? 900_000 : 60_000,
          error.retryAfterMs,
        );
      s.nextProbe = s.until;
    }
    // Rate limits and transport failures apply to this provider across capabilities.
    if (["rate_limit", "quota", "chain"].includes(error.reason))
      for (const other of capabilities)
        if (other !== c)
          Object.assign(n.states[other], {
            qualified: false,
            until: s.until,
            nextProbe: s.nextProbe,
            successes: 0,
            recovering: true,
          });
    this.publish();
  }
  private async call(
    n: Node,
    method: string,
    params: readonly unknown[],
    timeoutMs: number,
    signal?: AbortSignal,
    label?: string,
  ): Promise<unknown> {
    const start = this.now(),
      cap = label ?? category(method, params);
    let outcome = "ok";
    try {
      if (signal?.aborted || this.closed)
        throw new RpcUnavailableError("cancelled");
      const abort = AbortSignal.any([
        AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
        this.shutdown.signal,
        ...(signal ? [signal] : []),
      ]);
      let response: Response;
      try {
        response = await this.fetcher(n.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: abort,
          redirect: "error",
        });
      } catch {
        if (signal?.aborted || this.closed)
          throw new RpcUnavailableError("cancelled");
        throw new AttemptError(abort.aborted ? "timeout" : "network");
      }
      const after = response.headers.get("retry-after");
      const parsedRetryAfter = after
        ? Math.max(
            0,
            /^\d+(\.\d+)?$/.test(after)
              ? Number(after) * 1000
              : Date.parse(after) - this.now(),
          )
        : 0;
      const retryAfter = Number.isFinite(parsedRetryAfter)
        ? parsedRetryAfter
        : 0;
      // Bounded response, including streaming reads under the same timeout.
      let body: Record<string, unknown>;
      try {
        if (!response.body) throw new Error();
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let text = "",
          length = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            length += part.value.length;
            if (length > 16 * 1024 * 1024) throw new Error();
            text += decoder.decode(part.value, { stream: true });
          }
        } catch (e) {
          await reader.cancel().catch(() => undefined);
          throw e;
        } finally {
          reader.releaseLock();
        }
        body = JSON.parse(text + decoder.decode()) as Record<string, unknown>;
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error();
      } catch {
        if (signal?.aborted || this.closed)
          throw new RpcUnavailableError("cancelled");
        if (response.status === 429)
          throw new AttemptError("rate_limit", retryAfter);
        if (response.status >= 500) throw new AttemptError("server");
        if (!response.ok) throw new RpcResponseError(-32000);
        if (abort.aborted) throw new AttemptError("timeout");
        throw new AttemptError("invalid_response");
      }
      const err = body.error as
        | { code?: unknown; message?: unknown; data?: unknown }
        | undefined;
      const reason = quotaReason(err?.code, err?.message);
      if (reason) throw new AttemptError(reason, retryAfter);
      if (response.status === 429)
        throw new AttemptError("rate_limit", retryAfter);
      if (response.status >= 500) throw new AttemptError("server");
      if (err) {
        // Valid log filters may exceed a provider's plan-specific range/result cap.
        // This is a capability failure, not a malformed user request or a revert.
        if (
          method === "eth_getLogs" &&
          typeof err.message === "string" &&
          /up to (?:a )?\d+ block|maximum (?:allowed )?block range|block range (?:limit|is limited)|limited to.{0,30}blocks|query returned more than|log response size exceeded|too many (?:addresses|topics|results)/i.test(
            err.message,
          )
        )
          throw new AttemptError("capability");
        if (typeof err.code !== "number")
          throw new AttemptError("invalid_response");
        if (
          /missing trie node|historical state.*(?:unavailable|not available)|archive.*required|pruned/i.test(
            typeof err.message === "string" ? err.message : "",
          )
        )
          throw new AttemptError("capability");
        // Only revert bytes are safe to expose, not provider URLs or arbitrary diagnostics.
        throw new RpcResponseError(
          err.code,
          typeof err.data === "string" && /^0x[0-9a-f]*$/i.test(err.data)
            ? err.data
            : undefined,
        );
      }
      if (!response.ok) throw new RpcResponseError(-32000);
      if (!("result" in body) || body.id !== 1 || body.jsonrpc !== "2.0")
        throw new AttemptError("invalid_response");
      return body.result;
    } catch (e) {
      outcome = e instanceof RpcUnavailableError ? e.reason : "rejected";
      throw e;
    } finally {
      this.metrics?.requests.inc({ ...this.labels(n, cap), outcome });
      this.metrics?.duration.observe(
        this.labels(n, cap),
        Math.max(0, this.now() - start) / 1000,
      );
    }
  }
  private async qualification(
    n: Node,
    cap: Capability,
    signal?: AbortSignal,
    baseChecked = false,
  ) {
    const budget = this.options.timeoutMs;
    if (!baseChecked) {
      const chain = await this.call(
        n,
        "eth_chainId",
        [],
        budget,
        signal,
        "probe",
      );
      if (chain !== `0x${this.options.chainId.toString(16)}`)
        throw new AttemptError("chain");
      const head = await this.call(
        n,
        "eth_blockNumber",
        [],
        budget,
        signal,
        "probe",
      );
      if (typeof head !== "string" || !quantity.safeParse(head).success)
        throw new AttemptError("invalid_response");
      n.head = BigInt(head);
      if (n.head < this.highWater) throw new AttemptError("stale");
    }
    const p = this.options.fallback?.probe;
    if (!p || cap === "read") return;
    if (cap === "history") {
      const b = (await this.call(
        n,
        "eth_getBlockByNumber",
        [p.blockNumber, false],
        budget,
        signal,
        "probe",
      )) as Record<string, unknown> | null;
      if (!b || b.hash !== p.blockHash || b.number !== p.blockNumber)
        throw new AttemptError("capability");
      const code = await this.call(
        n,
        "eth_getCode",
        [p.logAddress, p.blockNumber],
        budget,
        signal,
        "probe",
      );
      if (typeof code !== "string" || !/^0x[0-9a-f]+$/i.test(code))
        throw new AttemptError("capability");
    } else if (cap === "receipt") {
      const r = (await this.call(
        n,
        "eth_getTransactionReceipt",
        [p.transactionHash],
        budget,
        signal,
        "probe",
      )) as Record<string, unknown> | null;
      if (
        !r ||
        r.transactionHash !== p.transactionHash ||
        r.blockHash !== p.receiptBlockHash ||
        r.blockNumber !== p.receiptBlockNumber
      )
        throw new AttemptError("capability");
    } else {
      const logs = await this.call(
        n,
        "eth_getLogs",
        [
          {
            address: p.logAddress,
            fromBlock: `0x${(BigInt(p.receiptBlockNumber) >= BigInt(p.logBlockSpan - 1) ? BigInt(p.receiptBlockNumber) - BigInt(p.logBlockSpan - 1) : 0n).toString(16)}`,
            toBlock: p.receiptBlockNumber,
          },
        ],
        budget,
        signal,
        "probe",
      );
      if (
        !Array.isArray(logs) ||
        !logs.some(
          (l) =>
            l.transactionHash === p.transactionHash &&
            l.logIndex === p.logIndex &&
            l.blockHash === p.receiptBlockHash,
        )
      )
        throw new AttemptError("capability");
    }
  }
  private async qualify(n: Node, initial: boolean) {
    if (n.checking) return n.checking;
    const run = async () => {
      let baseChecked = false;
      for (const c of capabilities) {
        const s = n.states[c];
        if (n.logsOnly && c !== "logs") continue;
        if (s.until > this.now()) continue;
        if (
          !initial &&
          ((s.qualified && s.failures === 0 && !s.recovering) ||
            s.nextProbe > this.now() ||
            s.probing)
        )
          continue;
        s.probing = true;
        try {
          await this.qualification(n, c, undefined, baseChecked);
          baseChecked = true;
          s.successes++;
          s.nextProbe = this.now() + 30_000;
          if (initial || s.successes >= 3) {
            s.qualified = true;
            s.until = 0;
            s.failures = 0;
          }
        } catch (e) {
          s.qualified = false;
          s.successes = 0;
          if (e instanceof AttemptError) this.fault(n, c, e);
          s.nextProbe = Math.max(s.until, this.now() + 30_000);
        } finally {
          s.probing = false;
        }
      }
    };
    n.checking = run().finally(() => {
      delete n.checking;
      this.publish();
    });
    return n.checking;
  }
  /** Coalesced, low frequency recovery probes; exposed for deterministic drills. */
  async probe() {
    if (this.closed || !this.options.fallback) return;
    await Promise.all(this.nodes.map((n) => this.qualify(n, false)));
    for (const c of capabilities) {
      const best = this.nodes.findIndex(
        (n) => this.eligible(n, c) && n.states[c].failures === 0,
      );
      const current = this.active.get(c);
      if (
        best >= 0 &&
        (current === undefined ||
          (best < current &&
            this.now() - (this.selectedAt.get(c) ?? 0) >= 300_000))
      )
        this.select(best, c, "recovered");
    }
  }
  async request(
    method: string,
    params: readonly unknown[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (!READ_METHODS.has(method)) throw new RpcResponseError(-32601);
    const c = category(method, params),
      deadline =
        performance.now() + (options.timeoutMs ?? this.options.timeoutMs);
    const preferred = this.active.get(c);
    const candidates = this.nodes
      .map((_, i) => i)
      .filter((i) => this.eligible(this.nodes[i]!, c));
    if (preferred !== undefined && candidates.includes(preferred)) {
      candidates.splice(candidates.indexOf(preferred), 1);
      candidates.unshift(preferred);
    }
    let last: RpcUnavailableError = new RpcUnavailableError();
    for (const [position, index] of candidates.entries()) {
      if (options.signal?.aborted || this.closed)
        throw new RpcUnavailableError("cancelled");
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      const n = this.nodes[index]!,
        allowance = Math.max(
          1,
          Math.floor(remaining / (candidates.length - position)),
        );
      try {
        const attemptStart = performance.now();
        // A switching provider must have caught up to every head already exposed by this process.
        if (
          this.options.fallback &&
          preferred !== undefined &&
          index !== preferred &&
          this.highWater > 0n
        ) {
          const head = await this.call(
            n,
            "eth_blockNumber",
            [],
            Math.max(1, allowance / 3),
            options.signal,
            "probe",
          );
          if (typeof head !== "string" || !quantity.safeParse(head).success)
            throw new AttemptError("invalid_response");
          n.head = BigInt(head);
          if (n.head < this.highWater) throw new AttemptError("stale");
        }
        const result = await this.call(
          n,
          method,
          params,
          Math.max(1, allowance - (performance.now() - attemptStart)),
          options.signal,
        );
        if (
          method === "eth_chainId" &&
          result !== `0x${this.options.chainId.toString(16)}`
        )
          throw new AttemptError("chain");
        if (method === "eth_blockNumber") {
          if (typeof result !== "string" || !quantity.safeParse(result).success)
            throw new AttemptError("invalid_response");
          n.head = BigInt(result);
          if (n.head < this.highWater) throw new AttemptError("stale");
          this.highWater = n.head;
        }
        if (
          (method === "eth_getBlockByNumber" ||
            method === "eth_getBlockByHash") &&
          result !== null
        ) {
          const b = result as { number?: unknown; hash?: unknown };
          if (
            !quantity.safeParse(b.number).success ||
            !hex.safeParse(b.hash).success
          )
            throw new AttemptError("invalid_response");
          if (
            method === "eth_getBlockByNumber" &&
            typeof params[0] === "string" &&
            /^0x/.test(params[0]) &&
            BigInt(params[0]) !== BigInt(b.number as string)
          )
            throw new AttemptError("invalid_response");
          if (method === "eth_getBlockByHash" && params[0] !== b.hash)
            throw new AttemptError("invalid_response");
          const key = BigInt(b.number as string).toString();
          const old = this.anchors.get(key);
          if (old && old.provider !== n.name && old.hash !== b.hash)
            throw new AttemptError("stale");
          this.anchors.delete(key);
          this.anchors.set(key, { hash: b.hash as string, provider: n.name });
          if (this.anchors.size > 512)
            this.anchors.delete(this.anchors.keys().next().value!);
        }
        n.states[c].failures = 0;
        this.select(index, c, position ? last.reason : "available");
        this.options.observe?.(true);
        return result;
      } catch (e) {
        if (e instanceof RpcResponseError) {
          this.options.observe?.(true);
          throw e;
        }
        if (!(e instanceof AttemptError)) throw e;
        last = e;
        this.fault(n, c, e);
      }
    }
    this.options.observe?.(false);
    throw last;
  }
  /** Compatibility boundary: writes go to the configured primary exactly once. */
  async requestOnce(
    method: string,
    params: readonly unknown[],
    signal?: AbortSignal,
    timeoutMs = this.options.timeoutMs,
  ) {
    return this.call(
      this.nodes.find((n) => !n.logsOnly)!,
      method,
      params,
      Math.min(timeoutMs, this.options.timeoutMs),
      signal,
    );
  }
}
