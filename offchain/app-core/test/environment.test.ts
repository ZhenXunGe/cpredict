import { describe, expect, it } from "vitest";
import {
  environmentSchema,
  siteConfigSchema,
  uint,
  positive,
} from "../src/contracts.js";
import { env } from "./fixtures.js";

describe("optional Privy WalletConnect project override", () => {
  const { walletConnectProjectId: _override, ...defaultEnvironment } = env;

  it("accepts a site that delegates WalletConnect configuration to Privy", () => {
    const site = siteConfigSchema.parse({
      version: 1,
      defaultEnvironment: env.id,
      environments: [defaultEnvironment],
    });
    expect(site.environments[0]).not.toHaveProperty("walletConnectProjectId");
  });

  it("preserves an explicit project while rejecting an empty override", () => {
    expect(environmentSchema.parse(env).walletConnectProjectId).toBe(
      env.walletConnectProjectId,
    );
    expect(
      environmentSchema.safeParse({ ...env, walletConnectProjectId: "  " })
        .success,
    ).toBe(false);
  });
  it("reports malformed integer configuration without throwing a BigInt exception", () => {
    for (const value of [
      "CONFIGURE_DEPLOYMENT_BLOCK",
      "1.5",
      "-1",
      "0x123",
      "",
      (2n ** 256n).toString(),
    ]) {
      expect(uint.safeParse(value).success).toBe(false);
      expect(positive.safeParse(value).success).toBe(false);
      expect(
        environmentSchema.safeParse({
          ...env,
          deployment: { ...env.deployment, deploymentBlock: value },
        }).success,
      ).toBe(false);
    }
    expect(positive.safeParse("0").success).toBe(false);
    expect(uint.parse((2n ** 256n - 1n).toString())).toBe(
      (2n ** 256n - 1n).toString(),
    );
  });
});
