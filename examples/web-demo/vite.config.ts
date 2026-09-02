import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const REMOTE_DEVELOPMENT_ORIGIN_ENV = "CPREDICT_DEMO_REMOTE_ORIGIN";

export function createDevelopmentProxy(
  remoteOriginValue = process.env[REMOTE_DEVELOPMENT_ORIGIN_ENV],
): Record<string, ProxyOptions> {
  const remoteOrigin = parseRemoteDevelopmentOrigin(remoteOriginValue);
  if (remoteOrigin === null) {
    return {
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
    };
  }

  const remote = (): ProxyOptions => ({
    target: remoteOrigin,
    changeOrigin: true,
    secure: true,
  });
  return {
    "/runtime-config.json": remote(),
    "/deployment": remote(),
    "/rpc": remote(),
    "/indexer": { ...remote(), ws: true },
    "/metadata": remote(),
    "/evidence": {
      target: "http://127.0.0.1:8790",
      rewrite: (path) => path.replace(/^\/evidence/, ""),
    },
  };
}

export function parseRemoteDevelopmentOrigin(
  value: string | undefined,
): string | null {
  const candidate = value?.trim() ?? "";
  if (candidate === "") return null;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(
      `${REMOTE_DEVELOPMENT_ORIGIN_ENV} must be an absolute HTTPS origin`,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `${REMOTE_DEVELOPMENT_ORIGIN_ENV} must be an HTTPS origin without credentials, path, query or fragment`,
    );
  }
  return url.origin;
}

export default defineConfig(({ mode }) => {
  const developmentEnvironment = loadEnv(
    mode,
    repositoryRoot,
    "CPREDICT_DEMO_",
  );
  return {
    root: import.meta.dirname,
    publicDir: resolve(import.meta.dirname, "public"),
    plugins: [
      react(),
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
      proxy: createDevelopmentProxy(
        developmentEnvironment[REMOTE_DEVELOPMENT_ORIGIN_ENV],
      ),
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
  };
});
