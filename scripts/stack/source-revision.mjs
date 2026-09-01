import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const EXACT_GIT_SHA = /^[0-9a-f]{40}$/;

export function parseSourceRevision(value) {
  const revision = `${value ?? ""}`.trim();
  if (!EXACT_GIT_SHA.test(revision))
    throw new Error("source revision must be an exact lowercase 40-character Git SHA");
  return revision;
}

export function readSourceRevision({ root = ROOT, run = runCommand } = {}) {
  const result = run(
    "git",
    ["rev-parse", "--verify", "HEAD^{commit}"],
    root,
  );
  if (result.code !== 0)
    throw new Error("unable to resolve the current source revision from Git");
  return parseSourceRevision(result.stdout);
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
