#!/usr/bin/env node
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT_BOUNDARY = resolve(ROOT, "runtime/host-systemd");
const OPERATOR = /^[a-z_][a-z0-9_-]{0,31}$/;

export function parseBackupServiceArgs(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${flag}: missing value`);
    const key = { "--operator": "operator", "--output": "output" }[flag];
    if (key === undefined) throw new Error(`unknown option ${flag}`);
    if (Object.hasOwn(output, key)) throw new Error(`duplicate option ${flag}`);
    output[key] = value;
  }
  if (!output.operator) throw new Error("--operator is required");
  return output;
}

export async function renderBackupService(
  input,
  { root = ROOT, outputBoundary = OUTPUT_BOUNDARY } = {},
) {
  if (!OPERATOR.test(input.operator))
    throw new Error("--operator must be a Linux account name");
  if (input.operator === "root")
    throw new Error("backup service operator must not be root");
  const canonicalRoot = await realpath(root);
  if (/\s/.test(canonicalRoot))
    throw new Error(
      "repository path must not contain whitespace for the systemd unit",
    );
  const output = resolve(
    root,
    input.output ?? relative(root, resolve(outputBoundary, input.operator)),
  );
  assertWithin(output, outputBoundary);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const service = replaceAll(
    await readFile(
      resolve(root, "deploy/host/systemd/cpredict-backup.service.template"),
      "utf8",
    ),
    { "@@OPERATOR@@": input.operator, "@@REPO_ROOT@@": canonicalRoot },
  );
  const timer = await readFile(
    resolve(root, "deploy/host/systemd/cpredict-backup.timer"),
    "utf8",
  );
  await atomicWrite(resolve(output, "cpredict-backup.service"), service);
  await atomicWrite(resolve(output, "cpredict-backup.timer"), timer);
  return {
    output,
    files: ["cpredict-backup.service", "cpredict-backup.timer"],
  };
}

function replaceAll(source, replacements) {
  let output = source;
  for (const [token, value] of Object.entries(replacements))
    output = output.replaceAll(token, value);
  if (/@@[A-Z_]+@@/.test(output))
    throw new Error("unresolved systemd template token");
  return output;
}

function assertWithin(path, parent) {
  const child = relative(parent, path);
  if (child === "" || child === ".") return;
  if (child.startsWith("..") || child.startsWith("/"))
    throw new Error("systemd output must stay under runtime/host-systemd");
}

async function atomicWrite(path, contents) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  renderBackupService(parseBackupServiceArgs(process.argv.slice(2)))
    .then((result) =>
      process.stdout.write(`BACKUP SERVICE MATERIAL ${result.output}\n`),
    )
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
