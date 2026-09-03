import { keccak256, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_KEYS,
  type CodeRecord,
  type ContractKey,
  type FinalManifest,
  type PaymentTokenConfig,
} from "../src/config.js";
import { verifyDebugAddresses, verifyManifest } from "../src/trust.js";

const addresses = Object.fromEntries(
  CONTRACT_KEYS.map((key, index) => [key, address(index + 1)]),
) as Record<ContractKey, Address>;
const usdc = address(100);
const permit2 = address(101);
const entryPoint = address(102);
const code = "0x6000" as Hex;
const codehash = keccak256(code);
const blockHash = `0x${"ab".repeat(32)}` as Hex;
const fingerprint = `0x${"cd".repeat(32)}` as Hex;

describe("web demo write-gate verification", () => {
  it("requires the finalized block hash, every codehash and all Factory/Marketplace wiring", async () => {
    const report = await verifyManifest(client(), manifest());
    expect(report.level).toBe("verified");
    expect(report.writeEnabled).toBe(true);
    expect(report.resolutionWindowSeconds).toBe(900);
    expect(report.checks.every((check) => check.state === "pass")).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      "reference-block",
      "factory-config",
      "factory-clone",
      "factory-full",
      "marketplace-emergency",
      "marketplace-fee-vault",
      "factory-resolution-window",
    ]));
  });

  it("fails closed when the manifest reference block does not match the RPC", async () => {
    const value = manifest();
    value.referenceBlock.hash = `0x${"ef".repeat(32)}`;
    const report = await verifyManifest(client(), value);
    expect(report.level).toBe("blocked");
    expect(report.writeEnabled).toBe(false);
    expect(report.checks.find((check) => check.id === "reference-block")?.state).toBe("fail");
  });

  it("rejects incomplete debug address input before any chain call", async () => {
    const report = await verifyDebugAddresses(client(), {
      ...Object.fromEntries(CONTRACT_KEYS.map((key) => [key, ""])),
      usdc,
      permit2,
      entryPoint,
    } as Parameters<typeof verifyDebugAddresses>[1]);
    expect(report.level).toBe("blocked");
    expect(report.checks).toEqual([
      expect.objectContaining({ id: "debug-addresses", state: "fail" }),
    ]);
  });

  it("requires the explicit marker and metadata for a sandbox payment token", async () => {
    const sandbox: PaymentTokenConfig = {
      kind: "sandbox-test-token",
      name: "Cpredict Test USD",
      symbol: "ctUSD",
      decimals: 6,
      faucetEnabled: true,
      faucetAmount: "10000000000",
    };
    const report = await verifyDebugAddresses(client(), {
      ...addresses,
      usdc,
      permit2,
      entryPoint,
    }, sandbox);
    expect(report.level).toBe("debug");
    expect(report.paymentToken.symbol).toBe("ctUSD");
    expect(report.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "sandbox-token-marker", state: "pass" }),
    ]));
  });

  it("checks every DEBUG address code concurrently before verifying wiring", async () => {
    const publicClient = client();
    let activeReads = 0;
    let peakReads = 0;
    const originalGetCode = publicClient.getCode.bind(publicClient);
    (publicClient as unknown as { getCode: typeof publicClient.getCode }).getCode = async (input) => {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await Promise.resolve();
      activeReads -= 1;
      return originalGetCode(input);
    };

    const report = await verifyDebugAddresses(publicClient, {
      ...addresses,
      usdc,
      permit2,
      entryPoint,
    });

    expect(report.writeEnabled).toBe(true);
    expect(peakReads).toBe(Object.keys({ ...addresses, usdc, permit2, entryPoint }).length);
  });
});

function client(): PublicClient {
  return {
    getChainId: async () => 421614,
    getBlock: async () => ({ hash: blockHash }),
    getCode: async () => code,
    readContract: async ({ address: target, functionName }: { address: Address; functionName: string }) => {
      if (functionName === "active") return true;
      if (functionName === "resolutionWindow" || functionName === "MIN_RESOLUTION_WINDOW") return 900n;
      if (functionName === "MAX_RESOLUTION_WINDOW") return 2_592_000n;
      if (functionName === "dependencyFingerprint" || functionName === "activationFingerprint") return fingerprint;
      if (functionName === "decimals") return 6;
      if (functionName === "name") return "Cpredict Test USD";
      if (functionName === "symbol") return "ctUSD";
      if (functionName === "IS_CPREDICT_SANDBOX_TOKEN") return true;
      if (target.toLowerCase() === addresses.factory.toLowerCase()) {
        const factoryValues: Record<string, Address> = {
          marketplace: addresses.marketplace,
          config: addresses.config,
          emergencyController: addresses.emergencyController,
          exposureGuard: addresses.exposureGuard,
          feeVault: addresses.feeVault,
          bondEscrow: addresses.bondEscrow,
          cloneImplementation: addresses.cloneImplementation,
          fullMarketDeployer: addresses.fullMarketDeployer,
          paymentToken: usdc,
          permit2,
        };
        return factoryValues[functionName];
      }
      const marketplaceValues: Record<string, Address> = {
        factory: addresses.factory,
        emergencyController: addresses.emergencyController,
        feeVault: addresses.feeVault,
        paymentToken: usdc,
        permit2,
      };
      return marketplaceValues[functionName];
    },
  } as unknown as PublicClient;
}

function manifest(): FinalManifest {
  return {
    schemaVersion: "cpredict.arbitrum-sepolia.deployment.v1",
    evidenceClass: "ARBITRUM_SEPOLIA_RUNTIME",
    status: "FINALIZED_VERIFIED",
    chainId: 421614,
    network: "arbitrum-sepolia",
    generatedAt: "2026-08-17T00:00:00.000Z",
    source: { commit: "a".repeat(40), tag: "audit-v1", sourceManifestSha256: "b".repeat(64) },
    referenceBlock: { number: 1, hash: blockHash, finality: "FINALIZED" },
    contracts: Object.fromEntries(
      CONTRACT_KEYS.map((key) => [key, record(addresses[key])]),
    ) as Record<ContractKey, CodeRecord>,
    externalContracts: {
      usdc: record(usdc),
      permit2: record(permit2),
      entryPoint: record(entryPoint),
    },
    bootstrap: {},
    configuration: {},
    roles: {},
    canaryEvidence: {},
  };
}

function record(value: Address): CodeRecord {
  return {
    address: value,
    runtimeCodehash: codehash,
    deploymentTx: `0x${"12".repeat(32)}`,
    deploymentBlock: 1,
    deploymentBlockHash: blockHash,
  };
}

function address(value: number): Address {
  return `0x${value.toString(16).padStart(40, "0")}` as Address;
}
