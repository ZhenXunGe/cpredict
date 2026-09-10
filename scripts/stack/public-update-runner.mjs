import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadStackConfiguration } from "./config.mjs";
import { loadPublicSiteStack } from "./public-site-config.mjs";
import { createStackBackup } from "./backup.mjs";
import { validateBackupFiles } from "./restore-drill.mjs";
import {
  componentInputs,
  buildConfigurationFingerprint,
  composeInputFingerprint,
  deploymentPlan,
  gitInputs,
  maintenanceActions,
  migrationInputs,
  pendingMigrations,
  runtimeFingerprint,
  stable,
  touchedServices,
  verifyRetained,
} from "./public-update-plan.mjs";
import {
  applySelectedServices,
  mountInputs,
  pinMigrationInputs,
  pinMountInputs,
  pinnedMounts,
  readAppliedMigrations,
  restorePinnedMounts,
  restoreSelectedServices,
  verifyPinnedInputs,
} from "./public-update-runtime.mjs";
import {
  SERVICES,
  createManifest,
  ensure,
  escapeCompose,
  fetchBytes,
  privateJson,
  publisher,
  refreshProxyUpstreams,
  restrictedFile,
  rollbackCompose,
  run,
  sha256,
  validateUpdateConfig,
  verifyAssets,
  verifySite,
} from "./public-update-core.mjs";

export async function execute({ root, config, mode }) {
  config = validateUpdateConfig(config, root);
  const stateFile = resolve(config.stateDirectory, "current.json");
  const activeFile = resolve(config.stateDirectory, "active.json");
  const docker = (args, options = {}) =>
    run("docker", args, { cwd: root, ...options });
  const inspect = async () => {
    const ids = (
      await docker([
        "ps",
        "-aq",
        "--filter",
        "label=com.docker.compose.project=cpredict",
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    ensure(ids.length > 0, "The existing cpredict stack must be running");
    return JSON.parse(await docker(["inspect", ...ids]));
  };
  const composeFile = (file, args, options) =>
    docker(
      [
        "compose",
        "--project-directory",
        root,
        "-p",
        "cpredict",
        "-f",
        file,
        ...args,
      ],
      options,
    );
  const filesUnchanged = async (before) => {
    for (const [path, digest] of Object.entries(before))
      ensure(
        sha256(await readFile(path)) === digest,
        "Private runtime configuration changed during update",
      );
  };
  const databaseUnchanged = async (before) => {
    const pg = (await inspect()).find(
      (c) => c.Config.Labels?.["com.docker.compose.service"] === "postgres",
    );
    ensure(
      pg?.Id === before.id &&
        pg.Image === before.image &&
        pg.Mounts.find((m) => m.Destination === "/var/lib/postgresql/data")
          ?.Name === before.volume,
      "Existing PostgreSQL container or volume changed",
    );
  };
  let journal;
  const save = async (status) => {
    journal.status = status;
    journal.updatedAt = new Date().toISOString();
    await privateJson(resolve(journal.directory, "result.json"), journal);
    await privateJson(stateFile, journal);
  };
  const restore = async () => {
    if (journal.previousState)
      await verifyPinnedInputs(journal.previousState.components);
    else await filesUnchanged(journal.privateInputs);
    await save("rolling-back");
    const touched = await restoreSelectedServices(journal, composeFile);
    if (journal.plan?.refreshProxies ?? true)
      journal.rollbackProxyChecks = await refreshProxyUpstreams(
        await inspect(),
        docker,
      );
    await databaseUnchanged(journal.database);
    const routes = await verifySite(
      config.publicOrigin,
      journal.previous.htmlSha256,
      journal.previousState?.siteConfigSha256 ?? journal.siteConfigSha256,
    );
    await verifyAssets(config.publicOrigin, journal.previous.manifest);
    const cloud = await publisher(config, "status");
    if (cloud.release !== journal.previous.release) {
      ensure(
        cloud.release === journal.release,
        "Cloud release changed outside this update; manual reconciliation required",
      );
      await publisher(
        config,
        `activate ${journal.previous.release} ${cloud.release}`,
      );
    }
    journal.rollbackChecks = routes;
    if (journal.previousState) {
      const after = await inspect();
      verifyRetained(journal.beforeContainers, after, touched);
      await verifyComponents(journal.previousState.components, after);
      await privateJson(activeFile, journal.previousState);
    } else await rm(activeFile, { force: true });
    await save("rolled-back");
    console.log(
      "Previous service images and public page verified; database and operation records retained.",
    );
  };
  await restrictedFile(config.ssh.identityFile);
  await restrictedFile(config.ssh.knownHostsFile);
  if (["recover", "rollback"].includes(mode)) {
    journal = JSON.parse(await readFile(stateFile, "utf8"));
    ensure(
      [1, 2].includes(journal.version) && journal.rollbackFile,
      "No recoverable update record",
    );
    if (
      (mode === "recover" &&
        ["succeeded", "rolled-back"].includes(journal.status)) ||
      (mode === "rollback" && journal.status === "rolled-back")
    ) {
      const expected =
        journal.status === "succeeded" ? journal.candidate : journal.previous;
      const active = await publisher(config, "status");
      ensure(
        active.release === expected.release,
        "Completed update record differs from cloud state",
      );
      if (journal.version === 1) await filesUnchanged(journal.privateInputs);
      await databaseUnchanged(journal.database);
      await verifySite(
        config.publicOrigin,
        expected.htmlSha256,
        journal.status === "rolled-back"
          ? (journal.previousState?.siteConfigSha256 ??
              journal.siteConfigSha256)
          : journal.siteConfigSha256,
      );
      await verifyAssets(config.publicOrigin, expected.manifest);
      const state =
        journal.status === "succeeded"
          ? journal.candidateState
          : journal.previousState;
      if (state) {
        await verifyComponents(state.components, await inspect());
        await privateJson(activeFile, state);
      }
      console.log(
        "Completed update reconciled; stale lock released without another service switch.",
      );
      return;
    }
    if (!journal.servicesTouched) {
      await save("preparation-failed");
      console.log(
        journal.databaseTouched
          ? "Migration did not complete; compatible SQL changes were retained. The next plan rereads the registry; running services were untouched."
          : "Preparation was interrupted; running services were untouched.",
      );
      return;
    }
    ensure(
      journal.previous,
      "Previous public release is missing; inspect update evidence",
    );
    await restore();
    return;
  }
  console.log("Checking pinned SSH publishing identity…");
  let cloud = await publisher(config, "status");
  ensure(cloud.protocol === 1, "Cloud publishing protocol mismatch");
  if (mode === "check") {
    ensure(
      cloud.release,
      "Cloud publisher is installed but has no verified baseline",
    );
    const record =
      (await readRecord(activeFile)) ?? (await readRecord(stateFile));
    ensure(record, "No local deployment verification record");
    const siteHash =
      record.version === 2 && record.components
        ? record.siteConfigSha256
        : record.status === "rolled-back"
          ? record.previousState?.siteConfigSha256
          : record.siteConfigSha256;
    const site = await fetchBytes(config.localOrigin, "/site-config.json");
    await verifySite(
      config.publicOrigin,
      cloud.htmlSha256,
      siteHash ?? site.sha256,
    );
    if (record.components && record.frontend)
      await verifyComponents(record.components, await inspect());
    const release = [record.frontend, record.candidate, record.previous].find(
      (r) => r?.release === cloud.release,
    );
    ensure(
      release,
      "Active release has no local verification manifest; use recover",
    );
    await verifyAssets(config.publicOrigin, release.manifest);
    console.log(`Public deployment check passed: ${cloud.sourceCommit}`);
    return;
  }
  const sourceCommit = (
    await run("git", ["rev-parse", "HEAD"], { cwd: root })
  ).trim();
  const sourcesUnchanged = async () => {
    ensure(
      (await run("git", ["rev-parse", "HEAD"], { cwd: root })).trim() ===
        sourceCommit &&
        !(
          await run("git", ["status", "--porcelain", "--untracked-files=no"], {
            cwd: root,
          })
        ).trim(),
      "Committed deployment sources changed during this update",
    );
  };
  await sourcesUnchanged();
  // Kept in the newly loaded runner so a pre-v2 bootstrap can adopt this release.
  if (mode === "update") {
    const stamp = resolve(root, "node_modules/.cpredict-update-lock");
    const digest = sha256(await readFile(resolve(root, "package-lock.json")));
    let installed;
    try {
      installed = (await readFile(stamp, "utf8")).trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (installed !== digest) {
      console.log(
        "Installing locked deployment tools; application containers remain running…",
      );
      await run("npm", ["ci", "--ignore-scripts"], {
        cwd: root,
        timeout: 900000,
        label: "Deployment tool installation",
      });
      await writeFile(stamp, digest + "\n", { mode: 0o600 });
    }
  }
  const last = await readRecord(stateFile);
  const activeRecord = await readRecord(activeFile);
  const treeCache = new Map();
  const treeAt = async (revision) => {
    if (!treeCache.has(revision))
      treeCache.set(revision, gitInputs(root, revision));
    return treeCache.get(revision);
  };
  const tree = await treeAt(sourceCommit);
  const c = await loadStackConfiguration();
  // Resolve inputs for a read-only plan; full application schema validation runs before applying changes.
  const publicEnvironment = {};
  for (const key of [
    "CPREDICT_STACK_SITE_CONFIG_FILE",
    "CPREDICT_STACK_CTUSD_CONFIG_FILE",
    "CPREDICT_STACK_CTUSD_APP_ENV_FILE",
  ]) {
    ensure(c.secret[key], `Missing public-site input ${key}`);
    publicEnvironment[key] = await realpath(resolve(root, c.secret[key]));
  }
  Object.assign(c.environment, publicEnvironment, {
    CPREDICT_IMAGE_REVISION: sourceCommit,
  });
  const env = {
    ...process.env,
    ...c.environment,
  };
  const base = [
    "compose",
    "--project-directory",
    root,
    "-p",
    "cpredict",
    "--env-file",
    c.secretPath,
    "--env-file",
    c.publicPath,
    "-f",
    resolve(root, "compose.yaml"),
    "-f",
    resolve(root, "compose.public-site.yaml"),
  ];
  for (const path of config.composeOverrides) {
    const override = JSON.parse(
      await readFile(await restrictedFile(path), "utf8"),
    );
    ensure(
      Object.values(override.services ?? {}).every((s) => !s.image && !s.build),
      "Permanent override must not pin old image/build definitions",
    );
    base.push("-f", path);
  }
  // Compose config already escapes literal dollar signs for reuse as input.
  // Only raw Docker inspect snapshots need escapeCompose; escaping this model
  // again changes the environment seen by candidate containers.
  const desired = JSON.parse(
    await docker([...base, "config", "--format", "json"], {
      env,
      label: "Compose rendering",
    }),
  );
  const containers = await inspect();
  const running = containers.filter((c) => c.State.Running);
  ensure(
    running.every((c) =>
      [...SERVICES, "postgres", "public-site-preview"].includes(
        c.Config.Labels?.["com.docker.compose.service"],
      ),
    ),
    "Additional running writers require an explicit update profile",
  );
  let previousCompose = rollbackCompose(containers);
  const pg = containers.find(
    (c) => c.Config.Labels?.["com.docker.compose.service"] === "postgres",
  );
  ensure(
    pg?.State.Health?.Status === "healthy",
    "Existing PostgreSQL is not healthy",
  );
  const pgCandidate = JSON.parse(
    await docker(["image", "inspect", desired.services.postgres.image]),
  )[0];
  ensure(
    pgCandidate.Id === pg.Image,
    "PostgreSQL image change requires a separate database upgrade; services untouched",
  );
  const postgresConfiguration = runtimeFingerprint(desired.services.postgres);
  if (activeRecord?.postgresConfiguration)
    ensure(
      activeRecord.postgresConfiguration === postgresConfiguration,
      "PostgreSQL runtime configuration changed; use a separate database update",
    );
  // Password/provisioning changes cannot be applied by restarting application containers.
  const pgEnvironment = Object.fromEntries(
    pg.Config.Env.map((v) => [
      v.slice(0, v.indexOf("=")),
      v.slice(v.indexOf("=") + 1),
    ]),
  );
  ensure(
    Object.entries(desired.services.postgres.environment).every(
      ([key, value]) =>
        pgEnvironment[key] === String(value).replaceAll("$$", "$"),
    ),
    "PostgreSQL provisioning or credentials changed; use a separate database update",
  );
  const inputs = [
    c.secretPath,
    c.publicPath,
    ...config.composeOverrides,
    c.secret.CPREDICT_STACK_SITE_CONFIG_FILE,
    ...Object.values(publicEnvironment),
  ].map((p) => resolve(root, p));
  const privateInputs = Object.fromEntries(
    await Promise.all(inputs.map(async (p) => [p, sha256(await readFile(p))])),
  );
  if (!activeRecord && last?.privateInputs)
    await filesUnchanged(last.privateInputs);
  const siteConfig = await fetchBytes(config.localOrigin, "/site-config.json");
  const desiredSiteConfigSha256 = sha256(
    await readFile(resolve(root, c.secret.CPREDICT_STACK_SITE_CONFIG_FILE)),
  );
  ensure(
    siteConfig.status === 200 &&
      [activeRecord?.siteConfigSha256, desiredSiteConfigSha256].includes(
        siteConfig.sha256,
      ),
    "Running/public configuration does not match private inputs",
  );
  const localHtml = await fetchBytes(config.localOrigin, "/");
  const current = {},
    previous = {};
  if (activeRecord) {
    await verifyComponents(activeRecord.components, containers);
    await databaseUnchanged(activeRecord.database);
    ensure(
      activeRecord.frontend.release === cloud.release,
      "Cloud state changed outside the recorded deployment",
    );
  }
  for (const service of SERVICES) {
    const container = containers.find(
      (item) => item.Config.Labels?.["com.docker.compose.service"] === service,
    );
    const deployedRevision =
      container.Config.Labels?.["org.opencontainers.image.revision"];
    ensure(
      /^[0-9a-f]{40}$/.test(deployedRevision ?? ""),
      `Missing source provenance for ${service}`,
    );
    const oldTree = await treeAt(deployedRevision);
    const source = await componentInputs(tree, service);
    const configHash = runtimeFingerprint(
      desired.services[service],
      await mountInputs(desired.services[service]),
    );
    const configSource = await composeInputFingerprint(tree, service);
    current[service] = {
      ...source,
      sourceCommit,
      buildConfigFingerprint: buildConfigurationFingerprint(
        desired.services[service],
      ),
      configFingerprint: sha256(stable([configSource, configHash])),
    };
    previous[service] = activeRecord?.components[service] ?? {
      ...(await componentInputs(oldTree, service)),
      sourceCommit: deployedRevision,
      image: container.Image,
      buildConfigFingerprint: current[service].buildConfigFingerprint,
      configFingerprint: sha256(
        stable([await composeInputFingerprint(oldTree, service), configHash]),
      ),
    };
    // A config file may have been edited in place since the last release; rollback uses its saved bytes.
    previousCompose.services[service] = restorePinnedMounts(
      previousCompose.services[service],
      previous[service].mounts,
    );
  }
  const migrationFiles = await migrationInputs(tree);
  const applied = await readAppliedMigrations(
    docker,
    pg,
    c.secret.CPREDICT_STACK_MIGRATOR_PASSWORD,
  );
  const pending = pendingMigrations(migrationFiles, applied);
  const policy = JSON.parse(
    await tree.read("deploy/public-site/update-policy.json"),
  );
  const oldGatewayTree = await treeAt(previous["web-demo"].sourceCommit);
  const { notices, blockers } = maintenanceActions({
    tree,
    previousTree: oldGatewayTree,
    previous,
    current,
    pending,
    policy,
  });
  const plan = deploymentPlan({
    revision: sourceCommit,
    previous,
    current,
    migrations: pending,
    notices,
    blockers,
  });
  console.log(`UPDATE PLAN\n${JSON.stringify(plan, null, 2)}`);
  if (mode === "plan") return;
  ensure(
    !blockers.length,
    "Update needs the maintenance actions listed in the plan; running services were untouched",
  );
  if (plan.noop && activeRecord) {
    await verifySite(
      config.publicOrigin,
      activeRecord.frontend.htmlSha256,
      activeRecord.siteConfigSha256,
    );
    await verifyAssets(config.publicOrigin, activeRecord.frontend.manifest);
    verifyRetained(containers, await inspect(), []);
    console.log(
      `No runtime changes for ${sourceCommit}; no images built, migrations run, backups made or services restarted.`,
    );
    return;
  }
  if (!plan.noop) {
    await run("npm", ["run", "build:offchain"], {
      cwd: root,
      timeout: 300000,
      label: "Compile deployment configuration validators",
    });
    await loadPublicSiteStack(c);
  }
  const directory = resolve(
    config.stateDirectory,
    `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${sourceCommit.slice(0, 12)}`,
  );
  await mkdir(directory, { mode: 0o700 });
  for (const service of SERVICES) {
    previousCompose.services[service] = await pinMountInputs(
      previousCompose.services[service],
      resolve(directory, "previous-inputs", service),
    );
    previous[service] = {
      ...previous[service],
      mounts: pinnedMounts(previousCompose.services[service]),
      mountDigests: await mountInputs(previousCompose.services[service]),
    };
  }
  const rollbackFile = resolve(directory, "rollback.compose.json");
  await privateJson(rollbackFile, escapeCompose(previousCompose));
  await composeFile(rollbackFile, ["config", "--quiet"]);
  journal = {
    version: 2,
    directory,
    sourceCommit,
    rollbackFile,
    privateInputs,
    siteConfigSha256: desiredSiteConfigSha256,
    beforeContainers: containers.map((item) => ({
      Id: item.Id,
      Image: item.Image,
      State: item.State,
      Config: { Labels: item.Config.Labels },
    })),
    plan,
    database: {
      id: pg.Id,
      image: pg.Image,
      volume: pg.Mounts.find(
        (m) => m.Destination === "/var/lib/postgresql/data",
      )?.Name,
    },
    servicesTouched: false,
    status: "preparing",
    startedAt: new Date().toISOString(),
  };
  if (!plan.noop) await save("preparing");
  async function prepareAssets(image, revision, label, existingRelease) {
    const output = resolve(directory, label),
      name = `cpredict-export-${randomUUID().slice(0, 12)}`;
    await mkdir(output, { mode: 0o700 });
    try {
      await docker(["create", "--name", name, image]);
      await docker(["cp", `${name}:/usr/share/nginx/html/.`, output]);
    } finally {
      // This uniquely named, never-started container is the only export object removed.
      await docker(["rm", "-f", name]).catch(() => {});
    }
    const manifest = await createManifest(output, revision);
    if (existingRelease) {
      ensure(
        cloud.sourceCommit === revision &&
          cloud.htmlSha256 === manifest.htmlSha256,
        "Existing cloud release differs from the running frontend image",
      );
      await verifyAssets(config.publicOrigin, manifest);
      return {
        release: existingRelease,
        manifest,
        htmlSha256: manifest.htmlSha256,
        sourceCommit: revision,
      };
    }
    const bundle = resolve(directory, `${label}-bundle`);
    await mkdir(bundle, { mode: 0o700 });
    for (const row of manifest.files) {
      const target = resolve(bundle, row.path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await cp(resolve(output, row.path), target);
    }
    await writeFile(resolve(bundle, "release.json"), JSON.stringify(manifest));
    const archive = resolve(directory, `${label}.tar.gz`);
    await run(
      "tar",
      [
        "--format=ustar",
        "-czf",
        archive,
        "-C",
        bundle,
        "assets",
        "release.json",
      ],
      {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        label: "Static asset archive",
      },
    );
    const bytes = await readFile(archive),
      release = sha256(bytes);
    const receipt = await publisher(
      config,
      `upload ${release} ${bytes.length}`,
      bytes,
    );
    ensure(
      receipt.release === release &&
        receipt.sourceCommit === revision &&
        receipt.htmlSha256 === manifest.htmlSha256,
      "Cloud upload receipt mismatch",
    );
    await verifyAssets(config.publicOrigin, manifest);
    return {
      release,
      manifest,
      htmlSha256: manifest.htmlSha256,
      sourceCommit: revision,
    };
  }
  try {
    const gateway = containers.find(
      (c) => c.Config.Labels?.["com.docker.compose.service"] === "web-demo",
    );
    journal.previous =
      [activeRecord?.frontend, last?.candidate, last?.previous].find(
        (r) => r?.release === cloud.release,
      ) ??
      (await prepareAssets(
        gateway.Image,
        previous["web-demo"].sourceCommit,
        "previous",
        cloud.release,
      ));
    ensure(
      journal.previous.htmlSha256 === localHtml.sha256,
      "Running HTML differs from its image",
    );
    await verifySite(config.publicOrigin, localHtml.sha256, siteConfig.sha256);
    // Establish or reconcile the baseline only after proving the currently served bytes.
    if (!cloud.release)
      await publisher(
        config,
        `activate ${journal.previous.release} ${cloud.release ?? "none"}`,
      );
    cloud = await publisher(config, "status");
    ensure(
      cloud.release === journal.previous.release,
      "Cloud baseline reconciliation failed",
    );
    journal.previousState = {
      version: 2,
      components: previous,
      database: journal.database,
      frontend: journal.previous,
      postgresConfiguration,
      privateInputs: activeRecord?.privateInputs ?? privateInputs,
      siteConfigSha256: activeRecord?.siteConfigSha256 ?? siteConfig.sha256,
    };
    if (plan.noop) {
      await privateJson(activeFile, journal.previousState);
      console.log(
        `Adopted existing component versions for ${sourceCommit}; no services restarted or database writes performed.`,
      );
      return;
    }
    await save("building");
    await sourcesUnchanged();
    const tags = {};
    for (const service of plan.buildServices) {
      tags[service] = `cpredict/update-${service}:${sourceCommit}`;
      desired.services[service].image = tags[service];
      ensure(
        desired.services[service].build,
        `Missing build target for ${service}`,
      );
    }
    const candidateFile = resolve(directory, "candidate.compose.json");
    for (const service of SERVICES)
      if (!plan.updateServices.includes(service))
        desired.services[service] = escapeCompose(
          previousCompose.services[service],
        );
    for (const service of plan.updateServices) {
      desired.services[service] = await pinMountInputs(
        desired.services[service],
        resolve(directory, "candidate-inputs", service),
      );
      if (!plan.buildServices.includes(service)) {
        desired.services[service].image = previous[service].image;
        delete desired.services[service].build;
      }
    }
    for (const service of plan.migrationServices)
      desired.services[service] = await pinMigrationInputs(
        desired.services[service],
        service.slice("migrate-".length),
        tree,
        migrationFiles,
        resolve(directory, "migration-inputs", service),
      );
    Object.assign(desired.networks, previousCompose.networks);
    desired.volumes = { ...desired.volumes, ...previousCompose.volumes };
    await privateJson(candidateFile, desired);
    if (plan.buildServices.length)
      await composeFile(candidateFile, ["build", ...plan.buildServices], {
        timeout: 1800000,
        label: "Candidate service image build",
      });
    journal.images = Object.fromEntries(
      SERVICES.map((service) => [service, previous[service].image]),
    );
    for (const service of plan.buildServices) {
      const image = JSON.parse(
        await docker(["image", "inspect", tags[service]]),
      )[0];
      ensure(
        image.Config.Labels?.["org.opencontainers.image.revision"] ===
          sourceCommit,
        "Candidate image revision mismatch",
      );
      journal.images[service] = image.Id;
      desired.services[service].image = image.Id;
      delete desired.services[service].build;
    }
    await privateJson(candidateFile, desired);
    const candidate = plan.publishAssets
      ? await prepareAssets(
          journal.images["web-demo"],
          sourceCommit,
          "candidate",
        )
      : journal.previous;
    journal.release = candidate.release;
    journal.candidate = candidate;
    journal.candidateFile = candidateFile;
    await filesUnchanged(privateInputs);
    await sourcesUnchanged();
    await save("assets-verified");
    await applySelectedServices({
      plan,
      journal,
      containers,
      candidateFile,
      composeFile,
      docker,
      save,
      backup: async (databaseNames) => {
        const outputRoot = resolve(directory, "backup");
        await mkdir(outputRoot, { mode: 0o700 });
        const created = await createStackBackup({
          configuration: c,
          outputRoot,
          databaseNames,
        });
        await validateBackupFiles(created.directory, created.manifest);
        for (const dump of Object.values(created.manifest.dumps))
          await docker(["exec", "-i", pg.Id, "pg_restore", "--list"], {
            input: await readFile(resolve(created.directory, dump.file)),
            timeout: 120000,
            label: "Validate backup archive",
          });
        journal.backup = {
          directory: created.directory,
          databases: databaseNames,
          validation: "checksums-and-archive-list",
        };
      },
    });
    if (pending.length)
      ensure(
        !pendingMigrations(
          migrationFiles,
          await readAppliedMigrations(
            docker,
            pg,
            c.secret.CPREDICT_STACK_MIGRATOR_PASSWORD,
          ),
        ).length,
        "Pending migrations remain after update",
      );
    await filesUnchanged(privateInputs);
    await databaseUnchanged(journal.database);
    const after = await inspect();
    if (plan.refreshProxies)
      journal.proxyChecks = await refreshProxyUpstreams(after, docker);
    verifyRetained(containers, after, touchedServices(journal));
    for (const service of SERVICES)
      ensure(
        after.some(
          (c) =>
            c.Config.Labels?.["com.docker.compose.service"] === service &&
            c.Image === journal.images[service] &&
            c.State.Health?.Status === "healthy",
        ),
        `Updated ${service} is not healthy at the expected revision`,
      );
    journal.publicChecks = await verifySite(
      config.publicOrigin,
      candidate.htmlSha256,
      journal.siteConfigSha256,
    );
    journal.assetChecks = await verifyAssets(
      config.publicOrigin,
      candidate.manifest,
    );
    if (candidate.release !== journal.previous.release)
      await publisher(
        config,
        `activate ${candidate.release} ${journal.previous.release}`,
      );
    const active = await publisher(config, "status");
    ensure(
      active.release === candidate.release &&
        active.sourceCommit === candidate.sourceCommit,
      "Final cloud release mismatch",
    );
    const candidateComponents = {};
    for (const service of SERVICES)
      candidateComponents[service] = plan.updateServices.includes(service)
        ? {
            ...current[service],
            image: journal.images[service],
            sourceCommit: plan.buildServices.includes(service)
              ? sourceCommit
              : previous[service].sourceCommit,
            configurationRevision: sourceCommit,
            mounts: pinnedMounts(desired.services[service]),
            mountDigests: await mountInputs(desired.services[service]),
          }
        : previous[service];
    journal.candidateState = {
      version: 2,
      components: candidateComponents,
      frontend: candidate,
      siteConfigSha256: journal.siteConfigSha256,
      privateInputs,
      database: journal.database,
      postgresConfiguration,
    };
    await privateJson(activeFile, journal.candidateState);
    await save("succeeded");
    console.log(
      `PUBLIC UPDATE VERIFIED ${sourceCommit}; ${journal.assetChecks.length} assets, ${journal.publicChecks.length} routes, existing database retained.`,
    );
  } catch (error) {
    if (plan.noop) throw error;
    journal.failure = error.code ? error.code : error.message;
    if (journal.servicesTouched) {
      try {
        await restore();
      } catch (recoveryError) {
        await save("recovery-required");
        throw new Error(
          `Update failed and automatic recovery needs attention: ${recoveryError.code ?? recoveryError.message}`,
        );
      }
    } else
      await save(
        journal.databaseTouched ? "migration-failed" : "preparation-failed",
      );
    throw error;
  }
}

async function readRecord(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function verifyComponents(components, containers) {
  await verifyPinnedInputs(components);
  for (const service of SERVICES)
    ensure(
      containers.some(
        (item) =>
          item.Config.Labels?.["com.docker.compose.service"] === service &&
          item.Image === components[service]?.image &&
          item.State.Running &&
          item.State.Health?.Status === "healthy",
      ),
      `Running ${service} differs from its recorded healthy image`,
    );
}
