import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanDemoBundle } from "./scan-demo-bundle.mjs";

test("Demo bundle scanner accepts public addresses and paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-demo-scan-"));
  await writeFile(join(root, "app.js"), `const address="0x${"1".repeat(40)}"; const rpc="/rpc";`);
  await assert.doesNotReject(scanDemoBundle(root));
});

test("Demo bundle scanner rejects server credentials without echoing values", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-demo-scan-"));
  await writeFile(join(root, "app.js"), "const config='postgresql://user:password@postgres/db'");
  await assert.rejects(scanDemoBundle(root), /postgres-url/);
});
