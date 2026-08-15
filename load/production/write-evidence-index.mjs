import { createHash } from "node:crypto";
import {
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

const reportDirectory = await realpath(requiredArgument(2, "report directory"));
const runId = requiredArgument(3, "RUN_ID");
const lane = requiredArgument(4, "lane");
const allowedRoot = `${await realpath(resolve("reports/performance"))}${sep}`;
if (!`${reportDirectory}${sep}`.startsWith(allowedRoot)) {
  throw new Error("evidence directory is outside reports/performance");
}
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId))
  throw new Error("invalid RUN_ID");

const files = [];
for (const name of (await readdir(reportDirectory)).sort()) {
  if (
    name === "evidence-index.json" ||
    name === "stage-exit-codes.json" ||
    name.startsWith(".")
  )
    continue;
  const path = resolve(reportDirectory, name);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
  const body = await readFile(path);
  files.push({
    name: basename(path),
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  });
}
if (files.length === 0)
  throw new Error("evidence directory contains no regular files");
const result = {
  schemaVersion: 1,
  runId,
  lane,
  generatedAt: new Date().toISOString(),
  exclusions: ["evidence-index.json", "stage-exit-codes.json"],
  files,
};
const temporary = resolve(reportDirectory, ".evidence-index.json.tmp");
await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
await rename(temporary, resolve(reportDirectory, "evidence-index.json"));
process.stdout.write(`indexed ${files.length} evidence files\n`);

function requiredArgument(index, label) {
  const value = process.argv[index];
  if (value === undefined || value.length === 0)
    throw new Error(`${label} is required`);
  return value;
}
