import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { normalizeTextLog } from "./normalize-text-log.mjs";

const scriptPath = fileURLToPath(new URL("./normalize-text-log.mjs", import.meta.url));

test("normalizes line endings, trailing horizontal whitespace, and final blank lines", () => {
  assert.equal(normalizeTextLog("alpha  \r\nbeta\t\r\n\r\n"), "alpha\nbeta\n");
});
test("preserves internal blank lines and produces exactly one final newline", () => {
  assert.equal(normalizeTextLog("alpha\n\n beta\n"), "alpha\n\n beta\n");
  assert.equal(normalizeTextLog(""), "");
});

test("CLI safely normalizes a file in place", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cpredict-log-normalization-"));
  const logPath = path.join(directory, "tool.log");
  try {
    await writeFile(logPath, "tool output   \n\n", "utf8");
    const result = spawnSync(process.execPath, [scriptPath, logPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(logPath, "utf8"), "tool output\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
