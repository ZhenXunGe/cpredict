import { describe, expect, it } from "vitest";
import {
  createDevelopmentProxy,
  parseRemoteDevelopmentOrigin,
} from "../vite.config.js";

describe("web demo development proxy", () => {
  it("preserves the local development targets by default", () => {
    const proxy = createDevelopmentProxy(undefined);
    expect(proxy["/rpc"]?.target).toBe(
      "https://sepolia-rollup.arbitrum.io",
    );
    expect(proxy["/indexer"]?.target).toBe("http://127.0.0.1:8787");
    expect(proxy["/runtime-config.json"]).toBeUndefined();
    expect(proxy["/metadata"]).toBeUndefined();
  });

  it("routes the complete read/runtime surface through one remote HTTPS origin", () => {
    const proxy = createDevelopmentProxy("https://101.32.241.211/");
    for (const path of [
      "/runtime-config.json",
      "/deployment",
      "/rpc",
      "/indexer",
      "/metadata",
    ]) {
      expect(proxy[path]).toMatchObject({
        target: "https://101.32.241.211",
        changeOrigin: true,
        secure: true,
      });
      expect(proxy[path]?.rewrite).toBeUndefined();
    }
    expect(proxy["/indexer"]?.ws).toBe(true);
    expect(proxy["/evidence"]?.target).toBe("http://127.0.0.1:8790");
  });

  it("rejects insecure, credential-bearing and path-bearing remote values", () => {
    const credentialBearingOrigin = ["https://user", "password@remote.invalid"].join(":");
    for (const value of [
      "http://remote.invalid",
      credentialBearingOrigin,
      "https://remote.invalid/cpredict",
      "https://remote.invalid?mode=debug",
      "not-a-url",
    ]) {
      expect(() => parseRemoteDevelopmentOrigin(value)).toThrow(
        /CPREDICT_DEMO_REMOTE_ORIGIN/,
      );
    }
  });
});
