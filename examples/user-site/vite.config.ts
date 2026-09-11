import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { developmentProxy } from "./dev-proxy.js";
const root = resolve(import.meta.dirname, "../..");
export default defineConfig(({ command, mode }) => ({
  root: import.meta.dirname,
  envDir: root,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4198,
    strictPort: true,
    fs: {
      allow: [root],
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/runtime/**"],
    },
    proxy:
      command === "serve"
        ? developmentProxy(
            loadEnv(mode, root, [
              "CPREDICT_SITE_",
              "CPREDICT_DEMO_REMOTE_ORIGIN",
            ]),
          )
        : {},
  },
  preview: { host: "127.0.0.1", port: 4199, strictPort: true },
  build: {
    outDir: resolve(root, "dist/user-site"),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      input: {
        site: resolve(import.meta.dirname, "index.html"),
        recovery: resolve(import.meta.dirname, "recovery.html"),
      },
    },
  },
}));
