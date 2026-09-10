import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../app-core/test/fixtures.js";
import { loadServiceConfig } from "../src/config.js";

describe("provider runtime environment binding", () => {
  let directory: string;
  const project = "00000000-0000-4000-8000-000000000001";
  const rpc = `https://rpc.zerodev.app/api/v3/${project}/chain/421614`;
  const lane = {
    projectWei: "1000",
    accountWei: "100",
    subjectWei: "100",
    projectOperations: 100,
    accountOperations: 10,
    subjectOperations: 10,
  };
  const runtime = {
    environment: { ...env },
    allowedOrigins: ["http://localhost:4198"],
    adminSubjects: [],
    sponsor: {
      projectId: project,
      providerHardLimitWei: "1000",
      providerHardLimitPeriodSeconds: 604800,
      policyOperator: "and",
      passOnError: false,
      maxCostPerOperation: "1",
      validitySeconds: 300,
      exposure: lane,
      exit: lane,
      methodDailyOperations: 10,
      weekly: {
        window: "shanghai-monday",
        projectWei: "1000",
        exitReserveWei: "200",
      },
    },
  };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "cpredict-provider-config-"));
    delete runtime.environment.walletConnectProjectId;
    await writeFile(join(directory, "runtime.json"), JSON.stringify(runtime), {
      mode: 0o600,
    });
    await writeFile(
      join(directory, "no-policy.json"),
      JSON.stringify({ ...runtime, sponsor: null }),
      { mode: 0o600 },
    );
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const variables = () => ({
    CPREDICT_APP_CONFIG_FILE: join(directory, "runtime.json"),
    CPREDICT_APP_DATABASE_URL: "postgresql://localhost/cpredict_config_test",
    CPREDICT_APP_PRIVY_SECRET: "test-only-not-a-provider-credential",
    CPREDICT_APP_RPC_URL: rpc,
    CPREDICT_APP_METADATA_URL: "http://localhost:8790",
    CPREDICT_APP_ZERODEV_BUNDLER_URL: rpc,
    CPREDICT_APP_ZERODEV_PAYMASTER_URL: rpc,
  });

  it("accepts a shared ZeroDev Bundler/Paymaster RPC and the Privy WalletConnect default", async () => {
    const loaded = await loadServiceConfig(variables());
    expect(loaded.bundlerUrl).toBe(loaded.paymasterUrl);
    expect(loaded.runtime.environment.walletConnectProjectId).toBeUndefined();
    expect(loaded.runtime.sponsor?.providerHardLimitUsd).toBeNull();
  });
  it("rejects the other project's endpoint and the wrong chain before connecting", async () => {
    for (const wrong of [
      rpc.replace(project, "00000000-0000-4000-8000-000000000002"),
      rpc.replace("421614", "42161"),
    ])
      await expect(
        loadServiceConfig({
          ...variables(),
          CPREDICT_APP_ZERODEV_PAYMASTER_URL: wrong,
        }),
      ).rejects.toThrow("must match");
  });
  it("does not turn on sponsorship merely because provider URLs and secrets exist", async () => {
    await expect(
      loadServiceConfig({
        ...variables(),
        CPREDICT_APP_CONFIG_FILE: join(directory, "no-policy.json"),
      }),
    ).rejects.toThrow("explicit hard-cap");
  });
});
