import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const root = resolve(import.meta.dirname, "../..");
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4198,
    strictPort: true,
    fs: {
      allow: [root],
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/runtime/**"],
    },
    proxy: {
      "/ctusd/app": {
        target: "http://127.0.0.1:8795",
        rewrite: (p) => p.replace(/^\/ctusd\/app/, ""),
      },
      "/ctusd/indexer": {
        target: "http://127.0.0.1:8787",
        rewrite: (p) => p.replace(/^\/ctusd\/indexer/, ""),
      },
      "/ctusd/metadata": {
        target: "http://127.0.0.1:8790",
        rewrite: (p) => p.replace(/^\/ctusd\/metadata/, ""),
      },
      "/usdc/app": {
        target: "http://127.0.0.1:8895",
        rewrite: (p) => p.replace(/^\/usdc\/app/, ""),
      },
      "/usdc/indexer": {
        target: "http://127.0.0.1:8887",
        rewrite: (p) => p.replace(/^\/usdc\/indexer/, ""),
      },
      "/usdc/metadata": {
        target: "http://127.0.0.1:8890",
        rewrite: (p) => p.replace(/^\/usdc\/metadata/, ""),
      },
    },
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
});
