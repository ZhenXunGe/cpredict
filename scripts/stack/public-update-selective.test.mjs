import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { SERVICES, sha256 } from "./public-update-core.mjs";
import {
  componentInputs,
  buildConfigurationFingerprint,
  composeInputFingerprint,
  dependencyFingerprint,
  deploymentPlan,
  migrationInputs,
  maintenanceActions,
  pendingMigrations,
  runtimeFingerprint,
  touchedServices,
  verifyRetained,
} from "./public-update-plan.mjs";
import {
  applySelectedServices,
  inputDigest,
  mountInputs,
  pinMigrationInputs,
  pinMountInputs,
  pinnedMounts,
  readAppliedMigrations,
  restorePinnedMounts,
  restoreSelectedServices,
  verifyPinnedInputs,
} from "./public-update-runtime.mjs";

const oldRevision = "a".repeat(40),
  newRevision = "b".repeat(40);
function tree(changes = {}) {
  const content = {
    "package.json": JSON.stringify({
      type: "module",
      dependencies: { shared: "1" },
      devDependencies: { typescript: "7" },
      scripts: { "build:offchain": "tsc" },
    }),
    "package-lock.json": JSON.stringify({
      packages: {
        "node_modules/shared": { version: "1" },
        "node_modules/typescript": { version: "7" },
      },
    }),
    "tsconfig.json": "{}",
    "compose.yaml": JSON.stringify({
      services: Object.fromEntries(
        SERVICES.map((s) => [s, { restart: "unless-stopped" }]),
      ),
    }),
    "compose.public-site.yaml": "{}",
    "deploy/compose/Dockerfile.offchain":
      "FROM node AS build\nRUN build\nFROM node AS indexer\nCOPY --from=build /app /app\nFROM node AS metadata\nCOPY --from=build /app /app\nFROM indexer AS app-service\n",
    "deploy/compose/Dockerfile.demo":
      "FROM node AS build\nRUN build\nFROM nginx AS demo\nCOPY --from=build /app /app\nFROM demo AS public-site\n",
    "deploy/compose/nginx/public-site.conf.template": "server {}",
    "offchain/indexer/src/main.ts":
      "import '../../sdk/src/shared.js'; export const value = 1;",
    "offchain/metadata-service/src/main.ts": "export const value = 1;",
    "offchain/app-service/src/main.ts":
      "import '../../sdk/src/shared.js'; export const value = 1;",
    "offchain/sdk/src/shared.ts": "export const shared = 1;",
    "examples/user-site/src/main.tsx":
      "import '../../../offchain/sdk/src/shared.js'; export const View = () => <div />; const lazy = () => import('./lazy.js');",
    "examples/user-site/src/lazy.ts": "export const value = 1;",
    "examples/user-site/index.html": "<html></html>",
    ...changes,
  };
  for (const [path, value] of Object.entries(content))
    if (value === null) delete content[path];
  return {
    revision: newRevision,
    files: new Map(
      Object.entries(content).map(([path, value]) => [
        path,
        { oid: sha256(value), type: "blob", mode: "100644" },
      ]),
    ),
    read: async (path) => {
      assert.ok(path in content, path);
      return content[path];
    },
  };
}
async function state(source) {
  return Object.fromEntries(
    await Promise.all(
      SERVICES.map(async (service) => [
        service,
        {
          ...(await componentInputs(source, service)),
          configFingerprint: "same-runtime",
          image: `sha256:${service}`,
          sourceCommit: oldRevision,
        },
      ]),
    ),
  );
}
async function planFor(changes, migrations = []) {
  return deploymentPlan({
    revision: newRevision,
    previous: await state(tree()),
    current: await state(tree(changes)),
    migrations,
  });
}

test("frontend and lazy imports select only the gateway and public assets", async () => {
  const plan = await planFor({
    "examples/user-site/src/lazy.ts": "export const value = 2;",
  });
  assert.deepEqual(plan.buildServices, ["web-demo"]);
  assert.deepEqual(plan.updateServices, ["web-demo"]);
  assert.deepEqual(plan.retainServices, ["indexer", "metadata", "app-service"]);
  assert.equal(plan.publishAssets, true);
  assert.deepEqual(plan.stopWriters, []);
  assert.deepEqual(plan.backupDatabases, []);
  assert.deepEqual(plan.migrationServices, []);
});
test("isolated backend source does not publish frontend assets or run migrations", async () => {
  const plan = await planFor({
    "offchain/metadata-service/src/main.ts": "export const value = 2;",
  });
  assert.deepEqual(plan.buildServices, ["metadata"]);
  assert.equal(plan.publishAssets, false);
  assert.deepEqual(plan.backupDatabases, []);
});
test("shared imports expand to their consumers, while docs, tests, contracts and tools are no-op", async () => {
  const shared = await planFor({
    "offchain/sdk/src/shared.ts": "export const shared = 2;",
  });
  assert.deepEqual(shared.buildServices, [
    "indexer",
    "app-service",
    "web-demo",
  ]);
  const ignored = await planFor({
    "docs/readme.md": "documentation",
    "scripts/stack/tool.mjs": "console.log('tool');",
    "src/Market.sol": "pragma solidity ^0.8.0; contract Market {}",
    "examples/user-site/test/browser.test.tsx": "throw new Error('fixture');",
    "offchain/indexer/src/main.test.ts": "throw new Error('test');",
  });
  assert.equal(ignored.noop, true);
  assert.deepEqual(ignored.buildServices, []);
});
test("type imports, re-exports and deleted dependencies cannot silently escape the graph", async () => {
  const source = tree({
    "offchain/metadata-service/src/main.ts":
      "export * from '../../sdk/src/shared.js'; type X = import('../../sdk/src/shared.js').Shared;",
  });
  const inputs = await componentInputs(source, "metadata");
  assert.ok(inputs.inputs["offchain/sdk/src/shared.ts"]);
  await assert.rejects(
    componentInputs(
      tree({ "examples/user-site/src/lazy.ts": null }),
      "web-demo",
    ),
    /Unresolved deployment input/,
  );
  await assert.rejects(
    componentInputs(
      tree({
        "examples/user-site/src/lazy.ts":
          "const path = './other.js'; import(path);",
      }),
      "web-demo",
    ),
    /Non-literal import/,
  );
});
test("deployment-only npm dependencies do not invalidate application fingerprints", async () => {
  const base = tree(),
    pkg = JSON.parse(await base.read("package.json")),
    lock = JSON.parse(await base.read("package-lock.json"));
  pkg.devDependencies["@babel/parser"] = "8.0.4";
  pkg.scripts["stack:update:public"] = "node updated-tool.mjs";
  lock.packages["node_modules/@babel/parser"] = { version: "8.0.4", dev: true };
  assert.equal(
    (
      await planFor({
        "package.json": JSON.stringify(pkg),
        "package-lock.json": JSON.stringify(lock),
      })
    ).noop,
    true,
  );
  lock.packages["node_modules/shared"].version = "2";
  assert.deepEqual(
    (await planFor({ "package-lock.json": JSON.stringify(lock) }))
      .buildServices,
    SERVICES,
  );
});
test("nested optional and peer dependency changes are part of the installed closure", () => {
  const lock = {
    packages: {
      "node_modules/a": {
        dependencies: { b: "1" },
        peerDependencies: { peer: "1" },
      },
      "node_modules/a/node_modules/b": {
        version: "1",
        optionalDependencies: { native: "1" },
      },
      "node_modules/native": { version: "1" },
      "node_modules/peer": { version: "1" },
      "node_modules/unrelated": { version: "1" },
    },
  };
  const before = dependencyFingerprint(lock, ["a"]);
  lock.packages["node_modules/unrelated"].version = "2";
  assert.equal(dependencyFingerprint(lock, ["a"]), before);
  lock.packages["node_modules/native"].version = "2";
  assert.notEqual(dependencyFingerprint(lock, ["a"]), before);
});
test("component configuration is isolated and unrelated Compose services do not invalidate it", async () => {
  const base = tree();
  const model = JSON.parse(await base.read("compose.yaml"));
  model.services.metadata.environment = { FEATURE: "enabled" };
  const changed = tree({ "compose.yaml": JSON.stringify(model) });
  assert.equal(
    await composeInputFingerprint(base, "web-demo"),
    await composeInputFingerprint(changed, "web-demo"),
  );
  assert.notEqual(
    await composeInputFingerprint(base, "metadata"),
    await composeInputFingerprint(changed, "metadata"),
  );
  assert.equal(
    runtimeFingerprint({
      image: "old",
      build: {},
      environment: { SECRET: "literal$$" },
    }),
    runtimeFingerprint({ image: "new", environment: { SECRET: "literal$$" } }),
  );
});
test("build target and rendered build arguments rebuild only the component, excluding revision labels", async () => {
  const beforeTree = tree();
  const afterTree = tree({
    "compose.public-site.yaml": JSON.stringify({
      services: {
        "web-demo": {
          build: {
            target: "public-site",
            args: { VITE_PUBLIC_FEATURE: "true" },
          },
        },
      },
    }),
  });
  const previous = await state(beforeTree),
    current = await state(afterTree);
  assert.deepEqual(
    deploymentPlan({ revision: newRevision, previous, current, migrations: [] })
      .buildServices,
    ["web-demo"],
  );
  const build = {
    context: ".",
    target: "public-site",
    args: {
      CPREDICT_IMAGE_REVISION: oldRevision,
      VITE_PUBLIC_FEATURE: "false",
    },
  };
  const fingerprint = buildConfigurationFingerprint({ build });
  const newLabel = {
    ...build,
    args: { ...build.args, CPREDICT_IMAGE_REVISION: newRevision },
  };
  assert.equal(buildConfigurationFingerprint({ build: newLabel }), fingerprint);
  const old = await state(beforeTree),
    candidate = structuredClone(old);
  old["web-demo"].buildConfigFingerprint = fingerprint;
  candidate["web-demo"].buildConfigFingerprint = buildConfigurationFingerprint({
    build: {
      ...newLabel,
      args: { ...newLabel.args, VITE_PUBLIC_FEATURE: "true" },
    },
  });
  assert.deepEqual(
    deploymentPlan({
      revision: newRevision,
      previous: old,
      current: candidate,
      migrations: [],
    }).buildServices,
    ["web-demo"],
  );
});
test("config-only publication retains the image and frontend release", async () => {
  const previous = await state(tree()),
    current = structuredClone(previous);
  current["web-demo"].configFingerprint = "changed";
  const plan = deploymentPlan({
    revision: newRevision,
    previous,
    current,
    migrations: [],
  });
  assert.deepEqual(plan.updateServices, ["web-demo"]);
  assert.deepEqual(plan.buildServices, []);
  assert.equal(plan.publishAssets, false);
});
test("only pending SQL selects affected database writers; modified or removed applied SQL is rejected", async () => {
  const source = tree({
    "offchain/indexer/migrations/001_initial.sql":
      "CREATE TABLE initial(id int);",
    "offchain/app-service/migrations/002_next.sql":
      "CREATE TABLE next(id int);",
    "offchain/metadata-service/migrations/001_initial.sql":
      "CREATE TABLE metadata(id int);",
  });
  const files = await migrationInputs(source);
  const applied = {
    indexer: [{ path: files[0].path, digest: files[0].digest }],
    metadata: files.filter((f) => f.kind === "metadata"),
  };
  const pending = pendingMigrations(files, applied);
  assert.deepEqual(
    pending.map((m) => m.kind),
    ["app"],
  );
  const plan = await planFor({}, pending);
  assert.deepEqual(plan.backupDatabases, ["indexer"]);
  assert.deepEqual(plan.stopWriters, ["indexer", "app-service"]);
  assert.deepEqual(plan.migrationServices, ["migrate-app"]);
  assert.equal(plan.components.indexer.action, "restart-for-migration");
  assert.deepEqual(plan.retainServices, ["metadata", "web-demo"]);
  assert.throws(
    () => pendingMigrations(files.slice(1), applied),
    /removed or modified/,
  );
  applied.indexer[0].digest = "wrong";
  assert.throws(() => pendingMigrations(files, applied), /removed or modified/);
});

function containers() {
  return [...SERVICES, "postgres", "public-site-preview"].map(
    (service, index) => ({
      Id: index.toString(16).repeat(64),
      Image: `sha256:${service}`,
      Config: { Labels: { "com.docker.compose.service": service } },
      State: {
        Running: true,
        StartedAt: "before",
        Health: { Status: "healthy" },
      },
    }),
  );
}
async function recordActions(plan, failAt) {
  const calls = [],
    journal = {};
  const record = async (kind, args) => {
    calls.push([kind, args]);
    if (kind === failAt) throw new Error("injected failure");
  };
  let error;
  try {
    await applySelectedServices({
      plan,
      journal,
      containers: containers(),
      candidateFile: "/fixture/candidate.json",
      composeFile: async (_file, args) => record("compose", args),
      docker: async (args) => record("docker", args),
      save: async (status) => record("save", status),
      backup: async (names) => record("backup", names),
    });
  } catch (failure) {
    error = failure;
  }
  return { calls, journal, error };
}
test("frontend execution never stops writers, backs up, migrates or starts dependencies", async () => {
  const plan = await planFor({
    "examples/user-site/src/lazy.ts": "export const value = 2;",
  });
  const { calls, journal, error } = await recordActions(plan);
  assert.equal(error, undefined);
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["save", "compose"],
  );
  const args = calls[1][1];
  assert.ok(args.includes("--no-deps"));
  assert.deepEqual(
    args.filter((arg) => SERVICES.includes(arg)),
    ["web-demo"],
  );
  assert.deepEqual(touchedServices(journal), ["web-demo"]);
});
test("migration execution backs up after pausing only its writers and records them before failure", async () => {
  const files = await migrationInputs(
    tree({ "offchain/app-service/migrations/001_initial.sql": "SELECT 1;" }),
  );
  const plan = await planFor({}, files);
  const { calls, journal, error } = await recordActions(plan, "backup");
  assert.match(error.message, /injected/);
  assert.deepEqual(touchedServices(journal), ["indexer", "app-service"]);
  assert.equal(calls[1][0], "docker");
  assert.deepEqual(calls[1][1], ["stop", "0".repeat(64), "2".repeat(64)]);
  assert.deepEqual(calls[2], ["backup", ["indexer"]]);
  assert.ok(!calls.some(([kind]) => kind === "compose"));
});
test("successful migration resumes only affected writers using the selected candidate record", async () => {
  const files = await migrationInputs(
    tree({
      "offchain/metadata-service/migrations/001_initial.sql": "SELECT 1;",
    }),
  );
  const { calls, journal, error } = await recordActions(
    await planFor({}, files),
  );
  assert.equal(error, undefined);
  assert.equal(journal.databaseTouched, true);
  assert.deepEqual(
    calls.filter(([kind]) => kind === "backup"),
    [["backup", ["metadata"]]],
  );
  const commands = calls
    .filter(([kind]) => kind === "compose")
    .map(([, args]) => args);
  assert.equal(commands[0].at(-1), "migrate-metadata");
  assert.equal(commands[1].at(-1), "metadata");
  assert.deepEqual(touchedServices(journal), ["metadata"]);
});
test("rollback only restores recorded touched services; legacy journals remain supported", async () => {
  const commands = [];
  const compose = async (file, args) => commands.push({ file, args });
  await restoreSelectedServices(
    {
      version: 2,
      rollbackFile: "old.json",
      servicesTouched: true,
      touchedServices: ["web-demo"],
    },
    compose,
  );
  assert.deepEqual(
    commands[0].args.filter((arg) => SERVICES.includes(arg)),
    ["web-demo"],
  );
  await restoreSelectedServices(
    { version: 1, rollbackFile: "legacy.json", servicesTouched: true },
    compose,
  );
  assert.deepEqual(
    commands[1].args.filter((arg) => SERVICES.includes(arg)),
    SERVICES,
  );
  await assert.rejects(
    restoreSelectedServices({ version: 2, servicesTouched: true }, compose),
    /missing touched/,
  );
  assert.equal(commands.length, 2);
});
test("chain source changes are reported separately; ABI, history and unreviewed SQL require maintenance", async () => {
  const before = tree(),
    after = tree({ "src/Market.sol": "contract Market {}" });
  const previous = await state(before),
    current = await state(after);
  const policy = {
    version: 1,
    compatibleMigrations: {},
    projectionInputs: ["offchain/indexer/src/main.ts"],
  };
  let result = maintenanceActions({
    tree: after,
    previousTree: before,
    previous,
    current,
    pending: [],
    policy,
  });
  assert.equal(result.notices.length, 1);
  assert.deepEqual(result.blockers, []);
  current.indexer.inputs["offchain/indexer/src/main.ts"] = "changed";
  current["web-demo"].inputs["generated/abi.ts"] = "changed";
  result = maintenanceActions({
    tree: after,
    previousTree: before,
    previous,
    current,
    pending: [{ path: "new.sql", digest: "unknown" }],
    policy,
  });
  assert.equal(result.blockers.length, 3);
});
test("no-op has no mutation calls; retained container replacement or restart fails verification", async () => {
  assert.deepEqual((await recordActions(await planFor({}))).calls, []);
  const before = containers(),
    after = structuredClone(before);
  after.find(
    (c) => c.Config.Labels["com.docker.compose.service"] === "web-demo",
  ).Id = "e".repeat(64);
  assert.doesNotThrow(() => verifyRetained(before, after, ["web-demo"]));
  after[0].State.StartedAt = "restarted";
  assert.throws(
    () => verifyRetained(before, after, ["web-demo"]),
    /Untouched indexer/,
  );
  assert.deepEqual(
    touchedServices({ version: 1, servicesTouched: true }),
    SERVICES,
  );
  assert.deepEqual(
    touchedServices({
      version: 2,
      servicesTouched: true,
      touchedServices: ["metadata"],
    }),
    ["metadata"],
  );
});
test("bind snapshots restore the previous bytes after a desired config is edited", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "cpredict-selective-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = resolve(root, "runtime.json");
  await writeFile(path, '{"feature":false}');
  const original = {
    volumes: [
      {
        type: "bind",
        source: path,
        target: "/run/config.json",
        read_only: true,
      },
    ],
  };
  const old = await pinMountInputs(original, resolve(root, "old"));
  const oldDigest = await mountInputs(old);
  const components = {
    "web-demo": { mounts: pinnedMounts(old), mountDigests: oldDigest },
  };
  await writeFile(path, '{"feature":true}');
  await verifyPinnedInputs(components);
  const candidate = await pinMountInputs(original, resolve(root, "new"));
  assert.notDeepEqual(await mountInputs(candidate), oldDigest);
  const rollback = restorePinnedMounts(original, pinnedMounts(old));
  assert.deepEqual(await mountInputs(rollback), oldDigest);
  assert.equal(
    await readFile(rollback.volumes[0].source, "utf8"),
    '{"feature":false}',
  );
  assert.equal(await readFile(path, "utf8"), '{"feature":true}');
  await assert.rejects(
    verifyPinnedInputs({ "web-demo": { mounts: pinnedMounts(old) } }),
    /Incomplete configuration snapshot/,
  );
  await writeFile(rollback.volumes[0].source, '{"feature":"tampered"}');
  await assert.rejects(
    verifyPinnedInputs(components),
    /Saved configuration snapshot changed/,
  );
  await mkdir(resolve(root, "dir"));
  await writeFile(resolve(root, "dir/item"), "content");
  assert.equal(
    await inputDigest(resolve(root, "dir")),
    await inputDigest(resolve(root, "dir")),
  );
});
test("public handoff files remain live without changing deployment scope or rollback inputs", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "cpredict-live-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = resolve(root, "handoff");
  await mkdir(source);
  const service = {
    volumes: [
      {
        type: "bind",
        source,
        target: "/usr/share/nginx/html/_static-handoff",
        read_only: true,
      },
    ],
  };
  const before = runtimeFingerprint(service, await mountInputs(service));
  const candidate = await pinMountInputs(service, resolve(root, "pinned"));
  await writeFile(resolve(source, "progress.json"), '{"status":"verified"}');
  assert.equal(runtimeFingerprint(service, await mountInputs(service)), before);
  assert.deepEqual(pinnedMounts(candidate), {});
  assert.equal(candidate.volumes[0].source, source);
  await verifyPinnedInputs({ "web-demo": { mounts: {}, mountDigests: {} } });
  assert.equal(
    await readFile(
      resolve(candidate.volumes[0].source, "progress.json"),
      "utf8",
    ),
    '{"status":"verified"}',
  );
  await assert.rejects(
    mountInputs({ volumes: [{ ...service.volumes[0], read_only: false }] }),
    /Writable application/,
  );
});
test("migration execution mounts only reviewed Git SQL and the planned database", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "cpredict-pinned-sql-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = resolve(root, "local");
  await mkdir(local);
  await writeFile(
    resolve(local, "999_unreviewed.sql"),
    "SELECT 'not reviewed';",
  );
  const sqlPath = "offchain/indexer/migrations/001_indexer.sql";
  const sql = "CREATE TABLE reviewed(id integer);";
  const source = tree({
    [sqlPath]: sql,
    "deploy/compose/postgres/run-migrations.sh":
      "#!/bin/bash\n# reviewed runner\n",
  });
  const model = {
    entrypoint: ["bash", "/usr/local/bin/run-cpredict-migrations", "indexer"],
    environment: {
      PGHOST: "postgres",
      PGUSER: "cpredict_migrator",
      PGDATABASE: "cpredict_indexer",
    },
    volumes: [
      { type: "bind", source: local, target: "/migrations", read_only: true },
      {
        type: "bind",
        source: "/local/runner",
        target: "/usr/local/bin/run-cpredict-migrations",
        read_only: true,
      },
    ],
  };
  const migrations = await migrationInputs(source);
  const pinned = await pinMigrationInputs(
    model,
    "indexer",
    source,
    migrations,
    resolve(root, "pinned"),
  );
  const files = await readdir(pinned.volumes[0].source);
  assert.deepEqual(files, ["001_indexer.sql"]);
  assert.equal(
    await readFile(resolve(pinned.volumes[0].source, files[0]), "utf8"),
    sql,
  );
  assert.equal(
    await readFile(pinned.volumes[1].source, "utf8"),
    await source.read("deploy/compose/postgres/run-migrations.sh"),
  );
  await assert.rejects(
    pinMigrationInputs(
      {
        ...model,
        environment: { ...model.environment, PGDATABASE: "cpredict_metadata" },
      },
      "indexer",
      source,
      migrations,
      resolve(root, "wrong-db"),
    ),
    /planned database/,
  );
  await assert.rejects(
    pinMigrationInputs(
      { ...model, command: ["/another/sql/directory"] },
      "indexer",
      source,
      migrations,
      resolve(root, "wrong-command"),
    ),
    /planned database/,
  );
  await assert.rejects(
    pinMigrationInputs(
      {
        ...model,
        volumes: [
          ...model.volumes,
          { type: "bind", source: local, target: "/extra", read_only: true },
        ],
      },
      "indexer",
      source,
      migrations,
      resolve(root, "wrong-mount"),
    ),
    /mount overrides/,
  );
});
test("migration registry inspection is read-only and does not put credentials in command arguments", async () => {
  const calls = [];
  const result = await readAppliedMigrations(
    async (args, options) => {
      calls.push(args);
      assert.equal(options.env.PGPASSWORD, "secret-test-fixture");
      assert.ok(!args.join(" ").includes("secret-test-fixture"));
      assert.ok(!/CREATE|INSERT|UPDATE|DELETE/.test(args.at(-1)));
      return "f\n";
    },
    { Id: "a".repeat(64) },
    "secret-test-fixture",
  );
  assert.deepEqual(result, { indexer: [], paymaster: [], metadata: [] });
  assert.equal(calls.length, 3);
});
