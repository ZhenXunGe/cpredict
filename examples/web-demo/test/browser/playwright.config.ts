import { defineConfig } from "playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir:
    process.env.CPREDICT_BROWSER_OUTPUT ??
    join(tmpdir(), "cpredict-lightweight-ux-results"),
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4197",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chrome", use: { viewport: { width: 1280, height: 900 } } },
    {
      name: "mobile-chrome",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "npm run demo:dev -- --port 4197",
    url: "http://127.0.0.1:4197/test/browser/lightweight-ux.html",
    reuseExistingServer: false,
  },
});
