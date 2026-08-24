import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { scanText } from "./scan-delivery-secrets.mjs";

const scanner = fileURLToPath(
  new URL("./scan-delivery-secrets.mjs", import.meta.url),
);

async function createRepository() {
  const directory = await mkdtemp(join(tmpdir(), "cpredict-secret-scan."));
  assert.equal(
    spawnSync("git", ["init", "--quiet"], { cwd: directory }).status,
    0,
  );
  return directory;
}

function runScanner(directory) {
  return spawnSync(process.execPath, [scanner], {
    cwd: directory,
    encoding: "utf8",
  });
}

async function writeBinaryAllowlist(directory, rows) {
  await mkdir(join(directory, "manifests"), { recursive: true });
  await writeFile(
    join(directory, "manifests", "binary-evidence.lock"),
    `# path | bytes | sha256 | normalization\n${rows.join("\n")}\n`,
    "utf8",
  );
}

function allowlistRow(path, payload, overrides = {}) {
  const bytes = overrides.bytes ?? payload.length;
  const hash =
    overrides.sha256 ?? createHash("sha256").update(payload).digest("hex");
  const normalization = overrides.normalization ?? "remove-nul-padding";
  return `${path} | ${bytes} | ${hash} | ${normalization}`;
}

test("detects credential classes without returning secret values", () => {
  const privateKey = ["11".repeat(32)].join("");
  const githubToken = ["gh", "p_", "a".repeat(40)].join("");
  const findings = scanText(
    [
      `DEPLOYER_KEY=0x${privateKey}`,
      githubToken,
      "MNEMONIC=" + "word ".repeat(11) + "word",
    ].join("\n"),
  );
  assert.deepEqual(findings, ["github-token", "hex-private-key", "mnemonic"]);
  assert(!JSON.stringify(findings).includes(privateKey));
  assert(!JSON.stringify(findings).includes(githubToken));
});

test("allows explicit placeholders but flags a material generic assignment", () => {
  const apiKeyName = ["API", "KEY"].join("_");
  const clientSecretName = ["CLIENT", "SECRET"].join("_");
  assert.deepEqual(
    scanText(`${apiKeyName}=\${API_KEY}\n${clientSecretName}=<replace-me>`),
    [],
  );
  assert.deepEqual(scanText(`${apiKeyName}=${"material".repeat(4)}`), [
    "assigned-secret",
  ]);
  assert.deepEqual(scanText(`${apiKeyName}=test-${"material".repeat(4)}`), [
    "assigned-secret",
  ]);
  assert.deepEqual(
    scanText(`${clientSecretName}=dummy-production-${"x".repeat(20)}`),
    ["assigned-secret"],
  );
});

test("CLI scans the Git delivery inventory and redacts matched values", async () => {
  const directory = await createRepository();
  try {
    await writeFile(
      join(directory, "safe.env.example"),
      "API_KEY=${API_KEY}\n",
      "utf8",
    );
    const safe = runScanner(directory);
    assert.equal(safe.status, 0, safe.stderr);
    assert.match(
      safe.stdout,
      /1 delivery payloads scanned total, including 0 .* normalized/,
    );

    const binaryPath = join(directory, "opaque.bin");
    await writeFile(
      binaryPath,
      Buffer.concat([Buffer.alloc(9_000, 65), Buffer.from([0])]),
    );
    const binary = runScanner(directory);
    assert.equal(binary.status, 1);
    assert.match(binary.stderr, /opaque\.bin \[binary-not-scanned\]/);
    await rm(binaryPath);

    const secret = "22".repeat(32);
    await writeFile(
      join(directory, "leak.env"),
      `PRIVATE_KEY=0x${secret}\n`,
      "utf8",
    );
    const unsafe = runScanner(directory);
    assert.equal(unsafe.status, 1);
    assert.match(unsafe.stderr, /leak\.env \[hex-private-key\]/);
    assert(!unsafe.stderr.includes(secret));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI excludes tracked files deleted from the working-tree delivery inventory", async () => {
  const directory = await createRepository();
  try {
    await writeFile(join(directory, "retired.env"), "API_KEY=${API_KEY}\n", "utf8");
    assert.equal(
      spawnSync("git", ["add", "retired.env"], { cwd: directory }).status,
      0,
    );
    await rm(join(directory, "retired.env"));
    await writeFile(join(directory, "replacement.env"), "API_KEY=${API_KEY}\n", "utf8");

    const result = runScanner(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 delivery payloads scanned total/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI counts an allowlisted normalized payload within the inventory total", async () => {
  const directory = await createRepository();
  try {
    const payload = Buffer.from(
      "retained anvil output\0with safe content\n",
      "utf8",
    );
    await writeFile(join(directory, "anvil.log"), payload);
    await writeBinaryAllowlist(directory, [allowlistRow("anvil.log", payload)]);

    const result = runScanner(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      "delivery secret scan passed: 2 delivery payloads scanned total, including 1 path/size/SHA-pinned binary payload normalized, 0 files skipped\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI fails closed when an allowlisted binary size or hash drifts", async () => {
  const directory = await createRepository();
  try {
    const payload = Buffer.from("safe\0binary\n", "utf8");
    await writeFile(join(directory, "anvil.log"), payload);

    await writeBinaryAllowlist(directory, [
      allowlistRow("anvil.log", payload, { bytes: payload.length + 1 }),
    ]);
    const sizeDrift = runScanner(directory);
    assert.equal(sizeDrift.status, 1);
    assert.match(sizeDrift.stderr, /anvil\.log \[binary-allowlist-drift\]/);

    await writeBinaryAllowlist(directory, [
      allowlistRow("anvil.log", payload, { sha256: "0".repeat(64) }),
    ]);
    const hashDrift = runScanner(directory);
    assert.equal(hashDrift.status, 1);
    assert.match(hashDrift.stderr, /anvil\.log \[binary-allowlist-drift\]/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI rejects unused allowlist rows and unsupported normalization", async () => {
  const directory = await createRepository();
  try {
    const payload = Buffer.from("safe\0binary\n", "utf8");
    await writeFile(join(directory, "anvil.log"), payload);
    await writeBinaryAllowlist(directory, [
      allowlistRow("anvil.log", payload, {
        normalization: "strip-all-control-bytes",
      }),
    ]);
    const unsupported = runScanner(directory);
    assert.equal(unsupported.status, 1);
    assert.match(
      unsupported.stderr,
      /anvil\.log \[binary-normalization-unsupported\]/,
    );

    await rm(join(directory, "anvil.log"));
    await writeBinaryAllowlist(directory, [
      allowlistRow("missing.log", payload),
    ]);
    const unused = runScanner(directory);
    assert.equal(unused.status, 1);
    assert.match(
      unused.stderr,
      /missing\.log \[binary-allowlist-entry-not-used\]/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI scans normalized content and still redacts a detected secret", async () => {
  const directory = await createRepository();
  try {
    const secret = "44".repeat(32);
    const text = Buffer.from(`PRIVATE_KEY=0x${secret}\n`, "utf8");
    const payload = Buffer.from([...text].flatMap((byte) => [byte, 0]));
    await writeFile(join(directory, "anvil.log"), payload);
    await writeBinaryAllowlist(directory, [allowlistRow("anvil.log", payload)]);

    const result = runScanner(directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /anvil\.log \[hex-private-key\]/);
    assert(!result.stderr.includes(secret));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
