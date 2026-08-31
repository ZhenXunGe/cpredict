import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseBackupServiceArgs,
  renderBackupService,
} from "./render-backup-service.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cpredict-systemd-root-"));
  const boundary = await mkdtemp(join(tmpdir(), "cpredict-systemd-output-"));
  await mkdir(join(root, "deploy/host/systemd"), { recursive: true });
  await writeFile(
    join(root, "deploy/host/systemd/cpredict-backup.service.template"),
    [
      "User=@@OPERATOR@@",
      "WorkingDirectory=@@REPO_ROOT@@",
      "ExecStart=/usr/local/bin/npm run stack:backup:verified",
      "ReadWritePaths=@@REPO_ROOT@@/runtime",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "deploy/host/systemd/cpredict-backup.timer"),
    "Persistent=true\n",
  );
  return { root, boundary };
}

test("backup service material binds a validated operator and absolute checkout", async () => {
  const value = await fixture();
  const result = await renderBackupService(
    { operator: "cpredict", output: join(value.boundary, "cpredict") },
    { root: value.root, outputBoundary: value.boundary },
  );
  const service = await readFile(
    join(result.output, "cpredict-backup.service"),
    "utf8",
  );
  const canonicalRoot = await realpath(value.root);
  assert.match(service, /User=cpredict/);
  assert.ok(service.includes(`WorkingDirectory=${canonicalRoot}`));
  assert.match(service, /stack:backup:verified/);
  assert.doesNotMatch(service, /@@/);
});

test("backup service renderer rejects unsafe accounts, unknown options and output escape", async () => {
  const value = await fixture();
  await assert.rejects(
    renderBackupService(
      { operator: "root;id", output: join(value.boundary, "bad") },
      { root: value.root, outputBoundary: value.boundary },
    ),
    /Linux account/,
  );
  await assert.rejects(
    renderBackupService(
      { operator: "root", output: join(value.boundary, "root") },
      { root: value.root, outputBoundary: value.boundary },
    ),
    /must not be root/,
  );
  await assert.rejects(
    renderBackupService(
      { operator: "cpredict", output: join(value.boundary, "..", "escape") },
      { root: value.root, outputBoundary: value.boundary },
    ),
    /must stay under/,
  );
  assert.throws(() => parseBackupServiceArgs(["--who", "x"]), /unknown option/);
  assert.throws(() => parseBackupServiceArgs([]), /required/);
});
