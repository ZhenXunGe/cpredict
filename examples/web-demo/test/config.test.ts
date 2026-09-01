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
  paymentToken: {
    kind: "canonical-usdc",
    name: "USD Coin",
    symbol: "USDC",
    decimals: 6,
    faucetEnabled: false,
    faucetAmount: "0",
  },
  indexer: { enabled: false, basePath: "/indexer" },
  metadata: { enabled: true, basePath: "/metadata" },
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
      paymentToken: validRuntime.paymentToken,
    };
    expect(parseDebugAddressPackage(value).factory).toMatch(/^0x/);
    expect(() => parseDebugAddressPackage({ ...value, mode: "FINALIZED_VERIFIED" })).toThrow(/状态或链/);
    expect(() => parseDebugAddressPackage({ ...value, paymentToken: { ...validRuntime.paymentToken, symbol: "ctUSD" } })).toThrow(/支付测试币配置不一致/);
  });

  it("accepts the exact sandbox token profile only for debug runtime", () => {
    const sandbox = {
      kind: "sandbox-test-token",
      name: "Cpredict Test USD",
      symbol: "ctUSD",
      decimals: 6,
      faucetEnabled: true,
      faucetAmount: "10000000000",
    } as const;
    expect(parseRuntimeConfig({ ...validRuntime, paymentToken: sandbox }).paymentToken.symbol).toBe("ctUSD");
    expect(() => parseRuntimeConfig({
      ...validRuntime,
      deployment: { ...validRuntime.deployment, allowDebugAddresses: false },
      paymentToken: sandbox,
    })).toThrow(/finalized runtime must use canonical USDC/);
  });
});
