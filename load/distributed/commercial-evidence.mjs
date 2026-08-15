import { createHash, createPublicKey, sign, verify } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  validateProductionK6Api,
  validateProductionK6Websocket,
} from "../../scripts/load/validate-production-evidence.mjs";
import {
  buildTelemetrySummary,
  REQUIRED_TELEMETRY_FAMILIES,
} from "./telemetry-evidence.mjs";
import { buildEventLatencySummary } from "./event-latency-evidence.mjs";
import { validateChainNodeBinding } from "./chain-node-binding.mjs";

export { REQUIRED_TELEMETRY_FAMILIES };
const COMMERCIAL_THRESHOLDS = {
  apiSteadyRps: 500,
  apiSteadySeconds: 300,
  apiBurstRps: 2_000,
  apiBurstSeconds: 60,
  apiDroppedIterations: 0,
  apiP95MsExclusive: 300,
  apiP99MsExclusive: 750,
  websocketSimultaneousConnections: 10_000,
  websocketHoldSeconds: 60,
  chainTransactionsPerSecond: 50,
  chainDurationSeconds: 600,
  chainPlannedTransactions: 30_000,
  eventToClientP95MsExclusive: 2_000,
};

export async function collectCommercialEvidence({
  sutDirectory,
  loadDirectory,
  chainDirectory,
  outputDirectory,
  privateKeyPath,
  publicKeyPath,
  signingKeyId,
}) {
  const sources = {
    sut: await realpath(sutDirectory),
    load: await realpath(loadDirectory),
    chain: await realpath(chainDirectory),
  };
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: false });
  await mkdir(resolve(output, "roles"));
  for (const role of ["sut", "load", "chain"]) {
    await cp(sources[role], resolve(output, "roles", role), {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
      filter: async (source) => !(await lstat(source)).isSymbolicLink(),
    });
  }

  const privateKey = await readFile(privateKeyPath, "utf8");
  const publicKey = await readFile(publicKeyPath, "utf8");
  const derivedPublic = createPublicKey(privateKey).export({
    type: "spki",
    format: "pem",
  });
  const pinnedPublic = createPublicKey(publicKey).export({
    type: "spki",
    format: "pem",
  });
  if (String(derivedPublic) !== String(pinnedPublic))
    throw new Error("signing private/public keys do not match");

  const roles = {};
  for (const role of ["sut", "load", "chain"]) {
    roles[role] = await readJson(
      resolve(output, "roles", role, "role-evidence.json"),
    );
  }
  const runId = roles.sut.runId;
  const manifest = {
    schemaVersion: 4,
    lane: "distributed-commercial-production-equivalent",
    runId,
    runStatus: "completed",
    generatedAt: new Date().toISOString(),
    signing: {
      algorithm: "Ed25519",
      keyId: signingKeyId,
      publicKeySha256: sha256(String(pinnedPublic)),
    },
    roles: Object.fromEntries(
      Object.entries(roles).map(([role, value]) => [
        role,
        {
          host: value.host,
          evidencePath: `roles/${role}/role-evidence.json`,
          evidenceSha256: sha256(`${JSON.stringify(value, null, 2)}\n`),
        },
      ]),
    ),
    topology: {
      sutLoadSeparated:
        roles.sut.host.machineFingerprintSha256 !==
        roles.load.host.machineFingerprintSha256,
      sutChainSeparated:
        roles.sut.host.machineFingerprintSha256 !==
        roles.chain.host.machineFingerprintSha256,
      loadChainSeparated:
        roles.load.host.machineFingerprintSha256 !==
        roles.chain.host.machineFingerprintSha256,
    },
    thresholds: COMMERCIAL_THRESHOLDS,
    overall: 0,
  };
  await validateCommercialBundle(output, manifest);
  const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
  const temporary = resolve(output, ".commercial-evidence-v4.json.tmp");
  await writeFile(temporary, encoded, "utf8");
  await rename(temporary, resolve(output, "commercial-evidence-v4.json"));
  await writeFile(
    resolve(output, "commercial-evidence-v4.sig"),
    `${sign(null, Buffer.from(encoded), privateKey).toString("base64")}\n`,
    "utf8",
  );
  return manifest;
}

export async function validateCommercialBundle(
  bundleDirectory,
  suppliedManifest,
  publicKeyPath,
) {
  const bundle = await realpath(bundleDirectory);
  const manifest =
    suppliedManifest ??
    (await readJson(resolve(bundle, "commercial-evidence-v4.json")));
  object(manifest, "commercial evidence manifest");
  equal(manifest.schemaVersion, 4, "commercial evidence schemaVersion");
  equal(
    manifest.lane,
    "distributed-commercial-production-equivalent",
    "commercial evidence lane",
  );
  equal(
    manifest.runStatus,
    "completed",
    "commercial evidence completion status",
  );
  equal(manifest.overall, 0, "commercial evidence overall");
  validRunId(manifest.runId);
  assert(
    !Number.isNaN(Date.parse(manifest.generatedAt)),
    "commercial evidence timestamp is invalid",
  );
  equal(
    manifest.signing?.algorithm,
    "Ed25519",
    "commercial evidence signing algorithm",
  );
  assert(
    typeof manifest.signing?.keyId === "string" &&
      manifest.signing.keyId.length > 0,
    "signing keyId is missing",
  );
  deepEqual(
    manifest.thresholds,
    COMMERCIAL_THRESHOLDS,
    "commercial thresholds",
  );

  const roles = {};
  for (const role of ["sut", "load", "chain"]) {
    const reference = manifest.roles?.[role];
    object(reference, `${role} role reference`);
    const expectedPath = `roles/${role}/role-evidence.json`;
    equal(reference.evidencePath, expectedPath, `${role} evidence path`);
    const path = safeBundlePath(bundle, expectedPath);
    const encoded = await readFile(path, "utf8");
    equal(sha256(encoded), reference.evidenceSha256, `${role} evidence digest`);
    const roleEvidence = JSON.parse(encoded);
    validateRole(roleEvidence, role, manifest.runId);
    deepEqual(reference.host, roleEvidence.host, `${role} host reference`);
    await validateArtifactInventory(dirname(path), roleEvidence.artifacts);
    await validateBoundReleaseFiles(dirname(path), roleEvidence, role);
    roles[role] = roleEvidence;
  }

  validateRoleTopology(roles);
  allTrue(manifest.topology, "commercial topology separation");

  const api = await readRoleArtifact(bundle, "load", "k6-api-summary.json");
  const websocket = await readRoleArtifact(
    bundle,
    "load",
    "k6-websocket-summary.json",
  );
  const before = await readRoleArtifact(
    bundle,
    "load",
    "websocket-capacity-before.json",
  );
  const after = await readRoleArtifact(
    bundle,
    "load",
    "websocket-capacity-after.json",
  );
  validateProductionK6Api(api);
  validateProductionK6Websocket(websocket);
  validateDistributedWebsocketCapacity(before, after);
  const chainBody = await readFile(
    safeBundlePath(bundle, "roles/chain/chain.json"),
  );
  const chain = JSON.parse(chainBody);
  validateChain(chain);
  const chainPreflightBody = await readFile(
    safeBundlePath(bundle, "roles/chain/chain-node-preflight.json"),
  );
  const chainFinal = await readRoleArtifact(
    bundle,
    "chain",
    "chain-node-final.json",
  );
  const chainPreflight = JSON.parse(chainPreflightBody);
  validateChainNodeBinding(chainFinal, {
    phase: "final",
    runId: manifest.runId,
    preflight: chainPreflight,
    preflightSha256: sha256(chainPreflightBody),
    chain,
    chainSha256: sha256(chainBody),
  });
  const eventRawBody = await readFile(
    safeBundlePath(bundle, "roles/chain/event-latency-raw.json"),
  );
  validateEventLatency(
    await readRoleArtifact(bundle, "chain", "event-latency.json"),
    JSON.parse(eventRawBody),
    chain,
    sha256(chainBody),
    sha256(eventRawBody),
  );
  validateReorg(await readRoleArtifact(bundle, "chain", "reorg-recovery.json"));
  const telemetryBody = await readFile(
    safeBundlePath(bundle, "roles/sut/telemetry-raw.json"),
  );
  validateTelemetry(
    await readRoleArtifact(bundle, "sut", "telemetry-summary.json"),
    JSON.parse(telemetryBody),
    sha256(telemetryBody),
  );

  if (publicKeyPath !== undefined) {
    const manifestBody = await readFile(
      resolve(bundle, "commercial-evidence-v4.json"),
    );
    const signature = Buffer.from(
      (
        await readFile(resolve(bundle, "commercial-evidence-v4.sig"), "utf8")
      ).trim(),
      "base64",
    );
    const publicKey = await readFile(publicKeyPath, "utf8");
    const normalized = String(
      createPublicKey(publicKey).export({ type: "spki", format: "pem" }),
    );
    equal(
      sha256(normalized),
      manifest.signing.publicKeySha256,
      "pinned signing public key",
    );
    assert(
      verify(null, manifestBody, publicKey, signature),
      "commercial evidence signature is invalid",
    );
  }
  return manifest;
}

export function validateRoleTopology(roles) {
  for (const role of ["sut", "load", "chain"])
    validateReleaseAndWindow(roles[role], role);
  const identities = [roles.sut, roles.load, roles.chain].map(
    (value) => value.host.identitySha256,
  );
  const fingerprints = [roles.sut, roles.load, roles.chain].map(
    (value) => value.host.machineFingerprintSha256,
  );
  equal(new Set(identities).size, 3, "declared host identity separation");
  equal(
    new Set(fingerprints).size,
    3,
    "observed machine fingerprint separation",
  );
  for (const key of [
    "gitCommitSha",
    "sourceManifestSha256",
    "releaseConfigSha256",
    "migrationsSha256",
  ]) {
    equal(
      new Set(
        [roles.sut, roles.load, roles.chain].map(
          (value) => value.releaseBinding[key],
        ),
      ).size,
      1,
      `release binding ${key}`,
    );
  }
  const start = Math.max(
    ...[roles.sut, roles.load, roles.chain].map((value) =>
      Date.parse(value.window.startedAt),
    ),
  );
  const end = Math.min(
    ...[roles.sut, roles.load, roles.chain].map((value) =>
      Date.parse(value.window.completedAt),
    ),
  );
  assert(
    end - start >= 300_000,
    "SUT, load, and chain roles must overlap for at least 300 seconds",
  );
  const tolerance = 5_000;
  assert(
    Date.parse(roles.sut.window.startedAt) <=
      Math.min(
        Date.parse(roles.load.window.startedAt),
        Date.parse(roles.chain.window.startedAt),
      ) +
        tolerance,
    "SUT observation must start before load and chain roles",
  );
  assert(
    Date.parse(roles.sut.window.completedAt) + tolerance >=
      Math.max(
        Date.parse(roles.load.window.completedAt),
        Date.parse(roles.chain.window.completedAt),
      ),
    "SUT observation must cover load and chain role completion",
  );
  validateTargets(roles);
}

function validateTargets(roles) {
  for (const role of ["sut", "load", "chain"])
    object(roles[role].targets, `${role} targets`);
  const sutOrigin = roles.sut.targets.sutOrigin;
  const websocketTarget = roles.sut.targets.websocketTarget;
  const chainRpcOrigin = roles.sut.targets.chainRpcOrigin;
  secureRemoteOrigin(sutOrigin, "SUT origin", "https:");
  secureRemoteWebsocketTarget(websocketTarget, "WebSocket target");
  secureRemoteOrigin(chainRpcOrigin, "chain RPC origin", "https:");
  equal(
    new URL(sutOrigin).host,
    new URL(websocketTarget).host,
    "SUT API/WebSocket host and port",
  );
  equal(roles.load.targets.sutOrigin, sutOrigin, "load/SUT API target");
  equal(
    roles.load.targets.websocketTarget,
    websocketTarget,
    "load/SUT WebSocket target",
  );
  equal(
    roles.chain.targets.sutOrigin,
    sutOrigin,
    "chain observer/SUT API target",
  );
  equal(
    roles.chain.targets.websocketTarget,
    websocketTarget,
    "chain observer/SUT WebSocket target",
  );
  equal(
    roles.chain.targets.chainRpcOrigin,
    chainRpcOrigin,
    "chain observer/SUT chain target",
  );
  assert(
    new URL(sutOrigin).hostname !== new URL(chainRpcOrigin).hostname,
    "production-equivalent SUT and controlled chain endpoints must use distinct hosts",
  );
}

export function validateTelemetry(report, raw, rawSha256) {
  object(report, "telemetry summary");
  equal(report.schemaVersion, 2, "telemetry schemaVersion");
  equal(report.lane, "distributed-commercial-sut-telemetry", "telemetry lane");
  assert(
    Number.isSafeInteger(report.sampleCount) && report.sampleCount >= 2,
    "telemetry sample count is invalid",
  );
  assert(
    Date.parse(report.completedAt) - Date.parse(report.startedAt) >= 600_000,
    "telemetry window must cover at least 600 seconds",
  );
  deepEqual(
    report,
    buildTelemetrySummary(raw, rawSha256),
    "telemetry raw recomputation",
  );
  deepEqual(
    [...report.requiredFamilies].sort(),
    [...REQUIRED_TELEMETRY_FAMILIES].sort(),
    "telemetry family inventory",
  );
  for (const family of REQUIRED_TELEMETRY_FAMILIES)
    equal(report.observedFamilies?.[family], true, `telemetry ${family}`);
  for (const [value, label] of [
    [report.api?.cpuSecondsDelta, "API CPU seconds delta"],
    [report.api?.maxResidentMemoryBytes, "API resident memory"],
    [report.api?.maxEventLoopLagMs, "API event-loop lag"],
    [report.api?.maxConnections, "API connections"],
    [report.api?.maxRequestsQueued, "API queued requests"],
    [report.api?.maxRequestsInFlight, "API in-flight requests"],
    [report.api?.requestLatencyMs?.p95, "API request p95"],
    [report.api?.requestLatencyMs?.p99, "API request p99"],
    [report.database?.configuredConnections, "database configured connections"],
    [report.database?.maxOperationsQueued, "database queued operations"],
    [report.database?.maxOperationsInFlight, "database in-flight operations"],
    [report.database?.admissionWaitMs?.p95, "database admission wait p95"],
    [report.database?.operationLatencyMs?.p95, "database operation p95"],
    [report.postgres?.maxActiveConnections, "PostgreSQL active connections"],
    [report.postgres?.checkpointsDelta, "PostgreSQL checkpoints"],
    [
      report.postgres?.transactionsPerSecond?.p95,
      "PostgreSQL transactions per second p95",
    ],
    [report.indexer?.tickLatencyMs?.p95, "Indexer tick p95"],
    [report.websocket?.acceptedDelta, "WebSocket accepted delta"],
    [report.websocket?.maxCurrent, "WebSocket max current"],
    [report.websocket?.peak, "WebSocket peak"],
    [report.websocket?.rejectedDelta, "WebSocket rejected delta"],
    [report.websocket?.readyDelta, "WebSocket ready delta"],
    [report.websocket?.heartbeatDelta, "WebSocket heartbeat delta"],
  ])
    finiteNonnegative(value, label);
  assert(
    report.database.maxOperationsInFlight <=
      report.database.configuredConnections,
    "database in-flight operations exceeded the configured connection budget",
  );
  assert(
    Number.isSafeInteger(report.indexer?.maxBlockLag) &&
      report.indexer.maxBlockLag >= 0,
    "indexer block lag is invalid",
  );
  assert(
    Number.isSafeInteger(report.indexer?.allowedBlockLag) &&
      report.indexer.allowedBlockLag >= 0,
    "indexer allowed lag is invalid",
  );
  assert(
    report.indexer.maxBlockLag <= report.indexer.allowedBlockLag,
    "indexer block lag exceeded its approved bound",
  );
}

export function validateDistributedWebsocketCapacity(before, after) {
  for (const [value, phase] of [
    [before, "before"],
    [after, "after"],
  ]) {
    object(value, `WebSocket ${phase} capacity snapshot`);
    equal(value.schemaVersion, 1, `WebSocket ${phase} schemaVersion`);
    equal(value.phase, phase, `WebSocket ${phase} phase`);
    validRunId(value.runId);
    assert(
      Number.isFinite(value.processStartTimeSeconds) &&
        value.processStartTimeSeconds > 0,
      `WebSocket ${phase} process start time is invalid`,
    );
    for (const key of [
      "acceptedTotal",
      "rejectedTotal",
      "currentConnections",
      "peakConnections",
    ]) {
      assert(
        Number.isSafeInteger(value[key]) && value[key] >= 0,
        `WebSocket ${phase} ${key} is invalid`,
      );
    }
  }
  equal(after.runId, before.runId, "WebSocket capacity runId");
  equal(after.target, before.target, "WebSocket capacity target");
  equal(
    after.processStartTimeSeconds,
    before.processStartTimeSeconds,
    "WebSocket SUT process identity",
  );
  secureRemoteOrigin(before.target, "WebSocket capacity target", "https:");
  assert(
    Date.parse(before.observedAt) < Date.parse(after.observedAt),
    "WebSocket capacity snapshots are not ordered",
  );
  equal(before.currentConnections, 0, "WebSocket baseline current connections");
  equal(
    before.peakConnections,
    0,
    "WebSocket baseline peak must be zero for a fresh SUT process",
  );
  equal(
    after.acceptedTotal - before.acceptedTotal,
    10_000,
    "WebSocket accepted-session delta",
  );
  equal(
    after.rejectedTotal - before.rejectedTotal,
    0,
    "WebSocket rejected-session delta",
  );
  equal(after.currentConnections, 0, "WebSocket final current connections");
  equal(
    after.peakConnections,
    10_000,
    "WebSocket simultaneous peak connections",
  );
}

export function validateChain(report) {
  object(report, "chain load report");
  equal(report.profile, "full", "chain profile");
  equal(report.targetTps, 50, "chain target TPS");
  equal(report.durationSeconds, 600, "chain duration");
  equal(report.classifications?.planned, 30_000, "chain planned transactions");
  equal(
    report.classifications?.submitted,
    30_000,
    "chain submitted transactions",
  );
  equal(
    report.classifications?.included,
    30_000,
    "chain included transactions",
  );
  equal(
    report.classifications?.rejectedSubmission,
    0,
    "chain rejected submissions",
  );
  equal(
    report.classifications?.unexpectedRevert,
    0,
    "chain unexpected reverts",
  );
  equal(
    report.classifications?.unexpectedSuccess,
    0,
    "chain unexpected successes",
  );
  equal(report.classifications?.missingReceipt, 0, "chain missing receipts");
  allTrue(report.thresholds, "chain thresholds");
}

export function validateEventLatency(
  report,
  raw,
  chain,
  chainSha256,
  rawSha256,
) {
  object(report, "event latency report");
  equal(report.schemaVersion, 2, "event latency schemaVersion");
  equal(
    report.lane,
    "chain-event-to-websocket-client-inventory",
    "event latency lane",
  );
  validateChain(chain);
  deepEqual(
    report,
    buildEventLatencySummary(raw, chain, chainSha256, rawSha256),
    "event latency raw recomputation",
  );
  equal(
    report.chainReportSha256,
    chainSha256,
    "event latency chain report binding",
  );
  equal(report.markerEvent, "PrimaryPurchased", "event latency marker event");
  equal(
    report.measurement?.clockDomain,
    "single-process-monotonic-nanoseconds",
    "event latency clock domain",
  );
  equal(
    report.chainInventory?.includedTransactions,
    chain.classifications.included,
    "event latency included inventory",
  );
  equal(
    report.chainInventory?.successfulTransactions,
    chain.classifications.success,
    "event latency successful inventory",
  );
  equal(
    report.chainInventory?.expectedRevertedTransactions,
    chain.classifications.expectedRevert,
    "event latency expected-revert inventory",
  );
  equal(
    report.eventInventory?.expected,
    chain.classifications.success,
    "event latency expected event inventory",
  );
  equal(
    report.eventInventory?.delivered,
    report.eventInventory.expected,
    "event latency delivered inventory",
  );
  equal(
    report.eventInventory?.uniqueDelivered,
    report.eventInventory.expected,
    "event latency unique delivered inventory",
  );
  equal(report.eventInventory?.missing, 0, "event latency missing events");
  equal(report.eventInventory?.duplicates, 0, "event latency duplicate events");
  equal(
    report.eventInventory?.unexpected,
    0,
    "event latency unexpected events",
  );
  equal(
    report.samples,
    report.eventInventory.uniqueDelivered,
    "event latency sample inventory",
  );
  assert(
    Number.isSafeInteger(report.samples) && report.samples > 0,
    "event latency samples are invalid",
  );
  finiteNonnegative(report.latencyMs?.p95, "event-to-client p95");
  finiteNonnegative(report.latencyMs?.p99, "event-to-client p99");
  assert(
    report.latencyMs.p95 < 2_000,
    "event-to-client p95 must be below 2000 ms",
  );
  equal(
    report.clockSynchronizationVerified,
    true,
    "event latency clock synchronization",
  );
}

export function validateReorg(report) {
  object(report, "reorg recovery report");
  equal(report.schemaVersion, 2, "reorg schemaVersion");
  equal(
    report.lane,
    "multi-block-common-ancestor-rollback-replay",
    "reorg lane",
  );
  assert(
    Number.isSafeInteger(report.injectedDepth) && report.injectedDepth >= 2,
    "reorg must replace multiple blocks",
  );
  blockReference(report.commonAncestor, "reorg common ancestor");
  branchReference(report.oldBranch, report.commonAncestor, "reorg old branch");
  branchReference(report.newBranch, report.commonAncestor, "reorg new branch");
  equal(
    report.oldBranch.blockCount,
    report.injectedDepth,
    "reorg old branch depth",
  );
  equal(
    report.newBranch.blockCount,
    report.injectedDepth,
    "reorg new branch depth",
  );
  assert(
    report.oldBranch.tipHash !== report.newBranch.tipHash,
    "reorg branch tip hashes must diverge",
  );
  nonnegativeInteger(
    report.rollback?.orphanedBlockRowsBefore,
    "reorg orphaned blocks before rollback",
  );
  nonnegativeInteger(
    report.rollback?.orphanedEventRowsBefore,
    "reorg orphaned events before rollback",
  );
  equal(
    report.rollback?.orphanedBlockRowsBefore,
    report.oldBranch.blockCount,
    "reorg rollback block inventory",
  );
  equal(
    report.rollback?.orphanedBlockRowsAfter,
    0,
    "reorg orphaned blocks after rollback",
  );
  equal(
    report.rollback?.orphanedEventRowsAfter,
    0,
    "reorg orphaned events after rollback",
  );
  equal(
    report.rollback?.transactionAtomicityFailures,
    0,
    "reorg rollback atomicity failures",
  );
  equal(
    report.replay?.expectedBlocks,
    report.newBranch.blockCount,
    "reorg expected replay blocks",
  );
  equal(
    report.replay?.replayedBlocks,
    report.replay.expectedBlocks,
    "reorg replayed blocks",
  );
  nonnegativeInteger(
    report.replay?.expectedEvents,
    "reorg expected replay events",
  );
  equal(
    report.replay?.replayedEvents,
    report.replay.expectedEvents,
    "reorg replayed events",
  );
  equal(report.replay?.missingEvents, 0, "reorg replay missing events");
  equal(report.replay?.duplicateEvents, 0, "reorg replay duplicate events");
  blockReference(report.finalCheckpoint, "reorg final checkpoint");
  equal(
    report.finalCheckpoint.blockNumber,
    report.newBranch.tipBlockNumber,
    "reorg final checkpoint number",
  );
  equal(
    report.finalCheckpoint.blockHash,
    report.newBranch.tipHash,
    "reorg final checkpoint hash",
  );
  finiteNonnegative(report.recoveryMs, "reorg recovery duration");
}

export function validateRoleEvidence(report, expectedRole, runId) {
  object(report, `${expectedRole} role evidence`);
  equal(report.schemaVersion, 1, `${expectedRole} schemaVersion`);
  equal(
    report.lane,
    "distributed-commercial-load-role",
    `${expectedRole} lane`,
  );
  equal(report.role, expectedRole, `${expectedRole} role`);
  equal(report.runId, runId, `${expectedRole} runId`);
  equal(report.runStatus, "completed", `${expectedRole} completion status`);
  object(report.host, `${expectedRole} host`);
  for (const key of ["identitySha256", "machineFingerprintSha256"]) {
    assert(
      /^[0-9a-f]{64}$/.test(report.host[key]),
      `${expectedRole} ${key} is invalid`,
    );
  }
  assert(
    typeof report.host.identitySource === "string" &&
      report.host.identitySource.length > 0,
    `${expectedRole} identity source is missing`,
  );
  object(
    report.host.identityEvidence,
    `${expectedRole} host identity evidence`,
  );
  equal(
    report.host.identityEvidence.path,
    "host-identity-evidence.bin",
    `${expectedRole} host identity evidence path`,
  );
  assert(
    /^[0-9a-f]{64}$/.test(report.host.identityEvidence.sha256),
    `${expectedRole} host identity evidence digest is invalid`,
  );
  assert(
    Number.isSafeInteger(report.host.identityEvidence.bytes) &&
      report.host.identityEvidence.bytes >= 1 &&
      report.host.identityEvidence.bytes <= 1_048_576,
    `${expectedRole} host identity evidence size is invalid`,
  );
  equal(
    report.host.identityEvidence.assurance,
    "opaque-external-host-identity-evidence-not-cryptographically-verified-by-cpredict",
    `${expectedRole} host identity assurance boundary`,
  );
  object(report.stages, `${expectedRole} stages`);
  assert(
    Object.keys(report.stages).length > 0,
    `${expectedRole} stage inventory is empty`,
  );
  assert(
    Object.values(report.stages).every((status) => status === 0),
    `${expectedRole} contains a failed or unrun stage`,
  );
  assert(
    Array.isArray(report.artifacts) && report.artifacts.length > 0,
    `${expectedRole} artifacts are missing`,
  );
  const identityArtifact = report.artifacts.find(
    (entry) => entry.name === report.host.identityEvidence.path,
  );
  object(identityArtifact, `${expectedRole} host identity artifact`);
  equal(
    identityArtifact.sha256,
    report.host.identityEvidence.sha256,
    `${expectedRole} host identity artifact digest`,
  );
  equal(
    identityArtifact.bytes,
    report.host.identityEvidence.bytes,
    `${expectedRole} host identity artifact size`,
  );
}

const validateRole = validateRoleEvidence;

function validateReleaseAndWindow(report, role) {
  object(report.releaseBinding, `${role} release binding`);
  assert(
    /^[0-9a-f]{40}$/.test(report.releaseBinding.gitCommitSha),
    `${role} git commit SHA is invalid`,
  );
  for (const key of [
    "sourceManifestSha256",
    "releaseConfigSha256",
    "migrationsSha256",
  ]) {
    assert(
      /^[0-9a-f]{64}$/.test(report.releaseBinding[key]),
      `${role} ${key} is invalid`,
    );
  }
  assert(
    /^sha256:[0-9a-f]{64}$/.test(report.releaseBinding.runtimeImageDigest),
    `${role} runtime image digest is invalid`,
  );
  object(report.window, `${role} window`);
  const started = Date.parse(report.window.startedAt);
  const completed = Date.parse(report.window.completedAt);
  assert(
    Number.isFinite(started) &&
      Number.isFinite(completed) &&
      completed > started,
    `${role} time window is invalid`,
  );
  const observed = Date.parse(report.observedAt);
  assert(
    Number.isFinite(observed) &&
      observed >= started &&
      observed <= completed + 5_000,
    `${role} role evidence timestamp is outside its window`,
  );
  assert(
    typeof report.window.clockSource === "string" &&
      report.window.clockSource.length > 0,
    `${role} clock source is missing`,
  );
  assert(
    Number.isFinite(report.window.clockMaxOffsetMs) &&
      report.window.clockMaxOffsetMs >= 0 &&
      report.window.clockMaxOffsetMs <= 100,
    `${role} clock offset exceeds 100 ms`,
  );
}

async function validateArtifactInventory(directory, inventory) {
  const names = (await readdir(directory))
    .filter((name) => name !== "role-evidence.json" && !name.startsWith("."))
    .sort();
  deepEqual(
    inventory.map((entry) => entry.name),
    names,
    "role artifact inventory",
  );
  for (const entry of inventory) {
    const path = safeBundlePath(directory, entry.name);
    const metadata = await lstat(path);
    assert(
      metadata.isFile() && !metadata.isSymbolicLink(),
      `role artifact is not a regular file: ${entry.name}`,
    );
    const body = await readFile(path);
    equal(body.byteLength, entry.bytes, `role artifact bytes: ${entry.name}`);
    equal(sha256(body), entry.sha256, `role artifact digest: ${entry.name}`);
  }
}

async function validateBoundReleaseFiles(directory, report, role) {
  const sourceManifest = await readFile(
    safeBundlePath(directory, "source-manifest.json"),
  );
  const releaseConfigBody = await readFile(
    safeBundlePath(directory, "release-config.json"),
  );
  const releaseConfig = JSON.parse(releaseConfigBody);
  const migrations = await readJson(
    safeBundlePath(directory, "migrations-manifest.json"),
  );
  const clock = await readJson(
    safeBundlePath(directory, "clock-evidence.json"),
  );
  equal(
    sha256(sourceManifest),
    report.releaseBinding.sourceManifestSha256,
    `${role} source manifest binding`,
  );
  equal(
    sha256(releaseConfigBody),
    report.releaseBinding.releaseConfigSha256,
    `${role} release config binding`,
  );
  equal(
    migrations.schemaVersion,
    1,
    `${role} migrations manifest schemaVersion`,
  );
  equal(
    migrations.treeSha256,
    report.releaseBinding.migrationsSha256,
    `${role} migrations binding`,
  );
  assert(
    Array.isArray(migrations.files) && migrations.files.length > 0,
    `${role} migrations inventory is empty`,
  );
  equal(releaseConfig.schemaVersion, 1, `${role} release config schemaVersion`);
  equal(
    releaseConfig.gitCommitSha,
    report.releaseBinding.gitCommitSha,
    `${role} release config commit`,
  );
  equal(
    releaseConfig.sourceManifestSha256,
    report.releaseBinding.sourceManifestSha256,
    `${role} release config source manifest`,
  );
  equal(
    releaseConfig.migrationsSha256,
    report.releaseBinding.migrationsSha256,
    `${role} release config migrations`,
  );
  equal(
    releaseConfig.runtimeImageDigests?.[role],
    report.releaseBinding.runtimeImageDigest,
    `${role} release config image`,
  );
  equal(clock.schemaVersion, 1, `${role} clock evidence schemaVersion`);
  equal(
    clock.source,
    report.window.clockSource,
    `${role} clock source evidence`,
  );
  equal(
    clock.maxOffsetMs,
    report.window.clockMaxOffsetMs,
    `${role} clock offset evidence`,
  );
  const clockObservedAt = Date.parse(clock.observedAt);
  assert(
    Number.isFinite(clockObservedAt),
    `${role} clock evidence timestamp is invalid`,
  );
  const roleStartedAt = Date.parse(report.window.startedAt);
  const roleCompletedAt = Date.parse(report.window.completedAt);
  validateClockWindow(clockObservedAt, roleStartedAt, roleCompletedAt, role);
}

export function validateClockWindow(
  clockObservedAt,
  roleStartedAt,
  roleCompletedAt,
  role,
) {
  assert(
    Number.isFinite(clockObservedAt) &&
      Number.isFinite(roleStartedAt) &&
      Number.isFinite(roleCompletedAt),
    `${role} clock window is invalid`,
  );
  assert(
    clockObservedAt >= roleStartedAt - 60_000 &&
      clockObservedAt <= roleCompletedAt,
    `${role} clock evidence must be observed within 60 seconds before or during the role window`,
  );
}

async function readRoleArtifact(bundle, role, name) {
  return readJson(safeBundlePath(bundle, `roles/${role}/${name}`));
}

function safeBundlePath(root, relative) {
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}${sep}`))
    throw new Error("evidence path escapes bundle");
  return path;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function allTrue(value, label) {
  object(value, label);
  assert(
    Object.keys(value).length > 0 &&
      Object.values(value).every((entry) => entry === true),
    `${label} contains a failed result`,
  );
}

function finiteNonnegative(value, label) {
  assert(
    Number.isFinite(value) && value >= 0,
    `${label} must be finite and non-negative`,
  );
}

function nonnegativeInteger(value, label) {
  assert(
    Number.isSafeInteger(value) && value >= 0,
    `${label} must be a non-negative safe integer`,
  );
}

function blockReference(value, label) {
  object(value, label);
  nonnegativeInteger(value.blockNumber, `${label} number`);
  assert(/^0x[0-9a-f]{64}$/.test(value.blockHash), `${label} hash is invalid`);
}

function branchReference(value, ancestor, label) {
  object(value, label);
  nonnegativeInteger(value.tipBlockNumber, `${label} tip number`);
  assert(
    /^0x[0-9a-f]{64}$/.test(value.tipHash),
    `${label} tip hash is invalid`,
  );
  nonnegativeInteger(value.blockCount, `${label} block count`);
  equal(
    value.tipBlockNumber - ancestor.blockNumber,
    value.blockCount,
    `${label} contiguous block inventory`,
  );
}

function secureRemoteOrigin(value, label, protocol) {
  assert(typeof value === "string", `${label} is missing`);
  const url = new URL(value);
  equal(url.protocol, protocol, `${label} protocol`);
  assert(
    !new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]).has(
      url.hostname,
    ),
    `${label} must be non-loopback`,
  );
  assert(
    url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "",
    `${label} must be a credential-free normalized origin`,
  );
}

function secureRemoteWebsocketTarget(value, label) {
  assert(typeof value === "string", `${label} is missing`);
  const url = new URL(value);
  equal(url.protocol, "wss:", `${label} protocol`);
  assert(
    !new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]).has(
      url.hostname,
    ),
    `${label} must be non-loopback`,
  );
  assert(
    url.username === "" &&
      url.password === "" &&
      url.pathname === "/v1/stream" &&
      url.search === "" &&
      url.hash === "",
    `${label} must be a credential-free /v1/stream target`,
  );
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

function deepEqual(actual, expected, label) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: inventory changed`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
  const [mode, ...args] = process.argv.slice(2);
  try {
    if (mode === "collect") {
      if (args.length !== 7)
        throw new Error(
          "collect expects sut load chain output private-key public-key key-id",
        );
      await collectCommercialEvidence({
        sutDirectory: args[0],
        loadDirectory: args[1],
        chainDirectory: args[2],
        outputDirectory: args[3],
        privateKeyPath: args[4],
        publicKeyPath: args[5],
        signingKeyId: args[6],
      });
      process.stdout.write(
        `collected signed commercial evidence at ${resolve(args[3])}\n`,
      );
    } else if (mode === "validate") {
      if (args.length !== 2)
        throw new Error("validate expects bundle and trusted public key");
      await validateCommercialBundle(args[0], undefined, args[1]);
      process.stdout.write("validated distributed commercial evidence\n");
    } else if (mode === "validate-websocket-capacity") {
      if (args.length !== 2)
        throw new Error(
          "validate-websocket-capacity expects before and after reports",
        );
      validateDistributedWebsocketCapacity(
        await readJson(args[0]),
        await readJson(args[1]),
      );
      process.stdout.write(
        "validated distributed WebSocket capacity evidence\n",
      );
    } else if (mode === "validate-event-latency") {
      if (args.length !== 3)
        throw new Error(
          "validate-event-latency expects summary, raw, and chain reports",
        );
      const rawBody = await readFile(args[1]);
      const chainBody = await readFile(args[2]);
      validateEventLatency(
        await readJson(args[0]),
        JSON.parse(rawBody),
        JSON.parse(chainBody),
        sha256(chainBody),
        sha256(rawBody),
      );
      process.stdout.write("validated event-to-client latency evidence\n");
    } else if (mode === "validate-reorg") {
      if (args.length !== 1)
        throw new Error("validate-reorg expects one report");
      validateReorg(await readJson(args[0]));
      process.stdout.write("validated reorg recovery evidence\n");
    } else if (mode === "validate-telemetry") {
      if (args.length !== 2)
        throw new Error("validate-telemetry expects summary and raw reports");
      const rawBody = await readFile(args[1]);
      validateTelemetry(
        await readJson(args[0]),
        JSON.parse(rawBody),
        sha256(rawBody),
      );
      process.stdout.write("validated simultaneous telemetry evidence\n");
    } else {
      throw new Error("unsupported distributed commercial evidence mode");
    }
  } catch (error) {
    process.stderr.write(
      `distributed commercial evidence failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}
