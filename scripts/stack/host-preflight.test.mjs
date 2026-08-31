import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateHostFacts,
  parseMeminfo,
  parsePreflightArgs,
} from "./host-preflight.mjs";

const GiB = 1024 ** 3;
const ok = (detail = "ok") => ({ ok: true, detail });

function healthyFacts(overrides = {}) {
  return {
    platform: "linux",
    arch: "x64",
    nodeVersion: "v22.22.2",
    uid: 1001,
    totalMemoryBytes: 4 * GiB,
    freeDiskBytes: 60 * GiB,
    swapBytes: 2 * GiB,
    dockerCli: ok(),
    dockerDaemon: ok(),
    compose: ok(),
    composeWait: ok(),
    buildx: ok(),
    composeConfig: ok(),
    timeSync: ok(),
    gitClean: ok(),
    dockerignore: ok(),
    ...overrides,
  };
}

test("host preflight accepts the supported reproducible server shape", () => {
  const checks = evaluateHostFacts(healthyFacts());
  assert.equal(
    checks.some((check) => check.status === "FAIL"),
    false,
  );
  assert.equal(
    checks.some((check) => check.status === "WARN"),
    false,
  );
});

test("host preflight accepts Intel macOS with Docker Desktop", () => {
  const checks = evaluateHostFacts(healthyFacts({ platform: "darwin" }));
  assert.equal(
    checks.some((check) => check.status === "FAIL"),
    false,
  );
});

test("host preflight fails before deployment on unsupported or unsafe hosts", () => {
  const checks = evaluateHostFacts(
    healthyFacts({
      platform: "darwin",
      arch: "arm64",
      nodeVersion: "v24.0.0",
      uid: 0,
      totalMemoryBytes: 2 * GiB,
      dockerDaemon: { ok: false, detail: "unavailable" },
      timeSync: { ok: false, detail: "NTPSynchronized=no" },
      gitClean: { ok: false, detail: "changes present" },
    }),
  );
  assert.deepEqual(
    checks
      .filter((check) => check.status === "FAIL")
      .map((check) => check.name),
    [
      "architecture",
      "Node.js",
      "unprivileged operator",
      "memory",
      "Docker daemon",
      "NTP synchronization",
      "clean Git worktree",
    ],
  );
});

test("host preflight warns on undersized operational headroom", () => {
  const checks = evaluateHostFacts(
    healthyFacts({ freeDiskBytes: 30 * GiB, swapBytes: 0 }),
  );
  assert.deepEqual(
    checks
      .filter((check) => check.status === "WARN")
      .map((check) => check.name),
    ["free disk", "swap"],
  );
});

test("preflight parser separates host and runtime/network checks", () => {
  assert.deepEqual(parsePreflightArgs([]), {
    phase: "host",
    network: false,
    sponsorship: false,
  });
  assert.deepEqual(
    parsePreflightArgs(["runtime", "--network", "--sponsorship"]),
    {
      phase: "runtime",
      network: true,
      sponsorship: true,
    },
  );
  assert.throws(
    () => parsePreflightArgs(["--network"]),
    /requires the runtime phase/,
  );
  assert.throws(
    () => parsePreflightArgs(["host", "runtime"]),
    /only one preflight phase/,
  );
  assert.equal(
    parseMeminfo("MemTotal: 1 kB\nSwapTotal:       2097148 kB\n"),
    2097148 * 1024,
  );
});
