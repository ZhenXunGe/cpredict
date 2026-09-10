import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import { SERVICES, ensure, sha256 } from "./public-update-core.mjs";
import {
  stable,
  MIGRATION_GROUPS,
  touchedServices,
} from "./public-update-plan.mjs";

// The existing public transfer directory is live output, not application configuration.
const liveBind = (mount) =>
  mount.target === "/usr/share/nginx/html/_static-handoff";

export async function inputDigest(path) {
  const info = await lstat(path);
  ensure(
    !info.isSymbolicLink(),
    "Runtime bind inputs must not contain symlinks",
  );
  if (info.isFile()) return sha256(await readFile(path));
  ensure(info.isDirectory(), "Unsupported runtime bind input");
  const entries = await readdir(path);
  return sha256(
    stable(
      await Promise.all(
        entries
          .sort()
          .map(async (name) => [name, await inputDigest(resolve(path, name))]),
      ),
    ),
  );
}

export async function mountInputs(service) {
  const mounts = {};
  for (const mount of service.volumes ?? [])
    if (mount.type === "bind") {
      ensure(
        mount.read_only,
        "Writable application bind mounts require a separate update profile",
      );
      if (liveBind(mount)) continue;
      mounts[mount.target] = await inputDigest(mount.source);
    }
  return mounts;
}

/** Immutable local copies let a config-only rollback use the actual previous bytes. */
export async function pinMountInputs(service, directory) {
  const model = structuredClone(service);
  for (const mount of model.volumes ?? [])
    if (mount.type === "bind") {
      ensure(
        mount.read_only,
        "Cannot snapshot a writable application bind mount",
      );
      if (liveBind(mount)) continue;
      const digest = await inputDigest(mount.source);
      const destination = resolve(directory, sha256(mount.target).slice(0, 24));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await cp(mount.source, destination, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      ensure(
        (await inputDigest(destination)) === digest,
        "Runtime input changed during snapshot",
      );
      mount.source = destination;
    }
  return model;
}

export function restorePinnedMounts(model, pins) {
  const result = structuredClone(model);
  for (const mount of result.volumes ?? [])
    if (mount.type === "bind" && pins?.[mount.target])
      mount.source = pins[mount.target];
  return result;
}
export const pinnedMounts = (model) =>
  Object.fromEntries(
    (model.volumes ?? [])
      .filter((m) => m.type === "bind" && !liveBind(m))
      .map((m) => [m.target, m.source]),
  );

export async function verifyPinnedInputs(components) {
  for (const [service, component] of Object.entries(components)) {
    const mounts = component.mounts ?? {},
      digests = component.mountDigests ?? {};
    ensure(
      Object.keys(mounts).sort().join("\n") ===
        Object.keys(digests).sort().join("\n"),
      `Incomplete configuration snapshot for ${service}`,
    );
    for (const [target, path] of Object.entries(mounts))
      ensure(
        (await inputDigest(path)) === digests[target],
        `Saved configuration snapshot changed for ${service}`,
      );
  }
}

export async function readAppliedMigrations(docker, postgres, password) {
  ensure(/^[0-9a-f]{64}$/.test(postgres.Id), "Invalid PostgreSQL identity");
  const applied = {};
  for (const database of [
    ...new Set(MIGRATION_GROUPS.map((g) => g.database)),
  ]) {
    const args = [
      "exec",
      "-e",
      "PGPASSWORD",
      postgres.Id,
      "psql",
      "-U",
      "cpredict_migrator",
      "-d",
      `cpredict_${database}`,
      "-XAt",
      "--set=ON_ERROR_STOP=1",
      "-c",
    ];
    const options = {
      env: { ...process.env, PGPASSWORD: password },
      label: "Read migration registry",
      timeout: 30000,
    };
    const exists = await docker(
      [
        ...args,
        "SELECT to_regclass('public.public_site_migrations') IS NOT NULL",
      ],
      options,
    );
    ensure(
      ["t", "f"].includes(exists.trim()),
      "Invalid migration registry response",
    );
    applied[database] =
      exists.trim() === "f"
        ? []
        : JSON.parse(
            await docker(
              [
                ...args,
                "SELECT COALESCE(json_agg(json_build_object('path',path,'digest',digest) ORDER BY path),'[]'::json) FROM public_site_migrations",
              ],
              options,
            ),
          );
    ensure(
      Array.isArray(applied[database]) &&
        applied[database].every(
          (r) => typeof r.path === "string" && /^[0-9a-f]{64}$/.test(r.digest),
        ),
      "Invalid migration inventory response",
    );
  }
  return applied;
}

/** Materialize only the reviewed Git SQL inventory; local extra SQL must never execute. */
export async function pinMigrationInputs(
  service,
  kind,
  tree,
  migrations,
  directory,
) {
  const group = MIGRATION_GROUPS.find((item) => item.kind === kind);
  ensure(group, "Unknown migration group");
  const runnerTarget = "/usr/local/bin/run-cpredict-migrations";
  const model = structuredClone(service);
  ensure(
    model.volumes?.length === 2 &&
      model.volumes.every(
        (mount) => mount.type === "bind" && mount.read_only,
      ) &&
      new Set(model.volumes.map((mount) => mount.target)).size === 2 &&
      model.volumes.every((mount) =>
        ["/migrations", runnerTarget].includes(mount.target),
      ),
    "Migration mount overrides require a separate maintenance profile",
  );
  ensure(
    stable(model.entrypoint) === stable(["bash", runnerTarget, kind]) &&
      (!model.command ||
        (Array.isArray(model.command) && !model.command.length)) &&
      model.environment.PGDATABASE === `cpredict_${group.database}` &&
      model.environment.PGHOST === "postgres" &&
      model.environment.PGUSER === "cpredict_migrator",
    "Migration target or command differs from its planned database",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const sqlDirectory = resolve(directory, "migrations");
  await mkdir(sqlDirectory, { mode: 0o755 });
  const files = migrations.filter((migration) => migration.kind === kind);
  ensure(files.length, "Empty committed migration group");
  for (const file of files) {
    const content = await tree.read(file.path);
    ensure(sha256(content) === file.digest, "Migration changed after planning");
    await writeFile(resolve(sqlDirectory, basename(file.path)), content, {
      mode: 0o644,
      flag: "wx",
    });
  }
  const runnerPath = resolve(directory, "run-migrations.sh");
  await writeFile(
    runnerPath,
    await tree.read("deploy/compose/postgres/run-migrations.sh"),
    { mode: 0o644, flag: "wx" },
  );
  for (const mount of model.volumes)
    mount.source = mount.target === "/migrations" ? sqlDirectory : runnerPath;
  return model;
}

export async function restoreSelectedServices(journal, composeFile) {
  const touched = touchedServices(journal);
  if (touched.length)
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
        ...touched,
      ],
      { timeout: 300000, label: "Restore previous selected service images" },
    );
  return touched;
}

/** The sole ordinary-update mutation sequence, also exercised with a command recorder. */
export async function applySelectedServices({
  plan,
  journal,
  containers,
  candidateFile,
  composeFile,
  docker,
  save,
  backup,
}) {
  journal.touchedServices = [];
  if (plan.stopWriters.length) {
    journal.touchedServices = [...plan.stopWriters];
    journal.servicesTouched = true;
    await save("stopping-affected-writers");
    await docker(
      [
        "stop",
        ...plan.stopWriters.map((service) => {
          const container = containers.find(
            (c) => c.Config.Labels?.["com.docker.compose.service"] === service,
          );
          ensure(container?.State.Running, `Missing writer ${service}`);
          return container.Id;
        }),
      ],
      { timeout: 120000, label: "Stop affected database writers" },
    );
  }
  if (plan.backupDatabases.length) {
    await backup(plan.backupDatabases);
    await save("affected-databases-backed-up");
  }
  for (const service of plan.migrationServices) {
    journal.databaseTouched = true;
    await save("applying-pending-migrations");
    await composeFile(candidateFile, ["run", "--rm", "--no-deps", service], {
      timeout: 300000,
      label: `Incremental ${service}`,
    });
  }
  // Stopped siblings resume their previous image/config, even when only SQL changed.
  const touched = [...new Set([...plan.updateServices, ...plan.stopWriters])];
  if (touched.length) {
    ensure(
      touched.every((s) => SERVICES.includes(s)),
      "Invalid selected service",
    );
    journal.touchedServices = touched;
    journal.servicesTouched = true;
    await save("switching-selected-services");
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
        ...touched,
      ],
      { timeout: 300000, label: "Update selected ctUSD services" },
    );
  }
}
