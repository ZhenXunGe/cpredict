import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { writeGateEvidence } from "./write-gate-evidence.mjs";

const ARTIFACT_SHA = "a".repeat(64);
const verifier = fileURLToPath(
  new URL("./verify-gate-evidence.mjs", import.meta.url),
);

test("binds a passing gate to exact input and evidence hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-security-evidence."));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "reports"));
    await writeFile(join(root, "src", "A.sol"), "contract A {}\n");
    await writeFile(join(root, "reports", "gate.log"), "1,000,000 calls\n");
    const document = await writeGateEvidence({
      root,
      gate: "fuzzer",
      tool: "fuzzer",
      version: "1.2.3",
      artifactSha256: ARTIFACT_SHA,
      toolExitCode: "0",
      acceptedToolExitCodes: "0",
      validatorExitCode: "0",
      output: "reports/evidence.json",
      inputs: ["src"],
      evidence: ["reports/gate.log"],
    });
    assert.equal(document.result, "PASS");
    assert.match(document.sourceSnapshotSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      document.inputs.map((entry) => entry.path),
      ["src/A.sol"],
    );
    assert.match(
      await readFile(join(root, "reports", "evidence.json.sha256"), "utf8"),
      /^[0-9a-f]{64}  evidence\.json\n$/,
    );
    const verified = spawnSync(
      process.execPath,
      [verifier, "reports/evidence.json", "--require-pass"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.equal(verified.status, 0, verified.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifier detects source, raw evidence, sidecar, and PASS-status drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-security-evidence."));
  try {
    await writeFile(join(root, "input.sol"), "contract Input {}\n");
    await writeFile(join(root, "gate.log"), "ok\n");
    const base = {
      root,
      gate: "gate",
      tool: "tool",
      version: "1.0.0",
      artifactSha256: ARTIFACT_SHA,
      toolExitCode: "0",
      validatorExitCode: "0",
      output: "gate.json",
      inputs: ["input.sol"],
      evidence: ["gate.log"],
    };
    await writeGateEvidence(base);
    await writeFile(join(root, "input.sol"), "contract Changed {}\n");
    let result = spawnSync(process.execPath, [verifier, "gate.json"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /input (?:size|SHA-256) drift/);

    await writeFile(join(root, "input.sol"), "contract Input {}\n");
    await writeGateEvidence({
      ...base,
      toolExitCode: "101",
      validatorExitCode: "1",
    });
    result = spawnSync(
      process.execPath,
      [verifier, "gate.json", "--require-pass"],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /gate is not PASS/);

    await writeFile(
      join(root, "gate.json.sha256"),
      `${"0".repeat(64)}  gate.json\n`,
    );
    result = spawnSync(process.execPath, [verifier, "gate.json"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /sidecar mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("records crashes and validator failures as FAIL without losing hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-security-evidence."));
  try {
    await writeFile(join(root, "input.sol"), "contract Input {}\n");
    await writeFile(join(root, "crash.log"), "panic\n");
    const document = await writeGateEvidence({
      root,
      gate: "crashing-tool",
      tool: "crashing-tool",
      version: "1.0.0",
      artifactSha256: ARTIFACT_SHA,
      toolExitCode: "101",
      acceptedToolExitCodes: "0",
      validatorExitCode: "1",
      output: "evidence.json",
      inputs: ["input.sol"],
      evidence: ["crash.log"],
    });
    assert.equal(document.result, "FAIL");
    assert.equal(document.tool.rawExitCode, 101);
    assert.equal(document.validatorExitCode, 1);
    assert.match(document.evidence[0].sha256, /^[0-9a-f]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed on missing, escaping, symlinked, or empty inventories", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpredict-security-evidence."));
  try {
    await writeFile(join(root, "input.sol"), "contract Input {}\n");
    await writeFile(join(root, "evidence.log"), "ok\n");
    const base = {
      root,
      gate: "gate",
      tool: "tool",
      version: "1.0.0",
      artifactSha256: ARTIFACT_SHA,
      toolExitCode: "0",
      validatorExitCode: "0",
      output: "result.json",
      inputs: ["input.sol"],
      evidence: ["evidence.log"],
    };
    await assert.rejects(
      writeGateEvidence({ ...base, inputs: [] }),
      /input inventory is empty/,
    );
    await assert.rejects(
      writeGateEvidence({ ...base, evidence: ["missing.log"] }),
      /ENOENT/,
    );
    await assert.rejects(
      writeGateEvidence({ ...base, output: "../escape.json" }),
      /escapes repository root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
