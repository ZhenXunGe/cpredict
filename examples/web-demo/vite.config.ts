import { resolve } from "node:path";
import { defineConfig } from "vite";

const repositoryRoot = resolve(import.meta.dirname, "../..");

export default defineConfig({
  root: import.meta.dirname,
  publicDir: resolve(import.meta.dirname, "public"),
  plugins: [
    {
      name: "cpredict-web-demo-development-csp",
      transformIndexHtml(html, context) {
        if (context.server === undefined) return html;
        return html.replace(
          "style-src 'self';",
          "style-src 'self' 'unsafe-inline';",
        );
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 4177,
    strictPort: true,
    fs: { allow: [repositoryRoot] },
    proxy: {
      "/rpc": {
        target: "https://sepolia-rollup.arbitrum.io",
        changeOrigin: true,
        rewrite: () => "/rpc",
      },
      "/indexer": {
        target: "http://127.0.0.1:8787",
        rewrite: (path) => path.replace(/^\/indexer/, ""),
      },
      "/evidence": {
        target: "http://127.0.0.1:8790",
        rewrite: (path) => path.replace(/^\/evidence/, ""),
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4178,
    strictPort: true,
  },
  build: {
    outDir: resolve(repositoryRoot, "dist/web-demo"),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
