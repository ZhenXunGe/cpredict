import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

const commands = {
  k6:
    commandVersion(".tools/k6/k6", ["version"]) ??
    commandVersion("k6", ["version"]),
  anvil: commandVersion(".tools/foundry/bin/anvil", ["--version"]),
  node: process.version,
};
const availableMemoryBytes = macAvailableMemoryBytes() ?? os.freemem();
const systemMemoryFreePercent = macMemoryFreePercent();
const loadAverage = os.loadavg();
const topCpuIdlePercent = macCpuIdlePercent();
const sampledCpuIdlePercentValue =
  topCpuIdlePercent === null ? await sampledCpuIdlePercent(250) : null;
const cpuIdlePercent = topCpuIdlePercent ?? sampledCpuIdlePercentValue;
const fileDescriptors = fileDescriptorLimit();
const readiness = {
  k6Present: commands.k6 !== null,
  anvilPresent: commands.anvil !== null,
  logicalCpuAtLeast8: os.cpus().length >= 8,
  totalMemoryAtLeast16GiB: os.totalmem() >= 16 * 1024 ** 3,
  systemMemoryFreePercentAtLeast20:
    systemMemoryFreePercent === null
      ? availableMemoryBytes >= 4 * 1024 ** 3
      : systemMemoryFreePercent >= 20,
  cpuCapacityAvailable:
    cpuIdlePercent === null
      ? loadAverage[0] <= os.cpus().length * 0.75
      : cpuIdlePercent >= 30,
  fileDescriptorLimitAtLeast20000: fileDescriptors >= 20_000,
};
readiness.safeToStartFullProfile = Object.values(readiness).every(Boolean);
const result = {
  observedAt: new Date().toISOString(),
  platform: `${os.platform()}-${os.arch()}`,
  logicalCpuCount: os.cpus().length,
  totalMemoryBytes: os.totalmem(),
  freeMemoryBytes: os.freemem(),
  availableMemoryBytes,
  systemMemoryFreePercent,
  loadAverage,
  cpuIdlePercent,
  cpuIdleSource:
    topCpuIdlePercent === null ? "node-os-cpus-250ms" : "macos-top",
  fileDescriptorLimit: fileDescriptors,
  commands,
  fullProfileReadiness: readiness,
};
const encoded = `${JSON.stringify(result, null, 2)}\n`;
process.stdout.write(encoded);
if (process.env.REPORT_PATH !== undefined)
  fs.writeFileSync(process.env.REPORT_PATH, encoded);
if (
  process.env.REQUIRE_FULL_READY === "1" &&
  !readiness.safeToStartFullProfile
) {
  process.exitCode = 75;
}

function commandVersion(command, args) {
  const outcome = spawnSync(command, args, { encoding: "utf8" });
  if (outcome.error !== undefined || outcome.status !== 0) return null;
  return `${outcome.stdout}${outcome.stderr}`.trim().split("\n")[0];
}

function fileDescriptorLimit() {
  const outcome = spawnSync("zsh", ["-c", "ulimit -n"], { encoding: "utf8" });
  const parsed = Number(outcome.stdout.trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function macAvailableMemoryBytes() {
  if (os.platform() !== "darwin") return null;
  const outcome = spawnSync("vm_stat", [], { encoding: "utf8" });
  if (outcome.status !== 0) return null;
  const pageSize = Number(/page size of (\d+) bytes/.exec(outcome.stdout)?.[1]);
  if (!Number.isFinite(pageSize)) return null;
  const pages = new Map();
  for (const line of outcome.stdout.split("\n")) {
    const match =
      /^Pages (free|inactive|speculative|purgeable):\s+(\d+)\./.exec(line);
    if (match !== null) pages.set(match[1], Number(match[2]));
  }
  return ["free", "inactive", "speculative", "purgeable"].reduce(
    (sum, key) => sum + (pages.get(key) ?? 0) * pageSize,
    0,
  );
}

function macMemoryFreePercent() {
  if (os.platform() !== "darwin") return null;
  const outcome = spawnSync("memory_pressure", ["-Q"], { encoding: "utf8" });
  if (outcome.status !== 0) return null;
  const value = Number(
    /System-wide memory free percentage:\s*(\d+)%/.exec(outcome.stdout)?.[1],
  );
  return Number.isFinite(value) ? value : null;
}

function macCpuIdlePercent() {
  if (os.platform() !== "darwin") return null;
  const outcome = spawnSync("top", ["-l", "1", "-n", "0"], {
    encoding: "utf8",
  });
  if (outcome.status !== 0) return null;
  const value = Number(/CPU usage:.*?([\d.]+)% idle/.exec(outcome.stdout)?.[1]);
  return Number.isFinite(value) ? value : null;
}

async function sampledCpuIdlePercent(sampleMs) {
  const before = aggregateCpuTimes();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const after = aggregateCpuTimes();
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  if (totalDelta <= 0 || idleDelta < 0) return null;
  return Math.round((idleDelta / totalDelta) * 10_000) / 100;
}

function aggregateCpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }
  return { idle, total };
}
