// Disposable loopback PostgreSQL using the repository-pinned container image.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
const run = promisify(execFile),
  root = process.cwd(),
  name = `cpredict-session-test-${randomUUID()}`;
const lock = JSON.parse(
  await readFile("manifests/container-images.lock.json", "utf8"),
).images.postgres;
try {
  await run("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    `${lock.reference}@${lock.digest}`,
  ]);
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      await run("docker", ["exec", name, "pg_isready", "--username=postgres"]);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!ready) throw new Error("owned PostgreSQL container did not start");
  const { stdout } = await run("docker", ["port", name, "5432"]);
  const port = stdout.trim().split(":").at(-1);
  const child = spawn(
    `${root}/node_modules/.bin/vitest`,
    [
      "run",
      "offchain/app-service/test/postgres.integration.test.ts",
      "offchain/app-service/test/deployment-rollover.integration.test.ts",
      "--maxWorkers=1",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        TEST_DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
      },
    },
  );
  process.exitCode = await new Promise((resolve) =>
    child.once("exit", resolve),
  );
} catch (e) {
  console.error(e.name);
  process.exitCode = 1;
} finally {
  await run("docker", ["rm", "--force", name]).catch(() => undefined);
}
