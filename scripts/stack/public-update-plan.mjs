import { posix } from "node:path";
import { SERVICES, ensure, run, sha256 } from "./public-update-core.mjs";

export const MIGRATION_GROUPS = [
  {
    kind: "indexer",
    directory: "offchain/indexer/migrations",
    database: "indexer",
    writers: ["indexer", "app-service"],
  },
  {
    kind: "paymaster",
    directory: "offchain/paymaster-service/migrations",
    database: "paymaster",
    writers: [],
  },
  {
    kind: "metadata",
    directory: "offchain/metadata-service/migrations",
    database: "metadata",
    writers: ["metadata"],
  },
  {
    kind: "app",
    directory: "offchain/app-service/migrations",
    database: "indexer",
    writers: ["indexer", "app-service"],
  },
];
const ROOTS = {
  indexer: "offchain/indexer/src/",
  metadata: "offchain/metadata-service/src/",
  "app-service": "offchain/app-service/src/",
  "web-demo": "examples/user-site/",
};
const auxiliary = new Set(["test", "tests", "__tests__", "fixtures"]);
const runtimeFile = (path) =>
  !path.split("/").some((part) => auxiliary.has(part)) &&
  !/\.(test|spec)\.[^.]+$/.test(path) &&
  !/\.(md|map)$/.test(path);
export const stable = (value) => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sort(value[key])]),
    );
  return value;
}

/** Read committed input objects without checking out or modifying another revision. */
export async function gitInputs(root, revision, command = run) {
  ensure(/^[0-9a-f]{40}$/.test(revision), "Invalid component source revision");
  const rows = await command("git", ["ls-tree", "-r", "-z", revision], {
    cwd: root,
  });
  const files = new Map(
    rows
      .split("\0")
      .filter(Boolean)
      .map((row) => {
        const [header, path] = row.split("\t"),
          [mode, type, oid] = header.split(" ");
        return [path, { mode, type, oid }];
      }),
  );
  const cache = new Map();
  return {
    revision,
    files,
    async read(path) {
      ensure(
        files.get(path)?.type === "blob" && files.get(path).mode !== "120000",
        `Missing or unsupported build input: ${path}`,
      );
      if (!cache.has(path))
        cache.set(
          path,
          command("git", ["show", `${revision}:${path}`], { cwd: root }),
        );
      return cache.get(path);
    },
  };
}

let parse;
async function references(path, content) {
  if (!parse) {
    try {
      ({ parse } = await import("@babel/parser"));
    } catch {
      throw new Error(
        "Deployment parser unavailable; run npm ci --ignore-scripts before plan",
      );
    }
  }
  const source = parse(content, {
    sourceType: "unambiguous",
    plugins: ["typescript", ...(/\.[jt]sx$/.test(path) ? ["jsx"] : [])],
    createImportExpressions: true,
  });
  const result = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "ImportExpression")
      ensure(
        node.source?.type === "StringLiteral",
        `Non-literal import needs an explicit deployment input rule: ${path}`,
      );
    if (
      [
        "ImportDeclaration",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
        "ImportExpression",
      ].includes(node.type) &&
      node.source?.type === "StringLiteral"
    )
      result.push(node.source.value);
    if (node.type === "TSImportType" && node.argument?.type === "StringLiteral")
      result.push(node.argument.value);
    if (
      node.type === "CallExpression" &&
      node.callee?.name === "require" &&
      node.arguments[0]?.type === "StringLiteral"
    )
      result.push(node.arguments[0].value);
    for (const [key, value] of Object.entries(node))
      if (!["loc", "comments", "tokens"].includes(key)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
  };
  visit(source);
  return result;
}

function resolveInput(files, from, specifier) {
  if (!specifier.startsWith(".")) {
    ensure(
      !specifier.startsWith("@/") && !specifier.startsWith("~/"),
      "Unmapped source alias requires a deployment input rule",
    );
    return null;
  }
  const path = posix.normalize(
    posix.join(posix.dirname(from), specifier.split("?")[0]),
  );
  const candidates = [
    path,
    path.replace(/\.js$/, ".ts"),
    path.replace(/\.js$/, ".tsx"),
    `${path}.ts`,
    `${path}.tsx`,
    `${path}/index.ts`,
    `${path}/index.tsx`,
  ];
  const found = candidates.find((p) => files.has(p));
  ensure(found, `Unresolved deployment input: ${from} -> ${specifier}`);
  return found;
}

function dockerStages(text, target) {
  const stages = new Map();
  let current;
  for (const line of text.split("\n")) {
    const start = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (start) {
      current = { base: start[1], lines: [], dependencies: [] };
      stages.set(start[2] ?? start[1], current);
    }
    if (!current) continue;
    // Revision labels describe provenance, not a reason to rebuild siblings.
    if (!line.includes("CPREDICT_IMAGE_REVISION") && !line.startsWith("#"))
      current.lines.push(line);
    const from = /--from=([^\s]+)/.exec(line);
    if (from) current.dependencies.push(from[1]);
  }
  const selected = new Map();
  function add(name) {
    if (selected.has(name) || !stages.has(name)) return;
    const stage = stages.get(name);
    selected.set(name, stage.lines);
    add(stage.base);
    for (const dependency of stage.dependencies) add(dependency);
  }
  ensure(stages.has(target), `Missing Docker target: ${target}`);
  add(target);
  return Object.fromEntries(selected);
}

/** Fingerprint the component's runtime graph and its build tooling, not the whole Git SHA. */
export async function componentInputs(tree, service) {
  ensure(SERVICES.includes(service), "Unknown deployment component");
  const selected = new Set(
    [...tree.files.keys()].filter(
      (p) => p.startsWith(ROOTS[service]) && runtimeFile(p),
    ),
  );
  const external = new Set();
  ensure(selected.size, `No source inputs for ${service}`);
  for (const path of selected) {
    if (/\.(ts|tsx|js|mjs)$/.test(path))
      for (const specifier of await references(path, await tree.read(path))) {
        const dependency = resolveInput(tree.files, path, specifier);
        if (dependency) selected.add(dependency);
        else
          external.add(
            specifier.startsWith("@")
              ? specifier.split("/").slice(0, 2).join("/")
              : specifier.split("/")[0],
          );
      }
  }
  const frontend = service === "web-demo";
  for (const path of tree.files.keys())
    if (
      path === "tsconfig.json" ||
      path === ".dockerignore" ||
      path.startsWith("patches/") ||
      path === "manifests/sdk-declaration-patches.json" ||
      path === "scripts/public-site/apply-declaration-patches.mjs" ||
      (frontend &&
        (path.startsWith("manifests/npm-license") ||
          path === "scripts/public-site/package-notices.mjs" ||
          path === "scripts/sbom/npm-license-evidence.mjs" ||
          path === "deployments/arbitrum-sepolia/final-manifest.schema.json"))
    )
      selected.add(path);
  const inputs = Object.fromEntries(
    [...selected].sort().map((p) => [p, tree.files.get(p).oid]),
  );
  const pkg = JSON.parse(await tree.read("package.json"));
  const devDependencies = Object.fromEntries(
    Object.entries(pkg.devDependencies ?? {}).filter(
      ([name]) =>
        external.has(name) ||
        name.startsWith("@types/") ||
        [
          "typescript",
          "patch-package",
          ...(frontend ? ["vite", "@vitejs/plugin-react"] : []),
        ].includes(name),
    ),
  );
  inputs["package-lock.json#component"] = dependencyFingerprint(
    JSON.parse(await tree.read("package-lock.json")),
    Object.keys({ ...pkg.dependencies, ...devDependencies }),
  );
  // Deployment/test script additions must not rebuild every application image.
  inputs["package.json#build"] = sha256(
    stable({
      name: pkg.name,
      version: pkg.version,
      type: pkg.type,
      dependencies: pkg.dependencies,
      devDependencies,
      overrides: pkg.overrides,
      engines: pkg.engines,
      scripts: Object.fromEntries(
        (frontend
          ? [
              "site:build",
              "presite:build",
              "postsite:build",
              "site:check",
              "site:patches",
            ]
          : [
              "build:offchain",
              "prebuild:offchain",
              "postbuild:offchain",
              "site:patches",
            ]
        ).map((key) => [key, pkg.scripts?.[key]]),
      ),
    }),
  );
  const buildDefinition = {};
  for (const path of ["compose.yaml", "compose.public-site.yaml"])
    if (tree.files.has(path)) {
      const serviceModel = JSON.parse(await tree.read(path)).services?.[
        service
      ];
      ensure(
        !serviceModel?.build || typeof serviceModel.build === "object",
        "Component builds require the existing explicit Docker profile",
      );
      Object.assign(buildDefinition, serviceModel?.build);
      inputs[`${path}#build`] = buildConfigurationFingerprint(
        serviceModel ?? {},
      );
    }
  ensure(
    !buildDefinition.context || buildDefinition.context === ".",
    "Alternate Docker build contexts require an explicit deployment input rule",
  );
  const dockerfile =
    buildDefinition.dockerfile ??
    `deploy/compose/Dockerfile.${frontend ? "demo" : "offchain"}`;
  // Older gateways use the same demo stage, before the public-site alias existed.
  const docker = await tree.read(dockerfile);
  inputs[`${dockerfile}#${service}`] = sha256(
    stable(
      dockerStages(
        docker,
        buildDefinition.target ??
          (frontend
            ? /AS public-site\b/.test(docker)
              ? "public-site"
              : "demo"
            : service),
      ),
    ),
  );
  if (frontend)
    inputs["deploy/compose/nginx/public-site.conf.template"] =
      tree.files.get("deploy/compose/nginx/public-site.conf.template")?.oid ??
      "missing";
  return { fingerprint: sha256(stable(inputs)), inputs };
}

export function dependencyFingerprint(lock, roots) {
  ensure(lock.packages, "A package-lock with package records is required");
  const selected = {};
  function find(from, name) {
    for (
      let parent = from;
      ;
      parent = parent.includes("/node_modules/")
        ? parent.slice(0, parent.lastIndexOf("/node_modules/"))
        : ""
    ) {
      const path = `${parent ? `${parent}/` : ""}node_modules/${name}`;
      if (lock.packages[path]) return path;
      if (!parent) return null;
    }
  }
  function add(path) {
    if (!path || selected[path]) return;
    const record = lock.packages[path];
    selected[path] = record;
    for (const name of Object.keys({
      ...record.dependencies,
      ...record.optionalDependencies,
      ...record.peerDependencies,
    }))
      add(find(path, name));
  }
  for (const name of roots) {
    const path = find("", name);
    ensure(path, `Dependency missing from lockfile: ${name}`);
    add(path);
  }
  return sha256(stable(selected));
}

export async function composeInputFingerprint(tree, service) {
  const inputs = {};
  for (const path of ["compose.yaml", "compose.public-site.yaml"])
    if (tree.files.has(path)) {
      const model = JSON.parse(await tree.read(path));
      inputs[path] = {
        service: model.services?.[service],
        networks: model.networks,
        volumes: model.volumes,
      };
    }
  return sha256(stable(inputs));
}

export function runtimeFingerprint(service, mounts = {}) {
  const model = structuredClone(service);
  delete model.image;
  delete model.build;
  delete model.depends_on;
  if (model.labels) delete model.labels["org.opencontainers.image.revision"];
  return sha256(stable({ model, mounts }));
}

export function buildConfigurationFingerprint(service) {
  const build = structuredClone(service.build);
  if (build?.args) delete build.args.CPREDICT_IMAGE_REVISION;
  return sha256(stable({ build, platform: service.platform }));
}

export async function migrationInputs(tree) {
  const migrations = [];
  for (const group of MIGRATION_GROUPS)
    for (const path of [...tree.files.keys()].sort()) {
      if (!path.startsWith(`${group.directory}/`) || !path.endsWith(".sql"))
        continue;
      ensure(
        /^\d{3}_[a-z0-9_]+\.sql$/.test(posix.basename(path)),
        "Invalid migration filename",
      );
      migrations.push({
        ...group,
        path,
        digest: sha256(await tree.read(path)),
      });
    }
  return migrations;
}

export function pendingMigrations(migrations, applied) {
  for (const [database, rows] of Object.entries(applied))
    for (const row of rows) {
      const file = migrations.find(
        (m) => m.database === database && m.path === row.path,
      );
      ensure(
        file && file.digest === row.digest,
        "An applied migration was removed or modified; use a new migration",
      );
    }
  return migrations.filter(
    (m) => !(applied[m.database] ?? []).some((r) => r.path === m.path),
  );
}

export function maintenanceActions({
  tree,
  previousTree,
  previous,
  current,
  pending,
  policy,
}) {
  ensure(
    policy?.version === 1 &&
      Array.isArray(policy.projectionInputs) &&
      policy.compatibleMigrations,
    "Invalid checked-in deployment maintenance policy",
  );
  const notices = [],
    blockers = [];
  for (const migration of pending)
    if (policy.compatibleMigrations[migration.path] !== migration.digest)
      blockers.push(
        `Migration needs a reviewed backward-compatible policy: ${migration.path}`,
      );
  const chainChanged = [
    ...new Set([...tree.files.keys(), ...previousTree.files.keys()]),
  ].some(
    (p) =>
      (p.startsWith("src/") ||
        p.startsWith("script/") ||
        p === "foundry.toml") &&
      tree.files.get(p)?.oid !== previousTree.files.get(p)?.oid,
  );
  if (chainChanged) {
    notices.push(
      "Contract sources changed: ordinary deployment never broadcasts or replaces existing contracts; chain release is separate.",
    );
    if (
      SERVICES.some((service) =>
        Object.keys(current[service].inputs).some(
          (path) =>
            path.startsWith("generated/") &&
            current[service].inputs[path] !== previous[service].inputs[path],
        ),
      )
    )
      blockers.push(
        "Contract and consumed ABI changes need an explicit deployment compatibility check before service publication",
      );
  }
  for (const path of policy.projectionInputs)
    if (previous.indexer.inputs[path] !== current.indexer.inputs[path])
      blockers.push(
        `Historical projection input changed; prepare scoped replay and reconciliation before publishing: ${path}`,
      );
  return { notices, blockers };
}

export function deploymentPlan({
  revision,
  previous,
  current,
  migrations,
  notices = [],
  blockers = [],
}) {
  const components = Object.fromEntries(
    SERVICES.map((service) => {
      ensure(
        previous[service]?.image && current[service],
        `Missing deployed baseline for ${service}`,
      );
      const reasons = [];
      if (
        previous[service].fingerprint !== current[service].fingerprint ||
        previous[service].buildConfigFingerprint !==
          current[service].buildConfigFingerprint
      )
        reasons.push("source-or-build-inputs");
      if (
        previous[service].configFingerprint !==
        current[service].configFingerprint
      )
        reasons.push("runtime-configuration");
      return [
        service,
        {
          action: reasons.length ? "update" : "retain",
          build: reasons.includes("source-or-build-inputs"),
          reasons,
          deployedRevision: previous[service].sourceCommit,
        },
      ];
    }),
  );
  const updateServices = SERVICES.filter(
    (s) => components[s].action === "update",
  );
  const stopWriters = [...new Set(migrations.flatMap((m) => m.writers))];
  for (const service of stopWriters)
    if (!updateServices.includes(service))
      components[service].action = "restart-for-migration";
  const migrationServices = [
    ...new Set(migrations.map((m) => `migrate-${m.kind}`)),
  ];
  return {
    version: 2,
    revision,
    components,
    updateServices,
    buildServices: updateServices.filter((s) => components[s].build),
    retainServices: SERVICES.filter(
      (s) => !updateServices.includes(s) && !stopWriters.includes(s),
    ),
    stopWriters,
    backupDatabases: [...new Set(migrations.map((m) => m.database))],
    migrationServices,
    migrations: migrations.map((m) => m.path),
    publishAssets: components["web-demo"].build,
    refreshProxies:
      updateServices.some((s) =>
        ["indexer", "metadata", "web-demo"].includes(s),
      ) || stopWriters.length > 0,
    notices,
    blockers,
    noop: !updateServices.length && !migrations.length,
  };
}

export function touchedServices(journal) {
  const selected =
    journal.touchedServices ??
    (journal.version === 2 ? [] : journal.servicesTouched ? SERVICES : []);
  ensure(
    Array.isArray(selected) &&
      selected.every((s) => SERVICES.includes(s)) &&
      new Set(selected).size === selected.length &&
      !(journal.version === 2 && journal.servicesTouched && !selected.length),
    "Invalid or missing touched component record",
  );
  return selected;
}

export function verifyRetained(before, after, touched) {
  for (const old of before.filter((c) => c.State.Running)) {
    const service = old.Config.Labels?.["com.docker.compose.service"];
    if (touched.includes(service)) continue;
    const live = after.find((c) => c.Id === old.Id);
    ensure(
      live?.State.Running &&
        live.Image === old.Image &&
        live.State.StartedAt === old.State.StartedAt,
      `Untouched ${service} was replaced or restarted`,
    );
  }
}
