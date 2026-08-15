import { createHash } from "node:crypto";

export function buildEventLatencySummary(raw, chain, chainSha256, rawSha256) {
  object(raw, "event latency raw evidence");
  equal(raw.schemaVersion, 1, "event latency raw schemaVersion");
  equal(
    raw.lane,
    "chain-receipt-to-websocket-client-raw",
    "event latency raw lane",
  );
  equal(
    raw.clockDomain,
    "single-process-monotonic-nanoseconds",
    "event latency raw clock domain",
  );
  equal(raw.market, chain.market, "event latency market binding");
  assert(
    /^[0-9a-f]{64}$/.test(chainSha256),
    "event latency chain report digest is invalid",
  );
  assert(
    /^[0-9a-f]{64}$/.test(rawSha256),
    "event latency raw digest is invalid",
  );
  assert(
    Array.isArray(raw.transactions),
    "event latency transaction inventory is missing",
  );
  assert(
    Array.isArray(raw.deliveries),
    "event latency delivery inventory is missing",
  );
  equal(
    raw.transactions.length,
    chain.classifications.included,
    "event latency transaction inventory size",
  );

  const transactions = new Map();
  let successful = 0;
  let expectedReverted = 0;
  for (const transaction of raw.transactions) {
    const hash = transactionHash(
      transaction.transactionHash,
      "event latency transaction hash",
    );
    assert(
      !transactions.has(hash),
      "event latency transaction inventory contains a duplicate hash",
    );
    equal(
      transaction.expectedOutcome,
      transaction.receiptStatus,
      "event latency expected/receipt outcome",
    );
    assert(
      new Set(["success", "expected-revert"]).has(transaction.receiptStatus),
      "event latency receipt status is invalid",
    );
    assert(
      Number.isSafeInteger(transaction.blockNumber) &&
        transaction.blockNumber >= 0,
      "event latency block number is invalid",
    );
    transactions.set(hash, transaction.receiptStatus);
    if (transaction.receiptStatus === "success") successful += 1;
    else expectedReverted += 1;
  }
  equal(
    successful,
    chain.classifications.success,
    "event latency successful receipt inventory",
  );
  equal(
    expectedReverted,
    chain.classifications.expectedRevert,
    "event latency expected-revert receipt inventory",
  );

  const deliveredByTransaction = new Map();
  const deliveryKeys = new Set();
  const latencies = [];
  let unexpected = 0;
  for (const delivery of raw.deliveries) {
    const hash = transactionHash(
      delivery.transactionHash,
      "event latency delivery transaction hash",
    );
    assert(
      Number.isSafeInteger(delivery.logIndex) && delivery.logIndex >= 0,
      "event latency delivery log index is invalid",
    );
    equal(
      delivery.eventName,
      "PrimaryPurchased",
      "event latency delivery event name",
    );
    const key = `${hash}:${delivery.logIndex}`;
    assert(
      !deliveryKeys.has(key),
      "event latency delivery inventory contains a duplicate event",
    );
    deliveryKeys.add(key);
    const outcome = transactions.get(hash);
    if (outcome !== "success") {
      unexpected += 1;
      continue;
    }
    deliveredByTransaction.set(
      hash,
      (deliveredByTransaction.get(hash) ?? 0) + 1,
    );
    const receiptNs = nanoseconds(
      delivery.receiptObservedMonotonicNs,
      "event latency receipt observation",
    );
    const websocketNs = nanoseconds(
      delivery.websocketReceivedMonotonicNs,
      "event latency WebSocket observation",
    );
    assert(
      websocketNs >= receiptNs,
      "event latency monotonic timestamps are reversed",
    );
    const milliseconds = Number(websocketNs - receiptNs) / 1_000_000;
    assert(
      Number.isFinite(milliseconds) &&
        milliseconds >= 0 &&
        milliseconds <= 600_000,
      "event latency sample is outside [0, 600000] ms",
    );
    latencies.push(milliseconds);
  }

  let missing = 0;
  let duplicates = 0;
  for (const [hash, outcome] of transactions) {
    const count = deliveredByTransaction.get(hash) ?? 0;
    if (outcome === "success" && count === 0) missing += 1;
    if (count > 1) duplicates += count - 1;
  }
  const sorted = latencies.sort((a, b) => a - b);
  return {
    schemaVersion: 2,
    lane: "chain-event-to-websocket-client-inventory",
    chainReportSha256: chainSha256,
    rawEvidence: { path: "event-latency-raw.json", sha256: rawSha256 },
    markerEvent: "PrimaryPurchased",
    measurement: {
      clockDomain: raw.clockDomain,
      start: "transaction-receipt-observed",
      end: "websocket-event-received",
    },
    chainInventory: {
      includedTransactions: raw.transactions.length,
      successfulTransactions: successful,
      expectedRevertedTransactions: expectedReverted,
      transactionSetSha256: setDigest([...transactions.keys()]),
    },
    eventInventory: {
      expected: successful,
      delivered: raw.deliveries.length,
      uniqueDelivered: deliveryKeys.size,
      missing,
      duplicates,
      unexpected,
      deliverySetSha256: setDigest([...deliveryKeys]),
    },
    samples: sorted.length,
    latencyMs: { p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99) },
    clockSynchronizationVerified: true,
  };
}

function percentile(values, quantile) {
  const value =
    values[
      Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1)
    ];
  return value === undefined ? null : Math.round(value * 1_000) / 1_000;
}

function setDigest(values) {
  const hash = createHash("sha256");
  for (const value of values.sort()) {
    hash.update(value);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function transactionHash(value, label) {
  assert(
    typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value),
    `${label} is invalid`,
  );
  return value;
}

function nanoseconds(value, label) {
  assert(
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value),
    `${label} timestamp is invalid`,
  );
  return BigInt(value);
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
