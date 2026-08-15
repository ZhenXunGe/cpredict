import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("role preflight accepts exact release inputs and rejects stale clock or source drift", async () => {
  const directory = await mkdtemp(
    resolve(tmpdir(), "cpredict-role-preflight-"),
  );
  try {
    const sourcePath = resolve(directory, "source-manifest.json");
    const releasePath = resolve(directory, "release-config.json");
    const clockPath = resolve(directory, "clock.json");
    const identityPath = resolve(directory, "identity.bin");
    const sourceBody = Buffer.from("{}\n");
    await writeFile(sourcePath, sourceBody);
    await writeFile(identityPath, "cloud instance identity receipt fixture\n");
    const commit = "b".repeat(40);
    const image = `sha256:${"1".repeat(64)}`;
    const release = {
      schemaVersion: 1,
      gitCommitSha: commit,
      sourceManifestSha256: sha256(sourceBody),
      migrationsSha256: await migrationDigest(),
      runtimeImageDigests: { load: image },
    };
    await writeFile(releasePath, `${JSON.stringify(release)}\n`);
    const observedAt = new Date();
    await writeFile(
      clockPath,
      `${JSON.stringify({ schemaVersion: 1, source: "chrony", maxOffsetMs: 25, observedAt: observedAt.toISOString() })}\n`,
    );
    const environment = {
      ...process.env,
      CPREDICT_ROLE_STARTED_AT: new Date(
        observedAt.valueOf() - 1_000,
      ).toISOString(),
      CPREDICT_HOST_IDENTITY: "load-instance-1",
      CPREDICT_HOST_IDENTITY_SOURCE: "cloud-instance-identity",
      CPREDICT_HOST_IDENTITY_EVIDENCE_PATH: identityPath,
      CPREDICT_SOURCE_MANIFEST_PATH: sourcePath,
      CPREDICT_RELEASE_CONFIG_PATH: releasePath,
      CPREDICT_CLOCK_EVIDENCE_PATH: clockPath,
      CPREDICT_GIT_COMMIT_SHA: commit,
      CPREDICT_RUNTIME_IMAGE_DIGEST: image,
      CPREDICT_CLOCK_SOURCE: "chrony",
      CPREDICT_CLOCK_MAX_OFFSET_MS: "25",
      SUT_BASE_URL: "https://sut.example.invalid",
      SUT_WS_URL: "wss://sut.example.invalid/v1/stream",
    };
    await assert.doesNotReject(() => preflight(environment));

    await writeFile(
      clockPath,
      `${JSON.stringify({ schemaVersion: 1, source: "chrony", maxOffsetMs: 25, observedAt: new Date(observedAt.valueOf() - 62_000).toISOString() })}\n`,
    );
    await assert.rejects(() => preflight(environment), /within 60 seconds/);

    await writeFile(
      clockPath,
      `${JSON.stringify({ schemaVersion: 1, source: "chrony", maxOffsetMs: 25, observedAt: observedAt.toISOString() })}\n`,
    );
    await writeFile(sourcePath, "drift\n");
    await assert.rejects(
      () => preflight(environment),
      /source manifest digest mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function preflight(env) {
  return execute(
    process.execPath,
    ["load/distributed/preflight-role-evidence.mjs", "load"],
    {
      cwd: process.cwd(),
      env,
    },
  );
}

async function migrationDigest() {
  const directory = resolve("offchain/indexer/migrations");
  const hash = createHash("sha256");
  for (const name of (await readdir(directory)).sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(resolve(directory, name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
