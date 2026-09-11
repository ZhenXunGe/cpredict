import { describe, expect, it } from "vitest";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { PeerCertificate } from "node:tls";
import { developmentProxy } from "../dev-proxy.js";

describe("local user-site proxy", () => {
  it("verifies the real upstream IP certificate through CONNECT and rejects a different IP", () => {
    const proxy = developmentProxy({
      CPREDICT_SITE_REMOTE_ORIGIN: "https://192.0.2.1",
      CPREDICT_SITE_HTTPS_PROXY: "http://127.0.0.1:6152",
    });
    const agent = proxy["/site-config.json"]?.agent;
    expect(agent).toBeInstanceOf(HttpsProxyAgent);
    if (!(agent instanceof HttpsProxyAgent)) throw new Error("Missing agent");
    const check = agent.options.checkServerIdentity;
    if (!check) throw new Error("Missing upstream identity verifier");
    const certificate = {
      subjectaltname: "IP Address:192.0.2.1",
    } as PeerCertificate;
    expect(check("localhost", certificate)).toBeUndefined();
    expect(
      check("localhost", {
        ...certificate,
        subjectaltname: "IP Address:192.0.2.2",
      }),
    ).toBeInstanceOf(Error);
    expect(proxy["/site-config.json"]?.secure).toBe(true);
  });
  it("keeps local services when no remote environment is selected", () => {
    const proxy = developmentProxy({});
    expect(proxy["/site-config.json"]).toBeUndefined();
    expect(proxy["/ctusd/app"]?.target).toBe("http://127.0.0.1:8795");
    expect(proxy["/ctusd/app"]?.rewrite?.("/ctusd/app/v1/me/accounts")).toBe(
      "/v1/me/accounts",
    );
  });
  it("uses the existing remote origin for public config and complete API paths", () => {
    const proxy = developmentProxy({
      CPREDICT_DEMO_REMOTE_ORIGIN: "https://test.example",
    });
    for (const path of [
      "/site-config.json",
      "/ctusd/",
      "/usdc/",
      "/rpc",
      "/deployment/",
    ]) {
      expect(proxy[path]?.target).toBe("https://test.example");
      expect(proxy[path]?.rewrite).toBeUndefined();
      expect(proxy[path]?.secure).toBe(true);
      expect(proxy[path]?.headers).toBeUndefined();
    }
    expect(proxy["/assets/"]).toBeUndefined();
    expect(proxy["/"]).toBeUndefined();
  });
  it("prefers the user-site variable and supports an explicit loopback network proxy", () => {
    const proxy = developmentProxy({
      CPREDICT_SITE_REMOTE_ORIGIN: "https://current.example",
      CPREDICT_DEMO_REMOTE_ORIGIN: "https://legacy.example",
      CPREDICT_SITE_HTTPS_PROXY: "http://127.0.0.1:6152",
    });
    expect(proxy["/site-config.json"]?.target).toBe("https://current.example");
    expect(proxy["/site-config.json"]?.agent).toBeDefined();
    expect(proxy["/ctusd/"]?.secure).toBe(true);
  });
  it("rejects insecure targets, credentials, paths and external forward proxies", () => {
    for (const target of [
      "http://test.example",
      "https://user:pass@test.example",
      "https://test.example/api",
      "https://test.example?token=x",
      "https://test.example#fragment",
      "invalid",
    ])
      expect(() =>
        developmentProxy({ CPREDICT_SITE_REMOTE_ORIGIN: target }),
      ).toThrow(/CPREDICT_SITE_REMOTE_ORIGIN/);
    for (const proxy of [
      "http://proxy.example:8080",
      "http://user:pass@127.0.0.1:6152",
      "socks5://127.0.0.1:6152",
      "http://127.0.0.1:6152/path",
    ])
      expect(() =>
        developmentProxy({
          CPREDICT_SITE_REMOTE_ORIGIN: "https://test.example",
          CPREDICT_SITE_HTTPS_PROXY: proxy,
        }),
      ).toThrow(/CPREDICT_SITE_HTTPS_PROXY/);
  });
});
