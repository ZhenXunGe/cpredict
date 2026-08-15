export const REQUIRED_TELEMETRY_FAMILIES = [
  "apiNodeCpu",
  "apiNodeMemory",
  "apiEventLoopLag",
  "apiConnections",
  "apiRequestsQueued",
  "apiRequestsInFlight",
  "apiRequestLatency",
  "databaseAdmissionWait",
  "databaseOperationsQueued",
  "databaseOperationsInFlight",
  "databaseOperationLatency",
  "databaseConfiguredConnections",
  "postgresActiveConnections",
  "postgresCheckpoints",
  "postgresTransactionsPerSecond",
  "indexerChainHead",
  "indexerLastIndexedBlock",
  "indexerBlockLag",
  "indexerTickLatency",
  "websocketAccepted",
  "websocketCurrent",
  "websocketPeak",
  "websocketRejected",
  "websocketReady",
  "websocketHeartbeat",
];

export function buildTelemetrySummary(raw, rawSha256) {
  object(raw, "raw telemetry");
  equal(raw.schemaVersion, 1, "raw telemetry schemaVersion");
  equal(
    raw.lane,
    "distributed-commercial-sut-telemetry-raw",
    "raw telemetry lane",
  );
  validRunId(raw.runId);
  assert(/^[0-9a-f]{64}$/.test(rawSha256), "raw telemetry digest is invalid");
  assert(
    Number.isSafeInteger(raw.sampleIntervalMs) &&
      raw.sampleIntervalMs >= 1_000 &&
      raw.sampleIntervalMs <= 60_000,
    "raw telemetry sample interval is invalid",
  );
  assert(
    Number.isSafeInteger(raw.allowedBlockLag) &&
      raw.allowedBlockLag >= 0 &&
      raw.allowedBlockLag <= 10_000,
    "raw telemetry allowed block lag is invalid",
  );
  assert(
    Array.isArray(raw.samples) && raw.samples.length >= 2,
    "raw telemetry requires at least two samples",
  );
  const started = Date.parse(raw.startedAt);
  const completed = Date.parse(raw.completedAt);
  assert(
    Number.isFinite(started) &&
      Number.isFinite(completed) &&
      completed > started,
    "raw telemetry window is invalid",
  );

  let previousObservedAt;
  for (const sample of raw.samples) {
    object(sample, "raw telemetry sample");
    const observedAt = Date.parse(sample.observedAt);
    assert(
      Number.isFinite(observedAt),
      "raw telemetry sample timestamp is invalid",
    );
    assert(
      observedAt >= started && observedAt <= completed,
      "raw telemetry sample is outside its window",
    );
    if (previousObservedAt !== undefined)
      assert(
        observedAt > previousObservedAt,
        "raw telemetry timestamps must be strictly increasing",
      );
    previousObservedAt = observedAt;
    assert(
      Array.isArray(sample.metrics) && sample.metrics.length > 0,
      "raw telemetry Prometheus sample is empty",
    );
    for (const metric of sample.metrics) {
      assert(
        typeof metric.key === "string" &&
          metric.key.length > 0 &&
          Number.isFinite(metric.value),
        "raw telemetry Prometheus metric is invalid",
      );
    }
    assert(
      Number.isSafeInteger(sample.chainHead) && sample.chainHead >= 0,
      "raw telemetry chain head is invalid",
    );
    object(sample.postgres, "raw PostgreSQL sample");
    for (const key of ["activeConnections", "transactions", "checkpoints"]) {
      assert(
        Number.isSafeInteger(sample.postgres[key]) && sample.postgres[key] >= 0,
        `raw PostgreSQL ${key} is invalid`,
      );
    }
  }

  const samples = raw.samples;
  const firstMetrics = samples[0].metrics;
  const finalMetrics = samples.at(-1).metrics;
  const values = (name) =>
    samples.map((sample) => scalar(sample.metrics, name));
  const lastIndexed = values("cpredict_indexer_last_indexed_block");
  const blockLag = samples.map((sample, index) =>
    Math.max(0, sample.chainHead - lastIndexed[index]),
  );
  const transactionRates = [];
  for (let index = 1; index < samples.length; index += 1) {
    const elapsedSeconds =
      (Date.parse(samples[index].observedAt) -
        Date.parse(samples[index - 1].observedAt)) /
      1_000;
    const transactionDelta = monotonicDelta(
      samples[index - 1].postgres.transactions,
      samples[index].postgres.transactions,
      "PostgreSQL transactions",
    );
    transactionRates.push(transactionDelta / elapsedSeconds);
  }

  const observedFamilies = {
    apiNodeCpu: present(samples, "cpredict_indexer_process_cpu_seconds_total"),
    apiNodeMemory: present(
      samples,
      "cpredict_indexer_process_resident_memory_bytes",
    ),
    apiEventLoopLag: present(
      samples,
      "cpredict_indexer_nodejs_eventloop_lag_seconds",
    ),
    apiConnections: present(samples, "cpredict_indexer_http_connections"),
    apiRequestsQueued: present(
      samples,
      "cpredict_indexer_http_requests_queued",
    ),
    apiRequestsInFlight: present(
      samples,
      "cpredict_indexer_http_requests_in_flight",
    ),
    apiRequestLatency:
      histogramObservationDelta(
        firstMetrics,
        finalMetrics,
        "cpredict_indexer_http_request_duration_seconds",
      ) > 0,
    databaseAdmissionWait:
      histogramObservationDelta(
        firstMetrics,
        finalMetrics,
        "cpredict_indexer_db_admission_wait_seconds",
      ) > 0,
    databaseOperationsQueued: present(
      samples,
      "cpredict_indexer_db_operations_queued",
    ),
    databaseOperationsInFlight: present(
      samples,
      "cpredict_indexer_db_operations_in_flight",
    ),
    databaseOperationLatency:
      histogramObservationDelta(
        firstMetrics,
        finalMetrics,
        "cpredict_indexer_db_operation_duration_seconds",
      ) > 0,
    databaseConfiguredConnections: present(
      samples,
      "cpredict_indexer_db_configured_connections",
    ),
    postgresActiveConnections: samples.every((sample) =>
      Number.isSafeInteger(sample.postgres.activeConnections),
    ),
    postgresCheckpoints: samples.every((sample) =>
      Number.isSafeInteger(sample.postgres.checkpoints),
    ),
    postgresTransactionsPerSecond: transactionRates.every(Number.isFinite),
    indexerChainHead: samples.every((sample) =>
      Number.isSafeInteger(sample.chainHead),
    ),
    indexerLastIndexedBlock: lastIndexed.every(Number.isSafeInteger),
    indexerBlockLag: blockLag.every(Number.isSafeInteger),
    indexerTickLatency:
      histogramObservationDelta(
        firstMetrics,
        finalMetrics,
        "cpredict_indexer_tick_seconds",
      ) > 0,
    websocketAccepted: present(samples, "cpredict_indexer_ws_accepted_total"),
    websocketCurrent: present(samples, "cpredict_indexer_ws_connections"),
    websocketPeak: present(samples, "cpredict_indexer_ws_peak_connections"),
    websocketRejected: samples.every(
      (sample) =>
        labelledTotal(sample.metrics, "cpredict_indexer_ws_rejected_total") !==
        undefined,
    ),
    websocketReady: samples.every(
      (sample) =>
        labelled(
          sample.metrics,
          "cpredict_indexer_ws_outbound_total",
          "kind",
          "ready",
        ) !== undefined,
    ),
    websocketHeartbeat: samples.every(
      (sample) =>
        labelledTotal(sample.metrics, "cpredict_indexer_ws_heartbeat_total") !==
        undefined,
    ),
  };

  return {
    schemaVersion: 2,
    lane: "distributed-commercial-sut-telemetry",
    runId: raw.runId,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    sampleIntervalMs: raw.sampleIntervalMs,
    sampleCount: samples.length,
    rawEvidence: { path: "telemetry-raw.json", sha256: rawSha256 },
    requiredFamilies: REQUIRED_TELEMETRY_FAMILIES,
    observedFamilies,
    api: {
      cpuSecondsDelta: monotonicDelta(
        values("cpredict_indexer_process_cpu_seconds_total")[0],
        values("cpredict_indexer_process_cpu_seconds_total").at(-1),
        "API CPU",
      ),
      maxResidentMemoryBytes: maximum(
        values("cpredict_indexer_process_resident_memory_bytes"),
      ),
      maxEventLoopLagMs:
        maximum(values("cpredict_indexer_nodejs_eventloop_lag_seconds")) *
        1_000,
      maxConnections: maximum(values("cpredict_indexer_http_connections")),
      maxRequestsQueued: maximum(
        values("cpredict_indexer_http_requests_queued"),
      ),
      maxRequestsInFlight: maximum(
        values("cpredict_indexer_http_requests_in_flight"),
      ),
      requestLatencyMs: {
        p95:
          histogramDeltaQuantile(
            firstMetrics,
            finalMetrics,
            "cpredict_indexer_http_request_duration_seconds",
            0.95,
          ) * 1_000,
        p99:
          histogramDeltaQuantile(
            firstMetrics,
            finalMetrics,
            "cpredict_indexer_http_request_duration_seconds",
            0.99,
          ) * 1_000,
      },
    },
    database: {
      metricSemantics:
        "application admission wait and top-level store operation duration; not collector reserve or SELECT 1",
      configuredConnections: scalar(
        finalMetrics,
        "cpredict_indexer_db_configured_connections",
      ),
      maxOperationsQueued: maximum(
        values("cpredict_indexer_db_operations_queued"),
      ),
      maxOperationsInFlight: maximum(
        values("cpredict_indexer_db_operations_in_flight"),
      ),
      admissionWaitMs: {
        p95:
          histogramDeltaQuantile(
            firstMetrics,
            finalMetrics,
            "cpredict_indexer_db_admission_wait_seconds",
            0.95,
          ) * 1_000,
        p99:
          histogramDeltaQuantile(
            firstMetrics,
            finalMetrics,
            "cpredict_indexer_db_admission_wait_seconds",
            0.99,
          ) * 1_000,
      },
      operationLatencyMs: {
        p95:
          histogramDeltaQuantile(
            firstMetrics,
            finalMetrics,
            "cpredict_indexer_db_operation_duration_seconds",
            0.95,
          ) * 1_000,
        p99:
          histogramDeltaQuantile(
            firstMetrics,
            finalMetrics,
            "cpredict_indexer_db_operation_duration_seconds",
            0.99,
          ) * 1_000,
      },
    },
    postgres: {
      metricSemantics:
        "current_database pg_stat_activity/pg_stat_database including the collector's bounded monitoring transactions, plus cluster-wide checkpoint counters",
      maxActiveConnections: maximum(
        samples.map((sample) => sample.postgres.activeConnections),
      ),
      checkpointsDelta: monotonicDelta(
        samples[0].postgres.checkpoints,
        samples.at(-1).postgres.checkpoints,
        "PostgreSQL checkpoints",
      ),
      transactionsPerSecond: summary(transactionRates),
    },
    indexer: {
      maxChainHead: maximum(
        samples.map((sample) => sample.chainHead),
        true,
      ),
      maxLastIndexedBlock: maximum(lastIndexed, true),
      maxBlockLag: maximum(blockLag, true),
      allowedBlockLag: raw.allowedBlockLag,
      tickLatencyMs: {
        p95:
          histogramDeltaQuantile(
            firstMetrics,
            finalMetrics,
            "cpredict_indexer_tick_seconds",
            0.95,
          ) * 1_000,
        p99:
          histogramDeltaQuantile(
            firstMetrics,
            finalMetrics,
            "cpredict_indexer_tick_seconds",
            0.99,
          ) * 1_000,
      },
    },
    websocket: {
      acceptedDelta: monotonicDelta(
        values("cpredict_indexer_ws_accepted_total")[0],
        values("cpredict_indexer_ws_accepted_total").at(-1),
        "WebSocket accepted",
      ),
      maxCurrent: maximum(values("cpredict_indexer_ws_connections")),
      peak: maximum(values("cpredict_indexer_ws_peak_connections")),
      rejectedDelta: monotonicDelta(
        labelledTotal(firstMetrics, "cpredict_indexer_ws_rejected_total") ?? 0,
        labelledTotal(finalMetrics, "cpredict_indexer_ws_rejected_total") ?? 0,
        "WebSocket rejected",
      ),
      readyDelta: monotonicDelta(
        labelled(
          firstMetrics,
          "cpredict_indexer_ws_outbound_total",
          "kind",
          "ready",
        ) ?? 0,
        labelled(
          finalMetrics,
          "cpredict_indexer_ws_outbound_total",
          "kind",
          "ready",
        ) ?? 0,
        "WebSocket ready",
      ),
      heartbeatDelta: monotonicDelta(
        labelledTotal(firstMetrics, "cpredict_indexer_ws_heartbeat_total") ?? 0,
        labelledTotal(finalMetrics, "cpredict_indexer_ws_heartbeat_total") ?? 0,
        "WebSocket heartbeat",
      ),
    },
  };
}

export function parsePrometheus(body) {
  const result = [];
  for (const line of body.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = line.match(/^([^\s]+)\s+([^\s]+)$/);
    if (match === null) continue;
    const value = Number(match[2]);
    if (Number.isFinite(value)) result.push({ key: match[1], value });
  }
  return result;
}

function scalar(metrics, name) {
  const entry = metrics.find((metric) => metric.key === name);
  if (entry === undefined)
    throw new Error(`metrics endpoint is missing ${name}`);
  return entry.value;
}

function present(samples, name) {
  return samples.every((sample) =>
    sample.metrics.some((metric) => metric.key === name),
  );
}

function labelled(metrics, name, label, value) {
  return metrics.find(
    (metric) =>
      metric.key.startsWith(`${name}{`) &&
      metric.key.includes(`${label}="${value}"`),
  )?.value;
}

function labelledTotal(metrics, name) {
  const values = metrics
    .filter((metric) => metric.key.startsWith(`${name}{`))
    .map((metric) => metric.value);
  return values.length === 0
    ? undefined
    : values.reduce((total, value) => total + value, 0);
}

function histogramObservationDelta(first, last, name) {
  const firstCount = aggregateMetric(first, `${name}_count`);
  const lastCount = aggregateMetric(last, `${name}_count`);
  return monotonicDelta(firstCount, lastCount, `${name} observations`);
}

function histogramDeltaQuantile(first, last, name, quantile) {
  const firstByKey = new Map(first.map((metric) => [metric.key, metric.value]));
  const buckets = new Map();
  for (const metric of last.filter((entry) =>
    entry.key.startsWith(`${name}_bucket{`),
  )) {
    const match = metric.key.match(/le="([^"]+)"/);
    const upper = match?.[1] === "+Inf" ? Infinity : Number(match?.[1]);
    if (Number.isNaN(upper)) continue;
    const count = monotonicDelta(
      firstByKey.get(metric.key) ?? 0,
      metric.value,
      `${name} bucket`,
    );
    buckets.set(upper, (buckets.get(upper) ?? 0) + count);
  }
  const sorted = [...buckets]
    .map(([upper, count]) => ({ upper, count }))
    .sort((a, b) => a.upper - b.upper);
  const total = sorted.at(-1)?.count ?? 0;
  if (total <= 0)
    throw new Error(
      `histogram ${name} has no observations in the evidence window`,
    );
  const target = total * quantile;
  let lower = 0;
  let previousCount = 0;
  for (const bucket of sorted) {
    if (bucket.count >= target) {
      if (!Number.isFinite(bucket.upper)) return lower;
      const count = bucket.count - previousCount;
      return count <= 0
        ? bucket.upper
        : lower + ((target - previousCount) / count) * (bucket.upper - lower);
    }
    lower = bucket.upper;
    previousCount = bucket.count;
  }
  throw new Error(`histogram ${name} cannot resolve p${quantile * 100}`);
}

function aggregateMetric(metrics, name) {
  return metrics
    .filter(
      (metric) => metric.key === name || metric.key.startsWith(`${name}{`),
    )
    .reduce((total, metric) => total + metric.value, 0);
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: maximum(sorted),
  };
}

function percentile(values, quantile) {
  return round(
    values[
      Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)
    ] ?? 0,
  );
}

function maximum(values, integerResult = false) {
  const result = Math.max(...values);
  if (!Number.isFinite(result))
    throw new Error("telemetry sample set is empty");
  return integerResult ? Math.trunc(result) : round(result);
}

function monotonicDelta(first, last, label) {
  assert(
    Number.isFinite(first) && Number.isFinite(last) && last >= first,
    `${label} counter reset or decreased`,
  );
  return round(last - first);
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function validRunId(value) {
  assert(
    typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value),
    "runId is invalid",
  );
}

function object(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function equal(actual, expected, label) {
  assert(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
