import { z } from "zod";
import { readJsonResponse } from "../../app-core/src/fetch-json.js";
import {
  managementEndpointSchema,
  managementStatusSchema,
  type ManagementStatus,
} from "../../app-core/src/provider-contracts.js";

export const managementConfigSchema = z.strictObject({
  apiKey: z.string().regex(/^[\x21-\x7e]{16,512}$/),
  projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  teamId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  chainId: z.literal(421614),
});
export type ManagementConfig = z.infer<typeof managementConfigSchema>;
type Endpoint = z.infer<typeof managementEndpointSchema>;
type EndpointState = ManagementStatus["endpoints"][number];

/** Official read methods only. Raw responses stay in memory and are never exposed
 * to HTTP clients or logs. Mapping requires sanitized real-response fixtures. */
export class ZeroDevManagementReader {
  #config: ManagementConfig;
  #states = new Map<Endpoint, Omit<EndpointState, "stale">>();
  #responses = new Map<Endpoint, unknown>();
  #controller: AbortController | null = null;
  #pending: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  #started = false;
  constructor(
    config: ManagementConfig,
    private readonly observed?: (available: boolean) => void,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#config = managementConfigSchema.parse(config);
    for (const endpoint of managementEndpointSchema.options)
      this.#states.set(endpoint, {
        endpoint,
        lastAttemptAt: null,
        lastSuccessAt: null,
        requestedWindow: null,
        dataWindow: null,
        error: null,
      });
  }
  status(): ManagementStatus {
    const now = this.now().getTime();
    return managementStatusSchema.parse({
      provider: "zerodev",
      source: "https://public-api.zerodev.app",
      projectId: this.#config.projectId,
      chainId: this.#config.chainId,
      pollingSeconds: 300,
      staleAfterSeconds: 900,
      mappingStatus: "awaiting-real-response-contract",
      endpoints: [...this.#states.values()].map((s) => ({
        ...s,
        stale:
          s.lastSuccessAt === null ||
          now - Date.parse(s.lastSuccessAt) >= 900_000,
      })),
    });
  }
  // This boundary is for a future reviewed mapper; there is intentionally no raw-response route.
  latest(endpoint: Endpoint): unknown {
    return this.#responses.get(endpoint);
  }
  async poll(): Promise<void> {
    if (this.#stopped) return;
    if (this.#pending) return this.#pending;
    this.#controller = new AbortController();
    const end = this.now(),
      start = new Date(end.getTime() - 30 * 86400000);
    const config = this.#config;
    const requests: [Endpoint, URL][] = [
      [
        "statistics",
        new URL(
          `https://public-api.zerodev.app/v2/projects/${config.projectId}/statistics`,
        ),
      ],
      [
        "policies",
        new URL(
          `https://public-api.zerodev.app/v2/projects/${config.projectId}/chains/${config.chainId}/policies`,
        ),
      ],
      [
        "webhooks",
        new URL(
          `https://public-api.zerodev.app/v2/projects/${config.projectId}/policies/webhooks`,
        ),
      ],
      [
        "team-spend",
        new URL(
          `https://public-api.zerodev.app/teams/${config.teamId}/project-spend`,
        ),
      ],
    ];
    for (const [endpoint, url] of requests)
      if (endpoint === "statistics" || endpoint === "team-spend") {
        url.searchParams.set("startDate", start.toISOString());
        url.searchParams.set("endDate", end.toISOString());
        if (endpoint === "team-spend")
          url.searchParams.set("includeTestnet", "true");
      }
    const outer = this.#controller.signal;
    this.#pending = Promise.all(
      requests.map(async ([endpoint, url]) => {
        const signal = AbortSignal.any([outer, AbortSignal.timeout(8_000)]);
        const old = this.#states.get(endpoint)!;
        const state = {
          ...old,
          lastAttemptAt: end.toISOString(),
          requestedWindow:
            endpoint === "statistics" || endpoint === "team-spend"
              ? { start: start.toISOString(), end: end.toISOString() }
              : null,
        };
        try {
          const response = await fetch(url, {
            method: "GET",
            headers: { "X-API-KEY": config.apiKey, accept: "application/json" },
            redirect: "error",
            signal,
          });
          if (!response.ok) {
            await response.body?.cancel();
            state.error =
              response.status === 401
                ? "unauthorized"
                : response.status === 403
                  ? "forbidden"
                  : response.status === 429
                    ? "rate-limited"
                    : "provider-error";
          } else {
            try {
              const raw = await readJsonResponse(response);
              if (raw === null || typeof raw !== "object")
                throw new Error("invalid response envelope");
              if (!outer.aborted) {
                this.#responses.set(endpoint, raw);
                state.lastSuccessAt = this.now().toISOString();
                state.dataWindow = state.requestedWindow;
                state.error = null;
              }
            } catch {
              state.error = signal.aborted ? "timeout" : "invalid-response";
            }
          }
        } catch {
          state.error = signal.aborted ? "timeout" : "unavailable";
        }
        if (!outer.aborted) this.#states.set(endpoint, state);
      }),
    )
      .then(() => {
        if (!outer.aborted)
          this.observed?.(
            [...this.#states.values()].every(
              (s) => s.error === null && s.lastSuccessAt !== null,
            ),
          );
      })
      .finally(() => {
        this.#pending = null;
      });
    return this.#pending;
  }
  start() {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    const run = async () => {
      await this.poll();
      if (!this.#stopped) {
        this.#timer = setTimeout(() => void run(), 300_000);
        this.#timer.unref();
      }
    };
    void run();
  }
  async stop() {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#controller?.abort();
    await this.#pending;
    this.#responses.clear();
  }
}
