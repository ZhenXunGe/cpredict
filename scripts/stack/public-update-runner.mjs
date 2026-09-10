import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadStackConfiguration } from "./config.mjs";
import { loadPublicSiteStack } from "./public-site-config.mjs";
import { createVerifiedBackup } from "./verified-backup.mjs";
import { createStackBackup } from "./backup.mjs";
import {
  SERVICES,
  createManifest,
  ensure,
  escapeCompose,
  fetchBytes,
  privateJson,
  publisher,
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
    await save("rolling-back");
    await composeFile(
      journal.rollbackFile,
      [
        "up",
        "-d",
        "--no-deps",
        "--no-build",
        "--pull",
        "never",
        "--wait",
        "--wait-timeout",
        "180",
        ...SERVICES,
      ],
      { timeout: 300000, label: "Restore previous service images" },
    );
    await filesUnchanged(journal.privateInputs);
    await databaseUnchanged(journal.database);
    const routes = await verifySite(
      config.publicOrigin,
      journal.previous.htmlSha256,
      journal.siteConfigSha256,
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
      journal.version === 1 && journal.rollbackFile,
      "No recoverable update record",
    );
    if (
      mode === "recover" &&
      ["succeeded", "rolled-back"].includes(journal.status)
    ) {
      const expected =
        journal.status === "succeeded" ? journal.candidate : journal.previous;
      const active = await publisher(config, "status");
      ensure(
        active.release === expected.release,
        "Completed update record differs from cloud state",
      );
      await filesUnchanged(journal.privateInputs);
      await databaseUnchanged(journal.database);
      await verifySite(
        config.publicOrigin,
        expected.htmlSha256,
        journal.siteConfigSha256,
      );
      await verifyAssets(config.publicOrigin, expected.manifest);
      console.log(
        "Completed update reconciled; stale lock released without another service switch.",
      );
      return;
    }
    if (!journal.servicesTouched) {
      await save("preparation-failed");
      console.log(
        "Preparation was interrupted; running services were untouched.",
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
    const site = await fetchBytes(config.localOrigin, "/site-config.json");
    await verifySite(config.publicOrigin, cloud.htmlSha256, site.sha256);
    const record = JSON.parse(await readFile(stateFile, "utf8"));
    const release = [record.candidate, record.previous].find(
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
  let last;
  try {
    last = JSON.parse(await readFile(stateFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    last?.status === "succeeded" &&
    last.sourceCommit === sourceCommit &&
    cloud.release === last.release
  ) {
    await filesUnchanged(last.privateInputs);
    await databaseUnchanged(last.database);
    const live = await inspect();
    ensure(
      SERVICES.every((service) =>
        live.some(
          (c) =>
            c.Config.Labels?.["com.docker.compose.service"] === service &&
            c.Image === last.images[service] &&
            c.State.Health?.Status === "healthy",
        ),
      ),
      "Running services changed since the last verified update",
    );
    await verifyAssets(config.publicOrigin, last.candidate.manifest);
    await verifySite(
      config.publicOrigin,
      last.candidate.htmlSha256,
      last.siteConfigSha256,
    );
    console.log(
      `Already deployed and publicly verified: ${sourceCommit}; no services restarted.`,
    );
    return;
  }
  console.log(
    `Preparing main ${sourceCommit.slice(0, 12)}; running services remain available…`,
  );
  await run("npm", ["ci", "--ignore-scripts"], {
    cwd: root,
    timeout: 900000,
    label: "Locked dependency install",
  });
  await run("npm", ["run", "build:offchain"], {
    cwd: root,
    timeout: 300000,
    label: "Offchain build and configuration validation",
  });
  const c = await loadStackConfiguration();
  const publicStack = await loadPublicSiteStack(c);
  Object.assign(c.environment, publicStack.environment);
  const env = {
    ...process.env,
    ...c.environment,
    CPREDICT_IMAGE_REVISION: sourceCommit,
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
  const previousCompose = rollbackCompose(containers);
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
  const inputs = [
    c.secretPath,
    c.publicPath,
    ...config.composeOverrides,
    c.secret.CPREDICT_STACK_SITE_CONFIG_FILE,
    ...publicStack.environments.flatMap((e) => [e.configPath, e.providerPath]),
  ].map((p) => resolve(root, p));
  const privateInputs = Object.fromEntries(
    await Promise.all(inputs.map(async (p) => [p, sha256(await readFile(p))])),
  );
  const siteConfig = await fetchBytes(config.localOrigin, "/site-config.json");
  ensure(
    siteConfig.status === 200 &&
      siteConfig.sha256 ===
        sha256(
          await readFile(
            resolve(root, c.secret.CPREDICT_STACK_SITE_CONFIG_FILE),
          ),
        ),
    "Running/public configuration does not match private inputs",
  );
  const localHtml = await fetchBytes(config.localOrigin, "/");
  const directory = resolve(
    config.stateDirectory,
    `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${sourceCommit.slice(0, 12)}`,
  );
  await mkdir(directory, { mode: 0o700 });
  const rollbackFile = resolve(directory, "rollback.compose.json");
  await privateJson(rollbackFile, escapeCompose(previousCompose));
  await composeFile(rollbackFile, ["config", "--quiet"]);
  journal = {
    version: 1,
    directory,
    sourceCommit,
    rollbackFile,
    privateInputs,
    siteConfigSha256: siteConfig.sha256,
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
  await save("preparing");
  async function prepareAssets(image, revision, label) {
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
    const previousImage = JSON.parse(
      await docker(["image", "inspect", gateway.Image]),
    )[0];
    journal.previous = await prepareAssets(
      gateway.Image,
      previousImage.Config.Labels["org.opencontainers.image.revision"],
      "previous",
    );
    ensure(
      journal.previous.htmlSha256 === localHtml.sha256,
      "Running HTML differs from its image",
    );
    await verifySite(config.publicOrigin, localHtml.sha256, siteConfig.sha256);
    // Establish or reconcile the baseline only after proving the currently served bytes.
    await publisher(
      config,
      `activate ${journal.previous.release} ${cloud.release ?? "none"}`,
    );
    cloud = await publisher(config, "status");
    ensure(
      cloud.release === journal.previous.release,
      "Cloud baseline reconciliation failed",
    );
    await save("building");
    const tags = {};
    for (const service of SERVICES) {
      tags[service] = `cpredict/update-${service}:${sourceCommit}`;
      desired.services[service].image = tags[service];
      ensure(
        desired.services[service].build,
        `Missing build target for ${service}`,
      );
    }
    const candidateFile = resolve(directory, "candidate.compose.json");
    await privateJson(candidateFile, desired);
    await composeFile(candidateFile, ["build", ...SERVICES], {
      timeout: 1800000,
      label: "Candidate service image build",
    });
    journal.images = {};
    for (const service of SERVICES) {
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
    const candidate = await prepareAssets(
      journal.images["web-demo"],
      sourceCommit,
      "candidate",
    );
    journal.release = candidate.release;
    journal.candidate = candidate;
    journal.candidateFile = candidateFile;
    await filesUnchanged(privateInputs);
    await save("assets-verified");
    console.log(
      "Cloud assets verified. Backing up existing databases before the service update…",
    );
    journal.servicesTouched = true;
    await save("stopping-writers");
    await docker(
      [
        "stop",
        ...containers
          .filter(
            (c) =>
              SERVICES.includes(
                c.Config.Labels?.["com.docker.compose.service"],
              ) && c.Config.Labels["com.docker.compose.service"] !== "web-demo",
          )
          .map((c) => c.Id),
      ],
      { timeout: 120000 },
    );
    const backupRoot = resolve(directory, "backup");
    await mkdir(backupRoot, { mode: 0o700 });
    const backup = await createVerifiedBackup({
      backup: (options) =>
        createStackBackup({
          ...options,
          configuration: c,
          outputRoot: backupRoot,
        }),
    });
    journal.backupVerified = backup.report.status === "PASS";
    await save("backup-verified");
    for (const service of [
      "migrate-indexer",
      "migrate-paymaster",
      "migrate-metadata",
      "migrate-app",
    ])
      await composeFile(candidateFile, ["run", "--rm", "--no-deps", service], {
        timeout: 300000,
        label: `Incremental ${service}`,
      });
    await save("switching-services");
    await composeFile(
      candidateFile,
      [
        "up",
        "-d",
        "--no-deps",
        "--no-build",
        "--pull",
        "never",
        "--wait",
        "--wait-timeout",
        "180",
        ...SERVICES,
      ],
      { timeout: 300000, label: "Update ctUSD services" },
    );
    await filesUnchanged(privateInputs);
    await databaseUnchanged(journal.database);
    const after = await inspect();
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
      siteConfig.sha256,
    );
    journal.assetChecks = await verifyAssets(
      config.publicOrigin,
      candidate.manifest,
    );
    await publisher(
      config,
      `activate ${candidate.release} ${journal.previous.release}`,
    );
    const active = await publisher(config, "status");
    ensure(
      active.release === candidate.release &&
        active.sourceCommit === sourceCommit,
      "Final cloud release mismatch",
    );
    await save("succeeded");
    console.log(
      `PUBLIC UPDATE VERIFIED ${sourceCommit}; ${journal.assetChecks.length} assets, ${journal.publicChecks.length} routes, existing database retained.`,
    );
  } catch (error) {
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
    } else await save("preparation-failed");
    throw error;
  }
}
