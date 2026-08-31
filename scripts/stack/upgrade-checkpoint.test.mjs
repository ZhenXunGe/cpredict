import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createUpgradeCheckpoint,
  parseJsonRecords,
} from "./upgrade-checkpoint.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cpredict-checkpoint-"));
  const runtimeRoot = join(root, "runtime/arbitrum-sepolia/package");
  const backupDirectory = join(root, "runtime/arbitrum-sepolia/backups/one");
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(backupDirectory, { recursive: true });
  await writeFile(
    join(runtimeRoot, "package-manifest.json"),
    '{"schemaVersion":"fixture"}\n',
  );
  await writeFile(
    join(backupDirectory, "backup-manifest.json"),
    '{"status":"PASS"}\n',
  );
  await writeFile(
    join(backupDirectory, "restore-drill-report.json"),
    '{"status":"PASS"}\n',
  );
  return { root, runtimeRoot, backupDirectory };
}

test("upgrade checkpoint binds a clean commit, passing runtime, verified backup and image inventory", async () => {
  const value = await fixture();
  const run = (command, args) => {
    if (command === "git" && args[0] === "status")
      return { code: 0, stdout: "", stderr: "" };
    if (command === "git")
      return { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
    if (args.includes("images"))
      return {
        code: 0,
        stdout: '{"Repository":"cpredict","ID":"sha256:abc"}\n',
        stderr: "",
      };
    return {
      code: 0,
      stdout: '{"Service":"web-demo","State":"running"}\n',
      stderr: "",
    };
  };
  const result = await createUpgradeCheckpoint({
    root: value.root,
    configuration: {
      runtimeRoot: value.runtimeRoot,
      secretPath: join(value.root, ".env.compose.local"),
      publicPath: join(value.root, "current.env"),
      environment: {},
    },
    generatedAt: "2026-08-30T08:00:00.000Z",
    run,
    verify: async () => [{ status: "PASS", name: "runtime", detail: "ready" }],
    backup: async () => ({
      directory: value.backupDirectory,
      report: { status: "PASS" },
    }),
  });
  const checkpoint = JSON.parse(await readFile(result.path, "utf8"));
  assert.equal(checkpoint.gitCommit, "a".repeat(40));
  assert.match(checkpoint.verifiedBackup.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(checkpoint.compose.images[0].ID, "sha256:abc");
});

test("upgrade checkpoint refuses dirty or unhealthy starting state", async () => {
  const value = await fixture();
  await assert.rejects(
    createUpgradeCheckpoint({
      root: value.root,
      run: () => ({ code: 0, stdout: " M compose.yaml\n", stderr: "" }),
    }),
    /must be clean/,
  );

  let calls = 0;
  const run = (command) =>
    command === "git" && calls++ === 0
      ? { code: 0, stdout: "", stderr: "" }
      : { code: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" };
  await assert.rejects(
    createUpgradeCheckpoint({
      root: value.root,
      configuration: { runtimeRoot: value.runtimeRoot },
      run,
      verify: async () => [{ status: "FAIL", name: "runtime", detail: "down" }],
    }),
    /runtime verification failed/,
  );
});

test("checkpoint JSON parser accepts arrays and JSON lines but rejects text", () => {
  assert.equal(parseJsonRecords('[{"a":1}]', "inventory").length, 1);
  assert.equal(parseJsonRecords('{"a":1}\n{"a":2}\n', "inventory").length, 2);
  assert.throws(
    () => parseJsonRecords("table output", "inventory"),
    /not valid JSON/,
  );
  assert.throws(() => parseJsonRecords("[1]", "inventory"), /JSON objects/);
});
