import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  applyDeclarationPatches,
  runtimeDigest,
  verifyDeclarationPatches,
} from "./apply-declaration-patches.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cpredict-patch-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, value) =>
    writeFileSync(
      join(root, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  for (const dir of ["node_modules/fixture-sdk", "patches", "manifests"])
    mkdirSync(join(root, dir), { recursive: true });
  symlinkSync(
    fileURLToPath(new URL("../../node_modules/patch-package", import.meta.url)),
    join(root, "node_modules/patch-package"),
  );
  write("package.json", { name: "declaration-test", private: true });
  write("node_modules/fixture-sdk/package.json", {
    name: "fixture-sdk",
    version: "1.0.0",
  });
  const runtime = "export const answer = 42;\n",
    before = "export type Answer = string;\n",
    after = "export type Answer = number;\n";
  write("node_modules/fixture-sdk/index.js", runtime);
  write("node_modules/fixture-sdk/index.d.ts", before);
  const patch =
    "diff --git a/node_modules/fixture-sdk/index.d.ts b/node_modules/fixture-sdk/index.d.ts\n--- a/node_modules/fixture-sdk/index.d.ts\n+++ b/node_modules/fixture-sdk/index.d.ts\n@@ -1 +1 @@\n-export type Answer = string;\n+export type Answer = number;\n";
  write("patches/fixture-sdk+1.0.0.patch", patch);
  const locked = {
    version: "1.0.0",
    integrity: "sha512-fixture",
    resolved: "https://registry.npmjs.org/fixture-sdk/-/fixture-sdk-1.0.0.tgz",
  };
  write("package-lock.json", {
    lockfileVersion: 3,
    packages: { "node_modules/fixture-sdk": locked },
  });
  const manifest = {
    schemaVersion: 1,
    packages: [
      {
        path: "node_modules/fixture-sdk",
        name: "fixture-sdk",
        ...locked,
        source: locked.resolved,
        runtimeSha256: runtimeDigest(join(root, "node_modules/fixture-sdk")),
        patch: "patches/fixture-sdk+1.0.0.patch",
        patchSha256: hash(patch),
        files: [
          {
            path: "index.d.ts",
            originalSha256: hash(before),
            patchedSha256: hash(after),
          },
        ],
        sources: [{ path: "index.js", sha256: hash(runtime) }],
      },
    ],
  };
  write("manifests/sdk-declaration-patches.json", manifest);
  return { root, write, manifest, before, after };
}

test("applies once and repeatedly without changing runtime bytes", (t) => {
  const f = fixture(t);
  const before = runtimeDigest(join(f.root, "node_modules/fixture-sdk"));
  assert.throws(
    () => verifyDeclarationPatches(f.root, { applied: true }),
    /declaration bytes/,
  );
  assert.equal(applyDeclarationPatches(f.root), 1);
  assert.equal(applyDeclarationPatches(f.root), 1);
  assert.equal(
    readFileSync(join(f.root, "node_modules/fixture-sdk/index.d.ts"), "utf8"),
    f.after,
  );
  assert.equal(runtimeDigest(join(f.root, "node_modules/fixture-sdk")), before);
});
test("rejects a different package version before editing declarations", (t) => {
  const f = fixture(t);
  f.write("node_modules/fixture-sdk/package.json", {
    name: "fixture-sdk",
    version: "1.0.1",
  });
  assert.throws(() => applyDeclarationPatches(f.root), /version\/integrity/);
  assert.equal(
    readFileSync(join(f.root, "node_modules/fixture-sdk/index.d.ts"), "utf8"),
    f.before,
  );
});
test("rejects an integrity mismatch and unknown declaration bytes", (t) => {
  const f = fixture(t);
  f.manifest.packages[0].integrity = "sha512-other";
  f.write("manifests/sdk-declaration-patches.json", f.manifest);
  assert.throws(() => verifyDeclarationPatches(f.root), /version\/integrity/);
  f.manifest.packages[0].integrity = "sha512-fixture";
  f.write("manifests/sdk-declaration-patches.json", f.manifest);
  f.write(
    "node_modules/fixture-sdk/index.d.ts",
    "export type Answer = boolean;\n",
  );
  assert.throws(() => verifyDeclarationPatches(f.root), /declaration bytes/);
});
test("rejects runtime changes, extra patches and patch tampering", (t) => {
  const f = fixture(t);
  f.write("patches/extra+1.0.0.patch", "");
  assert.throws(() => verifyDeclarationPatches(f.root), /unregistered patch/);
  rmSync(join(f.root, "patches/extra+1.0.0.patch"));
  f.write("patches/fixture-sdk+1.0.0.patch", "unexpected content");
  assert.throws(() => verifyDeclarationPatches(f.root), /patch hash/);
  f.write("node_modules/fixture-sdk/index.js", "export const answer = 0;\n");
  assert.throws(() => verifyDeclarationPatches(f.root), /runtime bytes/);
});
test("verifies the installed SDK patches against the actual locked releases", () => {
  assert.equal(
    verifyDeclarationPatches(undefined, { applied: true }).packages.length,
    4,
  );
});
