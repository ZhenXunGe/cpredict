import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  open,
} from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import postgres from "postgres";
import { createPublicClient, http } from "viem";
import { Registry } from "prom-client";
import { PostgresEventStore } from "../../dist/offchain/indexer/src/postgres-store.js";
import { createIndexerApi } from "../../dist/offchain/indexer/src/api.js";
import { env } from "../../dist/offchain/app-core/test/fixtures.js";
import { sourceManifestPaths } from "../manifest-inventory.mjs";
import { seedPublicSite } from "../../load/public-site/seed.mjs";

const root = resolve(import.meta.dirname, "../.."),
  pg = resolve(root, ".tools/postgresql-17.10/bin"),
  k6 = resolve(root, ".tools/k6/k6");
const seconds = process.argv.includes("--prepare") ? 30 : 1800;
const digest = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const lock = async (file) =>
  new Map(
    (await readFile(resolve(root, file), "utf8"))
      .split("\n")
      .map((line) => line.split(" | ").map((v) => v.trim())),
  );
const pgLock = await lock("manifests/postgresql-tools.lock"),
  loadLock = await lock("manifests/load-tools.lock");
for (const name of ["postgres", "initdb", "pg_ctl"])
  if (
    (await digest(resolve(pg, name))) !==
    pgLock.get(`postgresql-${name}-binary-sha256`)
  )
    throw new Error("PostgreSQL tool integrity mismatch");
if ((await digest(k6)) !== loadLock.get("k6-binary-sha256"))
  throw new Error("k6 tool integrity mismatch");
const port = await new Promise((done, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => {
    const address = s.address();
    s.close(() => done(address.port));
  });
});
const directory = await mkdtemp("/private/tmp/cpredict-public-capacity-"),
  data = resolve(directory, "data");
const reportDir = resolve(
  root,
  "reports/generated/public-site",
  `capacity-${seconds}-${Date.now()}`,
);
await mkdir(reportDir, { recursive: true });
const report = {
  schemaVersion: 1,
  scope:
    "local PostgreSQL and actual public indexer read API with deterministic ingestion fixtures",
  status: "running",
  seconds,
  virtualReaders: 50,
  queriesPerSecond: 10,
  realWallet: false,
  realMobileDevice: false,
  providerBudgetConsumed: false,
  startedAt: new Date().toISOString(),
  samples: [],
  inputs: [],
};
for (const path of await sourceManifestPaths(root))
  if (
    path.startsWith("offchain/") ||
    path.startsWith("load/public-site/") ||
    path === "load/k6/public-site-read.js" ||
    path === "scripts/public-site/test-capacity.mjs" ||
    path === "package-lock.json"
  )
    report.inputs.push({ path, sha256: await digest(resolve(root, path)) });
const run = (file, args) => {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `${file} failed: ${(result.stderr || result.stdout).slice(-2000)}`,
    );
};
let started = false,
  store,
  sql,
  app,
  sampleTimer,
  child,
  interrupted = false;
const stop = () => {
  interrupted = true;
  child?.kill("SIGTERM");
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  run(resolve(pg, "initdb"), [
    "-D",
    data,
    "--username=cpredict_capacity",
    "--auth-local=trust",
    "--auth-host=trust",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  run(resolve(pg, "pg_ctl"), [
    "-D",
    data,
    "-l",
    resolve(reportDir, "postgres.log"),
    "-o",
    `-c listen_addresses=127.0.0.1 -c port=${port} -c unix_socket_directories=${directory} -c statement_timeout=5s`,
    "-w",
    "start",
  ]);
  started = true;
  const url = `postgresql://cpredict_capacity@127.0.0.1:${port}/postgres?sslmode=disable`;
  sql = postgres(url, { max: 1, onnotice: () => undefined });
  for (const name of [
    "001_indexer.sql",
    "002_settlement_evidence.sql",
    "003_read_api_indexes.sql",
    "004_market_metadata.sql",
    "005_activity_catalog.sql",
    "006_financial_facts.sql",
      "007_legacy_deployment.sql",
  ])
    await sql.unsafe(
      await readFile(
        resolve(root, "offchain/indexer/migrations", name),
        "utf8",
      ),
    );
  store = new PostgresEventStore(url, 10, env);
  await store.ready();
  report.seed = await seedPublicSite(store, sql);
  const registry = new Registry();
  app = createIndexerApi(store, {
    registry,
    financial: {
      ledger: store.financial,
      client: createPublicClient({
        transport: http("http://127.0.0.1:1", { retryCount: 0 }),
      }),
      confirmations: 2n,
    },
  });
  const target = await app.listen({ host: "127.0.0.1", port: 0 });
  report.target = target;
  const sample = async () => {
    const metrics = await registry.getMetricsAsJSON();
    const metric = (name) =>
      metrics.find((v) => v.name === name)?.values[0]?.value ?? null;
    report.samples.push({
      at: new Date().toISOString(),
      rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
      queued: metric("cpredict_indexer_http_requests_queued"),
      inFlight: metric("cpredict_indexer_http_requests_in_flight"),
      connections: metric("cpredict_indexer_http_connections"),
    });
    await writeFile(
      resolve(reportDir, "progress.json"),
      JSON.stringify({
        status: report.status,
        seconds,
        sample: report.samples.at(-1),
      }),
    );
  };
  await sample();
  sampleTimer = setInterval(
    () =>
      void sample().catch(() => {
        report.sampleFailure = true;
      }),
    10000,
  );
  if (interrupted) throw new Error("capacity run interrupted before requests");
  console.log(
    `Capacity ${seconds}s started: 50 virtual readers, 10 queries/sec; ${reportDir}`,
  );
  const log = await open(resolve(reportDir, "k6.log"), "w");
  try {
    const result = await new Promise((done, reject) => {
      child = spawn(
        k6,
        [
          "run",
          "--quiet",
          "--summary-export",
          resolve(reportDir, "k6-summary.json"),
          "-e",
          `CPREDICT_CAPACITY_TARGET=${target}`,
          "-e",
          `CPREDICT_CAPACITY_SECONDS=${seconds}`,
          resolve(root, "load/k6/public-site-read.js"),
        ],
        { cwd: root, stdio: ["ignore", log.fd, log.fd] },
      );
      child.once("error", reject);
      child.once("exit", (code) => done(code));
    });
    report.k6ExitCode = result;
    if (interrupted || result !== 0)
      throw new Error(
        "capacity request thresholds failed or run was interrupted; inspect k6.log",
      );
  } finally {
    await log.close();
  }
  await sample();
  const summaries = JSON.parse(
    await readFile(resolve(reportDir, "k6-summary.json"), "utf8"),
  );
  report.requestMetrics = summaries.metrics;
  const steady = report.samples.slice(
    Math.min(6, Math.floor(report.samples.length / 3)),
  );
  const trend =
    steady.length > 1
      ? (steady.at(-1).rssBytes - steady[0].rssBytes) /
        ((Date.parse(steady.at(-1).at) - Date.parse(steady[0].at)) / 60000)
      : null;
  report.memory = {
    steadyRssBytesPerMinute: trend,
    maximumRssBytes: Math.max(...report.samples.map((s) => s.rssBytes)),
    note: "Includes this Node API process and bounded evidence collector, excludes PostgreSQL and k6. A growth flag needs diagnosis, not automatic dismissal.",
  };
  if (
    report.sampleFailure ||
    (steady.slice(-6).length === 6 && steady.slice(-6).every((s) => s.queued > 0) && steady.at(-1).queued > steady.at(-6).queued) ||
    (seconds === 1800 && (steady.length < 170 || trend > 1048576))
  )
    throw new Error(
      "sustained queue/memory growth or incomplete monitoring requires investigation",
    );
  report.status =
    seconds === 1800
      ? "local-read-capacity-passed"
      : "preparation-passed-not-capacity-acceptance";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  process.exitCode = 1;
} finally {
  clearInterval(sampleTimer);
  await app?.close();
  await store?.close();
  await sql?.end();
  if (started)
    run(resolve(pg, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  await rm(directory, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(
    resolve(reportDir, "result.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({ status: report.status, reportDir, error: report.error }),
  );
}
