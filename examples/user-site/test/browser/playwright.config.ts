import { defineConfig } from "playwright/test";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../../../..");

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  retries: 0,
  outputDir: resolve(root, "reports/generated/public-site/browser-results"),
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: resolve(
          root,
          "reports/generated/public-site/browser-regression.json",
        ),
      },
    ],
  ],
  use: {
    baseURL: "http://127.0.0.1:4206",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "pc-chrome", use: { viewport: { width: 1280, height: 900 } } },
    {
      name: "narrow-viewport-only",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: [
    {
      command: "npm run site:dev -- --port 4206",
      cwd: root,
      url: "http://127.0.0.1:4206/test/browser/fixture.html",
      reuseExistingServer: false,
    },
    {
      command: "node scripts/public-site/browser-build-server.mjs",
      cwd: root,
      url: "http://127.0.0.1:4207",
      reuseExistingServer: false,
    },
  ],
});
