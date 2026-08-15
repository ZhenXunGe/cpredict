import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { parseBuildArguments } from "./build-release-bundle.mjs";
import { parseCheckArguments } from "./check-release-bundle.mjs";
import { validReleaseGateFixture, hash } from "./release-gates-fixture.mjs";
import { REQUIRED_GATE_POLICY } from "./release-gates-common.mjs";
import { sourceManifestPaths } from "../manifest-inventory.mjs";
import {
  createReleaseBundleBytes,
  resolveReleaseOutputPath,
  validateReleaseRuntime,
  validateBundlePath,
  validateReleaseGitState,
  verifyReleaseBundleBytes,
} from "./release-bundle-common.mjs";

const COMMIT = "1".repeat(40);
const TAG_OBJECT = "2".repeat(40);

test("builds byte-identical deterministic bundles and verifies every payload", () => {
  const files = payload();
  const first = createReleaseBundleBytes({
    tag: "v1.2.3",
    tagObject: TAG_OBJECT,
    commit: COMMIT,
    files,
  });
  const second = createReleaseBundleBytes({
    tag: "v1.2.3",
    tagObject: TAG_OBJECT,
    commit: COMMIT,
    files: [...files].reverse(),
  });

  assert.deepEqual(first, second);
  const result = verifyReleaseBundleBytes(first, {
    tag: "v1.2.3",
    tagObject: TAG_OBJECT,
    commit: COMMIT,
    files,
  });
  assert.equal(result.payloadFiles, files.length);
  assert.equal(result.manifest.archive.mtime, 0);
  assert.equal(result.manifest.archive.uid, 0);
  assert.equal(result.manifest.archive.gid, 0);
});

test("rejects payload tampering even when the USTAR header remains valid", () => {
  const bundle = createReleaseBundleBytes({
    tag: "v1.2.3",
    tagObject: TAG_OBJECT,
    commit: COMMIT,
    files: payload(),
  });
  const tar = gunzipSync(bundle);
  const marker = Buffer.from("unique-release-payload-marker", "utf8");
  const offset = tar.indexOf(marker);
  assert.notEqual(offset, -1);
  tar[offset] ^= 1;

  assert.throws(
    () => verifyReleaseBundleBytes(gzipDeterministic(tar)),
    /payload SHA-256 mismatch/,
  );
});

test("rejects non-fixed USTAR metadata and symlink entries", () => {
  const bundle = createReleaseBundleBytes({
    tag: "v1.2.3",
    tagObject: TAG_OBJECT,
    commit: COMMIT,
    files: payload(),
  });
  const changedMtime = gunzipSync(bundle);
  writeOctal(changedMtime, 136, 12, 1);
  rewriteHeaderChecksum(changedMtime, 0);
  assert.throws(
    () => verifyReleaseBundleBytes(gzipDeterministic(changedMtime)),
    /mtime is not zero/,
  );

  const symlink = gunzipSync(bundle);
  symlink[156] = "2".charCodeAt(0);
  rewriteHeaderChecksum(symlink, 0);
  assert.throws(
    () => verifyReleaseBundleBytes(gzipDeterministic(symlink)),
    /non-regular entry or symlink/,
  );
});

test("rejects non-canonical gzip header fields", () => {
  const bundle = createReleaseBundleBytes({
    tag: "v1.2.3",
    tagObject: TAG_OBJECT,
    commit: COMMIT,
    files: payload(),
  });
  const changedFlags = Buffer.from(bundle);
  changedFlags[3] = 4;
  assert.throws(
    () => verifyReleaseBundleBytes(changedFlags),
    /gzip flags must be zero/,
  );

  const changedCompressionMarker = Buffer.from(bundle);
  changedCompressionMarker[8] = 0;
  assert.throws(
    () => verifyReleaseBundleBytes(changedCompressionMarker),
    /gzip compression marker must be fixed/,
  );
});

test("rejects unsafe and non-USTAR paths", () => {
  for (const path of [
    "../escape",
    "/absolute",
    "docs\\windows",
    "docs//empty",
    "docs/./dot",
    "docs/非ascii.md",
  ]) {
    assert.throws(() => validateBundlePath(path), /forbidden|unsafe/);
  }
  assert.throws(
    () => validateBundlePath(`docs/${"a".repeat(251)}`),
    /exceeds USTAR capacity/,
  );
});

test("requires a clean HEAD, annotated tag at HEAD and verified signature", () => {
  const valid = {
    dirty: "",
    head: COMMIT,
    tag: "v1.2.3",
    tagType: "tag",
    tagObject: TAG_OBJECT,
    tagCommit: COMMIT,
    signatureVerified: true,
  };
  assert.doesNotThrow(() => validateReleaseGitState(valid));
  assert.throws(
    () => validateReleaseGitState({ ...valid, dirty: "?? file" }),
    /checkout must be clean/,
  );
  assert.throws(
    () => validateReleaseGitState({ ...valid, tagType: "commit" }),
    /must be annotated/,
  );
  assert.throws(
    () => validateReleaseGitState({ ...valid, tagCommit: "3".repeat(40) }),
    /does not point at HEAD/,
  );
  assert.throws(
    () => validateReleaseGitState({ ...valid, signatureVerified: false }),
    /signature verification failed/,
  );
});

test("requires the pinned release Node runtime", () => {
  assert.doesNotThrow(() => validateReleaseRuntime("22.22.2"));
  assert.throws(
    () => validateReleaseRuntime("22.23.0"),
    /requires Node 22\.22\.2/,
  );
});

test("rejects an external-looking output whose parent symlink resolves inside the checkout", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "cpredict-release-output-"));
  t.after(async () => rm(fixture, { recursive: true, force: true }));
  const checkout = join(fixture, "checkout");
  const outsideLink = join(fixture, "outside-link");
  await mkdir(checkout);
  await symlink(checkout, outsideLink, "dir");

  await assert.rejects(
    resolveReleaseOutputPath(checkout, join(outsideLink, "bundle.tar.gz")),
    /release output must be outside checkout/,
  );
});

test("CLI parsers require explicit tag, external output/bundle, requirements source and attested gates", () => {
  assert.deepEqual(
    parseBuildArguments([
      "--tag",
      "v1.2.3",
      "--output",
      "/tmp/release.tar.gz",
      "--requirements-source",
      "/tmp/product.md",
      "--attested-gates-root",
      "/tmp/attested-gates",
    ]),
    {
      root: process.cwd(),
      tag: "v1.2.3",
      output: "/tmp/release.tar.gz",
      requirementsSource: "/tmp/product.md",
      attestedGatesRoot: "/tmp/attested-gates",
    },
  );
  assert.deepEqual(
    parseCheckArguments([
      "--tag",
      "v1.2.3",
      "--bundle",
      "/tmp/release.tar.gz",
      "--requirements-source",
      "/tmp/product.md",
      "--attested-gates-root",
      "/tmp/attested-gates",
    ]),
    {
      root: process.cwd(),
      tag: "v1.2.3",
      bundle: "/tmp/release.tar.gz",
      requirementsSource: "/tmp/product.md",
      attestedGatesRoot: "/tmp/attested-gates",
    },
  );
  assert.throws(
    () => parseBuildArguments(["--tag", "v1.2.3"]),
    /--output is required/,
  );
  assert.throws(
    () => parseCheckArguments(["--tag", "v1.2.3"]),
    /--bundle is required/,
  );
});

test("release bundle JSON schema is strict and describes fixed archive metadata", async () => {
  const schema = JSON.parse(
    await readFile(resolve("manifests/release-bundle.schema.json"), "utf8"),
  );
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.archive.additionalProperties, false);
  assert.equal(schema.properties.archive.properties.mtime.const, 0);
  assert.equal(schema.properties.archive.properties.uid.const, 0);
  assert.equal(schema.properties.archive.properties.gid.const, 0);
  assert.equal(schema.properties.files.items.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, 2);
  assert.match(schema.properties.releaseGatesSha256.pattern, /64/);
});

test("source provenance inventory includes root legal/provenance files without self-reference", async () => {
  const paths = await sourceManifestPaths(process.cwd());
  for (const path of [
    "README.md",
    "LICENSE",
    ".gitignore",
    "manifests/postgresql-tools.lock",
    "manifests/sbom.spdx.json",
    "manifests/licenses.json",
    "manifests/third-party-notices.md",
    "manifests/release-gates.config.json",
    "manifests/release-gates.schema.json",
    "manifests/release-gate-result.schema.json",
  ])
    assert(paths.includes(path), `missing source provenance path ${path}`);
  assert.equal(new Set(paths).size, paths.length);
  assert(!paths.includes("manifests/source-manifest.json"));
  assert(!paths.includes("manifests/release-gates.json"));
});

test("release construction rejects a non-PASS gate before archiving", () => {
  const files = payload();
  const index = files.find(
    (file) => file.path === "manifests/release-gates.json",
  );
  const document = JSON.parse(index.data);
  const gate = document.gates.find((item) => item.id === "solidity-viair");
  const resultFile = files.find((file) => file.path === gate.resultPath);
  const result = JSON.parse(resultFile.data);
  result.result = "FAIL";
  resultFile.data = Buffer.from(`${JSON.stringify(result)}\n`);
  gate.sha256 = hash(resultFile.data);
  index.data = Buffer.from(`${JSON.stringify(document)}\n`);
  assert.throws(
    () =>
      createReleaseBundleBytes({
        tag: "v1.2.3",
        tagObject: TAG_OBJECT,
        commit: COMMIT,
        files,
      }),
    /only PASS/,
  );
});

test("release workflows require the real 22-gate audit, distributed commercial proof, OIDC verification and external bundle root", async () => {
  const [audit, tag] = await Promise.all([
    readFile(".github/workflows/release-audit.yml", "utf8"),
    readFile(".github/workflows/release-bundle.yml", "utf8"),
  ]);
  for (const marker of [
    "trufflesecurity/trufflehog@6f3c981e7b77f235fd2702dd74af25fc4b72bf11",
    "actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d",
    "node scripts/release/aggregate-release-gates.mjs",
    "attest-release-gates:",
    "RUNNER_ENVIRONMENT: ${{ runner.environment }}",
    "commercial-load:",
    "environment: cpredict-commercial-release",
    "needs: [full-release-gates, commercial-load, history-secret-scan]",
    "Aggregate and semantically revalidate all 22 gate records",
    "release-gates/v2",
  ])
    assert(audit.includes(marker), `release audit workflow missing ${marker}`);
  assert.equal(
    (audit.match(/node scripts\/release\/run-release-gate\.mjs/g) ?? []).length,
    1,
  );
  const regularJob = audit.slice(
    audit.indexOf("  full-release-gates:"),
    audit.indexOf("\n  commercial-load:"),
  );
  const regularGateList = regularJob
    .match(/gates=\(\s*([\s\S]*?)\s*\)/)?.[1]
    .trim()
    .split(/\s+/);
  const expectedRegularGates = REQUIRED_GATE_POLICY.map((gate) => gate.id)
    .filter((id) => id !== "commercial-load" && id !== "history-secret-scan")
    .sort();
  assert.deepEqual(
    [...(regularGateList ?? [])].sort(),
    expectedRegularGates,
    "regular gate job must run exactly the 20 non-commercial-load, non-history gates",
  );
  const commercialJob = audit.slice(
    audit.indexOf("  commercial-load:"),
    audit.indexOf("\n  history-secret-scan:"),
  );
  assert(
    commercialJob.includes("node scripts/release/record-commercial-load.mjs"),
  );
  assert(!commercialJob.includes("node scripts/release/run-release-gate.mjs"));
  const attestationJob = audit.indexOf("  attest-release-gates:");
  const bootstrapFoundry = audit.indexOf(
    "bash scripts/bootstrap-foundry.sh",
    attestationJob,
  );
  const bootstrapDependencies = audit.indexOf(
    "bash scripts/bootstrap-deps.sh",
    attestationJob,
  );
  const forgeBuild = audit.indexOf(
    "FOUNDRY_PROFILE=default bash scripts/forge.sh build --force",
    attestationJob,
  );
  const generateArtifacts = audit.indexOf(
    "npm run generate:artifacts",
    attestationJob,
  );
  assert(
    attestationJob >= 0,
    "release audit workflow is missing the attestation job",
  );
  assert(
    attestationJob < bootstrapFoundry &&
      bootstrapFoundry < bootstrapDependencies &&
      bootstrapDependencies < forgeBuild &&
      forgeBuild < generateArtifacts,
    "fresh Ubuntu attestation job must bootstrap and build pinned contracts before artifact regeneration",
  );
  for (const marker of [
    "Release-Audit-Run:",
    "gh attestation verify",
    '--bundle "${attestation_bundles[0]}"',
    "--deny-self-hosted-runners",
    "node scripts/release/verify-ci-attestation.mjs",
    '--run-id "$audit_run_id"',
  ])
    assert(tag.includes(marker), `signed-tag workflow missing ${marker}`);
  assert.equal((tag.match(/--attested-gates-root/g) ?? []).length, 2);
  assert(
    !tag.includes("npm run check:release-gates\n"),
    "tag workflow must not trust a checkout-local gate index",
  );
});

function payload() {
  const source = Buffer.from('{"schemaVersion":1,"files":[]}', "utf8");
  const fixture = validReleaseGateFixture(source);
  fixture.files.set("README.md", Buffer.from("readme"));
  fixture.files.set("LICENSE", Buffer.from("license"));
  fixture.files.set("manifests/source-manifest.json", source);
  fixture.files.set("manifests/third-party-notices.md", Buffer.from("notices"));
  fixture.files.set(
    "reports/marker.txt",
    Buffer.from("unique-release-payload-marker"),
  );
  return [...fixture.files].map(([path, data]) => ({ path, data }));
}

function gzipDeterministic(tar) {
  const compressed = gzipSync(tar, { level: 9, mtime: 0 });
  compressed.writeUInt32LE(0, 4);
  compressed[9] = 255;
  return compressed;
}

function writeOctal(buffer, offset, length, value) {
  buffer.write(
    `${value.toString(8).padStart(length - 1, "0")}\0`,
    offset,
    length,
    "ascii",
  );
}

function rewriteHeaderChecksum(tar, headerOffset) {
  tar.fill(0x20, headerOffset + 148, headerOffset + 156);
  const header = tar.subarray(headerOffset, headerOffset + 512);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  tar.write(
    `${checksum.toString(8).padStart(6, "0")}\0 `,
    headerOffset + 148,
    8,
    "ascii",
  );
}
