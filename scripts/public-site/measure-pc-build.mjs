// Cold local production-build measurements. This does not measure wallet login,
// provider latency, a deployed CDN, or a physical mobile device.
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "../..");
const label = process.argv[2] ?? "current";
if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error("Invalid report label");
const server = fork(
  resolve(import.meta.dirname, "browser-build-server.mjs"),
  [],
  {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  },
);
let browser;
const samples = [];
const bundle = new Map();
try {
  await new Promise((done, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Build server startup timeout")),
      10000,
    );
    const finish = (error) => {
      clearTimeout(timer);
      error ? reject(error) : done();
    };
    server.once("error", finish);
    server.once("exit", () =>
      finish(new Error("Build server exited before measurement")),
    );
    server.once("message", (value) => {
      if (value?.type === "ready") finish();
    });
  });
  browser = await chromium.launch({ channel: "chrome" });
  for (const [path, title] of [
    ["/", "公开测试站尚未开放"],
    ["/recovery.html", "独立账户恢复与退出"],
  ]) {
    for (let run = 1; run <= 3; run++) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route(/^https?:\/\/(?!127\.0\.0\.1:4207\/)/, (route) =>
          route.abort(),
        );
        await page.addInitScript(() => {
          window.__cpredictPerformance = { lcp: null, cls: 0, longTasks: [] };
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              window.__cpredictPerformance.lcp = entry.startTime;
          }).observe({ type: "largest-contentful-paint", buffered: true });
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (!entry.hadRecentInput)
                window.__cpredictPerformance.cls += entry.value;
            }
          }).observe({ type: "layout-shift", buffered: true });
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              window.__cpredictPerformance.longTasks.push(entry.duration);
          }).observe({ type: "longtask", buffered: true });
        });
        await page.goto(`http://127.0.0.1:4207${path}`, { waitUntil: "load" });
        await page.getByRole("heading", { name: title, exact: true }).waitFor();
        const measurements = await page.evaluate(async () => {
          await new Promise((done) =>
            requestAnimationFrame(() => requestAnimationFrame(done)),
          );
          const resources = performance
            .getEntriesByType("resource")
            .map((entry) => ({
              path: new URL(entry.name).pathname,
              encodedBytes: entry.encodedBodySize,
              decodedBytes: entry.decodedBodySize,
              durationMs: entry.duration,
            }));
          return {
            readyMs: performance.now(),
            fcpMs:
              performance.getEntriesByName("first-contentful-paint")[0]
                ?.startTime ?? null,
            ...window.__cpredictPerformance,
            resources,
          };
        });
        if (errors.length)
          throw new Error(`Browser errors: ${errors.join(", ")}`);
        for (const resource of measurements.resources) {
          if (!resource.path.startsWith("/assets/")) continue;
          const bytes = await readFile(
            resolve(root, "dist/user-site", resource.path.slice(1)),
          );
          bundle.set(resource.path, {
            path: resource.path,
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
        }
        samples.push({ path, run, ...measurements });
      } finally {
        await context.close();
      }
    }
  }
  const report = {
    schemaVersion: 1,
    label,
    observedAt: new Date().toISOString(),
    scope:
      "Local Chrome cold builds with unconfigured entry and independent recovery; no login, wallet, CDN, RPC or mobile acceptance",
    browser: browser.version(),
    samples,
    bundle: [...bundle.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
  const directory = resolve(root, "reports/generated/public-site");
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, `pc-build-${label}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  for (const path of ["/", "/recovery.html"]) {
    const selected = samples.filter((sample) => sample.path === path);
    const median = (values) => values.sort((a, b) => a - b)[1];
    console.log(
      JSON.stringify({
        path,
        readyMedianMs: median(selected.map((s) => s.readyMs)),
        fcpMedianMs: median(selected.map((s) => s.fcpMs)),
        jsBytes: selected[0].resources
          .filter((r) => r.path.endsWith(".js"))
          .reduce((total, r) => total + r.decodedBytes, 0),
        scope: report.scope,
      }),
    );
  }
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((done) => server.once("exit", done));
  }
}
