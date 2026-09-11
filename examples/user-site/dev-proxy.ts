import { HttpsProxyAgent } from "https-proxy-agent";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { ProxyOptions } from "vite";

function origin(value: string, name: string, proxy = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an origin without credentials or a path`);
  }
  if (
    !(proxy ? ["http:", "https:"] : ["https:"]).includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (proxy && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error(
      `${name} must be a ${proxy ? "loopback HTTP(S)" : "HTTPS"} origin without credentials or a path`,
    );
  return url;
}

/** Development-only routing. Production continues to use its deployed gateway. */
export function developmentProxy(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, ProxyOptions> {
  const remote =
    env.CPREDICT_SITE_REMOTE_ORIGIN?.trim() ||
    env.CPREDICT_DEMO_REMOTE_ORIGIN?.trim();
  if (!remote) {
    return Object.fromEntries(
      [
        ["/ctusd/app", 8795],
        ["/ctusd/indexer", 8787],
        ["/ctusd/metadata", 8790],
        ["/usdc/app", 8895],
        ["/usdc/indexer", 8887],
        ["/usdc/metadata", 8890],
      ].map(([path, port]) => [
        path,
        {
          target: `http://127.0.0.1:${port}`,
          rewrite: (value: string) => value.slice(String(path).length),
        },
      ]),
    );
  }
  const upstream = origin(remote, "CPREDICT_SITE_REMOTE_ORIGIN");
  const target = upstream.origin;
  const proxy = env.CPREDICT_SITE_HTTPS_PROXY?.trim();
  const agent = proxy
    ? new HttpsProxyAgent(origin(proxy, "CPREDICT_SITE_HTTPS_PROXY", true))
    : undefined;
  const hostname = upstream.hostname.replace(/^\[|\]$/g, "");
  if (agent && isIP(hostname)) {
    // CONNECT removes host before TLS and IP targets have no SNI. Validate the
    // actual upstream IP SAN with Node's verifier, rather than its localhost fallback.
    agent.options.checkServerIdentity = (_name, certificate) =>
      checkServerIdentity(hostname, certificate);
  }
  // Keep Origin and authentication headers intact; the backend still enforces its allowlist.
  return Object.fromEntries(
    ["/site-config.json", "/ctusd/", "/usdc/", "/rpc", "/deployment/"].map(
      (path) => [
        path,
        {
          target,
          changeOrigin: true,
          secure: true,
          ws: true,
          proxyTimeout: 15000,
          timeout: 15000,
          ...(agent ? { agent } : {}),
        },
      ],
    ),
  );
}
