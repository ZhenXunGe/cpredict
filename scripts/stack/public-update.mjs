#!/usr/bin/env node
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// This bootstrap deliberately does not import the runner's modules before Git updates them.
const ensure = (value, message) => {
  if (!value) throw new Error(message);
};
const run = async (command, args, options) => {
  try {
    return (
      await promisify(execFile)(command, args, { ...options, timeout: 120000 })
    ).stdout;
  } catch {
    throw new Error(
      "Git update failed; inspect branch/divergence without discarding local work",
    );
  }
};
const privateJson = async (path, value) => {
  await writeFile(path + ".tmp", JSON.stringify(value) + "\n", { mode: 0o600 });
  await chmod(path + ".tmp", 0o600);
  await rename(path + ".tmp", path);
};

const root = resolve(import.meta.dirname, "../..");
const mode = process.argv[2] ?? "update";
const modes = ["update", "check", "recover", "rollback"];
let owned = false,
  lock;
try {
  ensure(
    modes.includes(mode) && process.argv.length <= 3,
    "Usage: npm run stack:update:public -- [update|check|recover|rollback]",
  );
  const path = resolve(root, "runtime/public-site/update.json");
  const info = await lstat(path);
  ensure(
    info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0,
    "Update configuration must be a private regular file (0600)",
  );
  const config = JSON.parse(await readFile(path, "utf8"));
  config.stateDirectory = resolve(root, "runtime/public-site/updates");
  lock = resolve(config.stateDirectory, "lock");
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  try {
    await mkdir(lock, { mode: 0o700 });
    owned = true;
  } catch {
    const owner = JSON.parse(
      await readFile(resolve(lock, "owner.json"), "utf8"),
    );
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") alive = false;
    }
    ensure(
      mode === "recover" && owner.host === hostname() && !alive,
      "Another update or interrupted update holds the lock; inspect it and use recover",
    );
    await rm(lock, { recursive: true });
    await mkdir(lock, { mode: 0o700 });
    owned = true;
  }
  await privateJson(resolve(lock, "owner.json"), {
    pid: process.pid,
    host: hostname(),
  });
  if (mode === "update") {
    ensure(
      (await run("git", ["branch", "--show-current"], { cwd: root })).trim() ===
        "main",
      "Deployment checkout must be main",
    );
    ensure(
      !(
        await run("git", ["status", "--porcelain", "--untracked-files=no"], {
          cwd: root,
        })
      ).trim(),
      "Tracked local edits must be resolved before updating",
    );
    // A pending service switch must be reconciled before changing the checkout.
    try {
      const current = JSON.parse(
        await readFile(resolve(config.stateDirectory, "current.json"), "utf8"),
      );
      ensure(
        ["succeeded", "rolled-back", "preparation-failed"].includes(
          current.status,
        ),
        "An interrupted update needs recover first",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    console.log(
      "Fetching origin/main and checking fast-forward compatibility…",
    );
    await run("git", ["fetch", "origin", "main"], {
      cwd: root,
      timeout: 120000,
    });
    await run("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], {
      cwd: root,
      label: "Fast-forward preflight",
    });
    await run("git", ["merge", "--ff-only", "origin/main"], { cwd: root });
  }
  // Load the newly pulled implementation, not the previous revision of the runner.
  const runner = await import(
    pathToFileURL(resolve(root, "scripts/stack/public-update-runner.mjs"))
      .href + `?run=${Date.now()}`
  );
  await runner.execute({ root, config, mode });
} catch (error) {
  // Native filesystem errors can contain private identity locations.
  console.error(
    error.code
      ? `Public update failed (${error.code}); private paths withheld`
      : error.message,
  );
  process.exitCode = 1;
} finally {
  if (owned) await rm(lock, { recursive: true });
}
