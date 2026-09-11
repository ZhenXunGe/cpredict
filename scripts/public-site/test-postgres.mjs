import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runPostgresIntegration,
  PUBLIC_SITE_POSTGRES_INVENTORY,
} from "../release/run-postgres-integration.mjs";
import { verifyInPlaceUpgrade } from "../stack/in-place-upgrade-proof.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pg = resolve(root, ".tools/postgresql-17.10/bin");
const inventory = [
  "offchain/app-service/test/deployment-rollover.integration.test.ts",
  "offchain/app-service/test/postgres.integration.test.ts",
  "offchain/indexer/test/financial-postgres.integration.test.ts",
  "offchain/indexer/test/postgres.integration.test.ts",
  "offchain/indexer/test/reports-postgres.integration.test.ts",
];
const lock = new Map(
  (await readFile(resolve(root, "manifests/postgresql-tools.lock"), "utf8"))
    .split("\n")
    .map((line) => line.split(" | ").map((v) => v.trim())),
);
for (const name of ["postgres", "initdb", "pg_ctl", "psql", "pg_isready"]) {
  const digest = createHash("sha256")
    .update(await readFile(resolve(pg, name)))
    .digest("hex");
  if (digest !== lock.get(`postgresql-${name}-binary-sha256`))
    throw new Error(
      `project-local PostgreSQL ${name} does not match the existing tools lock`,
    );
}
const port = await new Promise((ok, fail) => {
  const s = createServer();
  s.once("error", fail);
  s.listen(0, "127.0.0.1", () => {
    const a = s.address();
    s.close(() => {
      if (a && typeof a !== "string") ok(a.port);
      else fail(new Error("cannot allocate test port"));
    });
  });
});
const directory = await mkdtemp("/private/tmp/cpredict-public-pg-");
const data = resolve(directory, "data");
function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${file} failed: ${(result.stderr || result.stdout || result.error?.message || "").slice(-5000)}`,
    );
  return result;
}
let started = false;
try {
  run(resolve(pg, "initdb"), [
    "-D",
    data,
    "--username=cpredict_test",
    "--auth-local=trust",
    "--auth-host=trust",
    "--no-locale",
    "--encoding=UTF8",
  ]);
  run(resolve(pg, "pg_ctl"), [
    "-D",
    data,
    "-l",
    resolve(directory, "postgres.log"),
    "-o",
    `-c listen_addresses=127.0.0.1 -c port=${port} -c unix_socket_directories=${directory}`,
    "-w",
    "start",
  ]);
  started = true;
  await mkdir(resolve(root, "reports/generated/public-site"), {
    recursive: true,
  });
  const upgrade = await verifyInPlaceUpgrade({ root, pg, directory, port });
  await writeFile(
    resolve(root, "reports/generated/public-site/in-place-upgrade.json"),
    `${JSON.stringify(upgrade, null, 2)}\n`,
  );
  process.stdout.write(
    `In-place database upgrade/restore: ${upgrade.checks.length} checks passed in the owned local cluster.\n`,
  );
  const reportPath = resolve(
    root,
    "reports/generated/public-site/postgres.json",
  );
  run(
    resolve(root, "node_modules/.bin/vitest"),
    [
      "run",
      ...inventory,
      "--maxWorkers=1",
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    {
      env: {
        ...process.env,
        TEST_DATABASE_URL: `postgresql://cpredict_test@127.0.0.1:${port}/postgres?sslmode=disable`,
      },
    },
  );
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (
    !report.success ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    report.numTotalTests !== 31 ||
    report.numPassedTests !== 31
  )
    throw new Error(
      "public-site PostgreSQL tests must all execute and pass (31 expected)",
    );
  process.stdout.write(
    `Public-site PostgreSQL: ${report.numPassedTests}/${report.numTotalTests} passed, no skipped tests.\n`,
  );
  const all = runPostgresIntegration(
    root,
    {
      ...process.env,
      TEST_DATABASE_URL: `postgresql://cpredict_test@127.0.0.1:${port}/postgres?sslmode=disable`,
    },
    PUBLIC_SITE_POSTGRES_INVENTORY,
  );
  await writeFile(
    resolve(root, "reports/generated/public-site/all-postgres.json"),
    `${JSON.stringify(all, null, 2)}\n`,
  );
  process.stdout.write(
    `CI PostgreSQL gate (all public and legacy cases): ${all.passed}/${all.tests} passed, ${all.skipped} skipped.\n`,
  );
} finally {
  if (started)
    run(resolve(pg, "pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
  const status = spawnSync(resolve(pg, "pg_ctl"), ["-D", data, "status"], {
    encoding: "utf8",
  });
  if (status.status !== 3 && started)
    throw new Error(
      `PostgreSQL shutdown could not be verified; retained ${directory}`,
    );
  await rm(directory, { recursive: true });
}
