import { describe, expect, it } from "vitest";
import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  parseFinalManifest,
  parseDebugAddressPackage,
  parseRuntimeConfig,
} from "../src/config.js";

const validRuntime = {
  schemaVersion: "cpredict.web-demo.runtime.v1",
  chain: {
    id: ARBITRUM_SEPOLIA_CHAIN_ID,
    name: "Arbitrum Sepolia",
    rpcPath: "/rpc",
    explorerOrigin: "https://sepolia.arbiscan.io",
  },
  deployment: {
    manifestPath: "/deployment/final.json",
    requiredStatus: "FINALIZED_VERIFIED",
    allowDebugAddresses: true,
  },
  indexer: { enabled: false, basePath: "/indexer" },
  evidence: { uploadEnabled: false, endpointPath: "/evidence" },
};

describe("web demo runtime trust configuration", () => {
  it("accepts only the frozen Arbitrum Sepolia same-origin profile", () => {
    expect(parseRuntimeConfig(validRuntime).chain.id).toBe(421614);
    expect(() => parseRuntimeConfig({ ...validRuntime, chain: { ...validRuntime.chain, id: 84532 } })).toThrow(/invalid runtime config/);
    expect(() => parseRuntimeConfig({ ...validRuntime, indexer: { enabled: true, basePath: "https://attacker.invalid" } })).toThrow(/invalid runtime config/);
  });

  it("rejects unknown fields and unfinalized manifests", () => {
    expect(() => parseRuntimeConfig({ ...validRuntime, secret: "must-not-exist" })).toThrow(/additional properties/i);
    expect(() => parseFinalManifest({ status: "PENDING", chainId: 421614 })).toThrow(/部署清单校验失败/);
  });

  it("accepts only explicit DEBUG address packages on Arbitrum Sepolia", () => {
    const address = (digit: string) => `0x${digit.repeat(40)}`;
    const contracts = Object.fromEntries([
      "timelock", "config", "emergencyController", "exposureGuard", "feeVault", "bondEscrow",
      "cloneImplementation", "fullMarketDeployer", "factory", "marketplace", "paymaster",
    ].map((key, index) => [key, address(((index + 1) % 16).toString(16))]));
    const value = {
      schemaVersion: "cpredict.deployment-addresses.v1",
      mode: "DEBUG",
      status: "DEBUG_NOT_FINALIZED",
      chainId: 421614,
      contracts,
      externalContracts: { usdc: address("c"), permit2: address("d"), entryPoint: address("e") },
    };
    expect(parseDebugAddressPackage(value).factory).toMatch(/^0x/);
    expect(() => parseDebugAddressPackage({ ...value, mode: "FINALIZED_VERIFIED" })).toThrow(/状态或链/);
  });
});
