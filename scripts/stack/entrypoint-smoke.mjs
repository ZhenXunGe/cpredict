#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const dockerMode = process.argv.includes("--docker");
const dockerfile = await readFile(resolve(root, "deploy/compose/Dockerfile.offchain"), "utf8");
const stages = new Map();
let current;
for (const line of dockerfile.split("\n")) {
  const from = /^FROM (\S+) AS (\S+)/.exec(line);
  if (from) {
    current = { paths: [...(stages.get(from[1])?.paths ?? [])] };
    stages.set(from[2], current);
  }
  const copy = /^COPY --from=build --chown=node:node \/app\/(dist\/\S+) \.\/(dist\/\S+)$/.exec(line);
  if (copy) { assert.equal(copy[1], copy[2]); current.paths.push(copy[1]); }
  const cmd = /^CMD (\[.*\])$/.exec(line);
  if (cmd) current.cmd = JSON.parse(cmd[1]);
}
const expected = {
  indexer: "indexer service failed to start",
  "app-service": "application service configuration or startup verification failed",
  metadata: "metadata service failed to start",
  paymaster: "paymaster service failed to start",
  "permit2-relay": "Permit2 relay service failed to start",
};
const results = [];
for (const [target, message] of Object.entries(expected)) {
  const stage = stages.get(target);
  assert.ok(stage?.cmd && stage.paths.length, `${target} must have an executable runtime stage`);
  let directory;
  try {
    if (!dockerMode) {
      directory = await mkdtemp(join(tmpdir(), `cpredict-entry-${target}-`));
      for (const path of stage.paths) await cp(resolve(root, path), resolve(directory, path), { recursive: true });
      await cp(resolve(root, "package.json"), resolve(directory, "package.json"));
      await symlink(resolve(root, "node_modules"), resolve(directory, "node_modules"));
    }
    const result = dockerMode
      ? spawnSync("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop=ALL", `cpredict-${target}:ci`], { encoding: "utf8", timeout: 15_000 })
      : spawnSync(process.execPath, stage.cmd.slice(1), { cwd: directory, env: { NODE_ENV: "production" }, encoding: "utf8", timeout: 15_000 });
    // Missing configuration is intentional. The actual entry must reach its
    // validation boundary instead of failing at unresolved module imports.
    assert.equal(result.status, 1, `${target}: ${result.error?.message ?? result.stderr}`);
    assert.equal(result.stderr.trim(), message, `${target}: runtime module graph failed`);
    results.push({ target, status: "PASS", outcome: "entry executed and rejected missing private configuration" });
  } finally { if (directory) await rm(directory, { recursive: true }); }
}
const report = {
  generatedAt: new Date().toISOString(),
  evidenceClass: dockerMode ? "CONTAINER_ENTRYPOINT_VALIDATION" : "LOCAL_COMPILED_ENTRYPOINT_VALIDATION",
  limitation: "Does not prove a configured service is ready; local mode uses installed dependencies and does not prove container packaging.",
  results,
};
await mkdir(resolve(root, "reports/generated/public-site"), { recursive: true });
await writeFile(resolve(root, `reports/generated/public-site/entrypoints-${dockerMode ? "container" : "local"}.json`), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${results.length} actual ${dockerMode ? "container" : "compiled"} entrypoints reached configuration validation.\n`);
