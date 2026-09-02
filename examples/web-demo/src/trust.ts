import {
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  CANONICAL_PAYMENT_TOKEN,
  CONTRACT_KEYS,
  type ContractKey,
  type FinalManifest,
  type PaymentTokenConfig,
} from "./config.js";

export type TrustLevel = "verified" | "debug" | "blocked";
export type CheckState = "pass" | "fail" | "pending" | "skip";

export interface TrustCheck {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

export interface TrustReport {
  level: TrustLevel;
  writeEnabled: boolean;
  checks: TrustCheck[];
  addresses: ProtocolAddresses | null;
  paymentToken: PaymentTokenConfig;
  resolutionWindowSeconds: number | null;
}

export interface ProtocolAddresses {
  contracts: Record<ContractKey, Address>;
  usdc: Address;
  permit2: Address;
  entryPoint: Address;
}

export type DebugAddressInput = Record<ContractKey, string> & {
  usdc: string;
  permit2: string;
  entryPoint: string;
};

const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function IS_CPREDICT_SANDBOX_TOKEN() view returns (bool)",
]);
const factoryAbi = parseAbi([
  "function active() view returns (bool)",
  "function marketplace() view returns (address)",
  "function config() view returns (address)",
  "function emergencyController() view returns (address)",
  "function exposureGuard() view returns (address)",
  "function feeVault() view returns (address)",
  "function bondEscrow() view returns (address)",
  "function cloneImplementation() view returns (address)",
  "function fullMarketDeployer() view returns (address)",
  "function paymentToken() view returns (address)",
  "function permit2() view returns (address)",
  "function resolutionWindow() view returns (uint64)",
  "function MIN_RESOLUTION_WINDOW() view returns (uint64)",
  "function MAX_RESOLUTION_WINDOW() view returns (uint64)",
  "function dependencyFingerprint() view returns (bytes32)",
  "function activationFingerprint() view returns (bytes32)",
]);
const marketplaceAbi = parseAbi([
  "function factory() view returns (address)",
  "function emergencyController() view returns (address)",
  "function feeVault() view returns (address)",
  "function paymentToken() view returns (address)",
  "function permit2() view returns (address)",
]);

export async function verifyManifest(
  client: PublicClient,
  manifest: FinalManifest | null,
  paymentToken: PaymentTokenConfig = CANONICAL_PAYMENT_TOKEN,
): Promise<TrustReport> {
  if (manifest === null) {
    return {
      level: "blocked",
      writeEnabled: false,
      addresses: null,
      paymentToken,
      resolutionWindowSeconds: null,
      checks: [
        {
          id: "manifest",
          label: "正式发布清单",
          state: "fail",
          detail: "未加载 FINALIZED_VERIFIED 清单",
        },
      ],
    };
  }
  const checks: TrustCheck[] = [];
  const chainId = await client.getChainId();
  checks.push({
    id: "chain",
    label: "RPC 链 ID",
    state: chainId === ARBITRUM_SEPOLIA_CHAIN_ID ? "pass" : "fail",
    detail: String(chainId),
  });
  try {
    const referenceBlock = await client.getBlock({
      blockNumber: BigInt(manifest.referenceBlock.number),
    });
    const referenceHash = referenceBlock.hash?.toLowerCase() ?? "缺少哈希";
    checks.push({
      id: "reference-block",
      label: "已确认参考区块哈希",
      state:
        referenceHash === manifest.referenceBlock.hash.toLowerCase()
          ? "pass"
          : "fail",
      detail: referenceHash,
    });
  } catch (error: unknown) {
    checks.push({
      id: "reference-block",
      label: "已确认参考区块哈希",
      state: "fail",
      detail: errorMessage(error),
    });
  }

  const codeRecords = [
    ...CONTRACT_KEYS.map((key) => ({ key, record: manifest.contracts[key] })),
    { key: "usdc", record: manifest.externalContracts.usdc },
    { key: "permit2", record: manifest.externalContracts.permit2 },
    { key: "entryPoint", record: manifest.externalContracts.entryPoint },
  ];
  for (const { key, record } of codeRecords) {
    try {
      const code = await client.getCode({
        address: record.address,
        blockNumber: BigInt(manifest.referenceBlock.number),
      });
      const actual =
        code === undefined || code === "0x" ? null : keccak256(code);
      const pass =
        actual?.toLowerCase() === record.runtimeCodehash.toLowerCase();
      checks.push({
        id: `code-${key}`,
        label: `${key} 运行时代码哈希`,
        state: pass ? "pass" : "fail",
        detail: actual ?? "无合约代码",
      });
    } catch (error: unknown) {
      checks.push({
        id: `code-${key}`,
        label: `${key} 运行时代码哈希`,
        state: "fail",
        detail: errorMessage(error),
      });
    }
  }

  const addresses = addressesFromManifest(manifest);
  const resolutionWindowSeconds = await verifyWiring(
    client,
    addresses,
    paymentToken,
    checks,
  );
  const writeEnabled = checks.every((check) => check.state === "pass");
  return {
    level: writeEnabled ? "verified" : "blocked",
    writeEnabled,
    checks,
    addresses,
    paymentToken,
    resolutionWindowSeconds,
  };
}

export async function verifyDebugAddresses(
  client: PublicClient,
  input: DebugAddressInput,
  paymentToken: PaymentTokenConfig = CANONICAL_PAYMENT_TOKEN,
): Promise<TrustReport> {
  const required = Object.entries(input);
  if (required.some(([, value]) => !isAddress(value))) {
    return {
      level: "blocked",
      writeEnabled: false,
      addresses: null,
      paymentToken,
      resolutionWindowSeconds: null,
      checks: [
        {
          id: "debug-addresses",
          label: "调试地址格式",
          state: "fail",
          detail: "所有调试地址必须是有效 EVM 地址",
        },
      ],
    };
  }
  const parsed = Object.fromEntries(
    required.map(([key, value]) => [key, getAddress(value)]),
  ) as Record<keyof DebugAddressInput, Address>;
  const checks: TrustCheck[] = [];
  const chainId = await client.getChainId();
  checks.push({
    id: "chain",
    label: "RPC 链 ID",
    state: chainId === ARBITRUM_SEPOLIA_CHAIN_ID ? "pass" : "fail",
    detail: String(chainId),
  });
  for (const [key, address] of Object.entries(parsed)) {
    const code = await client.getCode({ address });
    checks.push({
      id: `debug-${key}`,
      label: `${key} 合约代码`,
      state: code !== undefined && code !== "0x" ? "pass" : "fail",
      detail:
        code === undefined || code === "0x" ? "无合约代码" : keccak256(code),
    });
  }
  const contracts = Object.fromEntries(
    CONTRACT_KEYS.map((key) => [key, parsed[key]]),
  ) as Record<ContractKey, Address>;
  const addresses: ProtocolAddresses = {
    contracts: {
      ...contracts,
      factory: parsed.factory,
      marketplace: parsed.marketplace,
      config: parsed.config,
      bondEscrow: parsed.bondEscrow,
      exposureGuard: parsed.exposureGuard,
      paymaster: parsed.paymaster,
    },
    usdc: parsed.usdc,
    permit2: parsed.permit2,
    entryPoint: parsed.entryPoint,
  };
  const resolutionWindowSeconds = await verifyWiring(
    client,
    addresses,
    paymentToken,
    checks,
  );
  const valid = checks.every((check) => check.state === "pass");
  return {
    level: valid ? "debug" : "blocked",
    writeEnabled: valid,
    checks,
    addresses,
    paymentToken,
    resolutionWindowSeconds,
  };
}

export function addressesFromManifest(
  manifest: FinalManifest,
): ProtocolAddresses {
  return {
    contracts: Object.fromEntries(
      CONTRACT_KEYS.map((key) => [key, manifest.contracts[key].address]),
    ) as Record<ContractKey, Address>,
    usdc: manifest.externalContracts.usdc.address,
    permit2: manifest.externalContracts.permit2.address,
    entryPoint: manifest.externalContracts.entryPoint.address,
  };
}

async function verifyWiring(
  client: PublicClient,
  addresses: ProtocolAddresses,
  paymentTokenConfig: PaymentTokenConfig,
  checks: TrustCheck[],
): Promise<number | null> {
  try {
    const [
      active,
      marketplace,
      config,
      emergencyController,
      exposureGuard,
      feeVault,
      bondEscrow,
      cloneImplementation,
      fullMarketDeployer,
      factoryPaymentToken,
      factoryPermit2,
      resolutionWindow,
      minResolutionWindow,
      maxResolutionWindow,
      dependency,
      activation,
      marketFactory,
      marketEmergencyController,
      marketFeeVault,
      paymentToken,
      permit2,
      decimals,
    ] = await Promise.all([
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "active",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "marketplace",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "config",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "emergencyController",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "exposureGuard",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "feeVault",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "bondEscrow",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "cloneImplementation",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "fullMarketDeployer",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "paymentToken",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "permit2",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "resolutionWindow",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "MIN_RESOLUTION_WINDOW",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "MAX_RESOLUTION_WINDOW",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "dependencyFingerprint",
      }),
      client.readContract({
        address: addresses.contracts.factory,
        abi: factoryAbi,
        functionName: "activationFingerprint",
      }),
      client.readContract({
        address: addresses.contracts.marketplace,
        abi: marketplaceAbi,
        functionName: "factory",
      }),
      client.readContract({
        address: addresses.contracts.marketplace,
        abi: marketplaceAbi,
        functionName: "emergencyController",
      }),
      client.readContract({
        address: addresses.contracts.marketplace,
        abi: marketplaceAbi,
        functionName: "feeVault",
      }),
      client.readContract({
        address: addresses.contracts.marketplace,
        abi: marketplaceAbi,
        functionName: "paymentToken",
      }),
      client.readContract({
        address: addresses.contracts.marketplace,
        abi: marketplaceAbi,
        functionName: "permit2",
      }),
      client.readContract({
        address: addresses.usdc,
        abi: erc20Abi,
        functionName: "decimals",
      }),
    ]);
    checks.push(
      check(
        "factory-active",
        "Factory 已激活",
        active === true,
        String(active),
      ),
      check(
        "factory-marketplace",
        "Factory → Marketplace",
        sameAddress(marketplace, addresses.contracts.marketplace),
        marketplace,
      ),
      check(
        "factory-config",
        "Factory → Config",
        sameAddress(config, addresses.contracts.config),
        config,
      ),
      check(
        "factory-emergency",
        "Factory → EmergencyController",
        sameAddress(
          emergencyController,
          addresses.contracts.emergencyController,
        ),
        emergencyController,
      ),
      check(
        "factory-guard",
        "Factory → ExposureGuard",
        sameAddress(exposureGuard, addresses.contracts.exposureGuard),
        exposureGuard,
      ),
      check(
        "factory-fee-vault",
        "Factory → FeeVault",
        sameAddress(feeVault, addresses.contracts.feeVault),
        feeVault,
      ),
      check(
        "factory-bond",
        "Factory → BondEscrow",
        sameAddress(bondEscrow, addresses.contracts.bondEscrow),
        bondEscrow,
      ),
      check(
        "factory-clone",
        "Factory → Clone 实现",
        sameAddress(
          cloneImplementation,
          addresses.contracts.cloneImplementation,
        ),
        cloneImplementation,
      ),
      check(
        "factory-full",
        "Factory → Full 部署器",
        sameAddress(fullMarketDeployer, addresses.contracts.fullMarketDeployer),
        fullMarketDeployer,
      ),
      check(
        "factory-token",
        `Factory → ${paymentTokenConfig.symbol}`,
        sameAddress(factoryPaymentToken, addresses.usdc),
        factoryPaymentToken,
      ),
      check(
        "factory-permit2",
        "Factory → Permit2",
        sameAddress(factoryPermit2, addresses.permit2),
        factoryPermit2,
      ),
      check(
        "factory-resolution-window",
        "Factory 结算窗口",
        resolutionWindow >= minResolutionWindow &&
          resolutionWindow <= maxResolutionWindow,
        `${resolutionWindow} 秒（允许 ${minResolutionWindow}-${maxResolutionWindow} 秒）`,
      ),
      check(
        "fingerprint",
        "Factory 依赖指纹",
        dependency === activation,
        dependency,
      ),
      check(
        "marketplace-factory",
        "Marketplace → Factory",
        sameAddress(marketFactory, addresses.contracts.factory),
        marketFactory,
      ),
      check(
        "marketplace-emergency",
        "Marketplace → EmergencyController",
        sameAddress(
          marketEmergencyController,
          addresses.contracts.emergencyController,
        ),
        marketEmergencyController,
      ),
      check(
        "marketplace-fee-vault",
        "Marketplace → FeeVault",
        sameAddress(marketFeeVault, addresses.contracts.feeVault),
        marketFeeVault,
      ),
      check(
        "marketplace-token",
        `Marketplace → ${paymentTokenConfig.symbol}`,
        sameAddress(paymentToken, addresses.usdc),
        paymentToken,
      ),
      check(
        "marketplace-permit2",
        "Marketplace → Permit2",
        sameAddress(permit2, addresses.permit2),
        permit2,
      ),
      check(
        "payment-token-decimals",
        `${paymentTokenConfig.symbol} 小数位`,
        decimals === paymentTokenConfig.decimals,
        String(decimals),
      ),
    );
    if (paymentTokenConfig.kind === "sandbox-test-token") {
      const [name, symbol, marker] = await Promise.all([
        client.readContract({
          address: addresses.usdc,
          abi: erc20Abi,
          functionName: "name",
        }),
        client.readContract({
          address: addresses.usdc,
          abi: erc20Abi,
          functionName: "symbol",
        }),
        client.readContract({
          address: addresses.usdc,
          abi: erc20Abi,
          functionName: "IS_CPREDICT_SANDBOX_TOKEN",
        }),
      ]);
      checks.push(
        check(
          "sandbox-token-name",
          "沙箱代币名称",
          name === paymentTokenConfig.name,
          name,
        ),
        check(
          "sandbox-token-symbol",
          "沙箱代币符号",
          symbol === paymentTokenConfig.symbol,
          symbol,
        ),
        check("sandbox-token-marker", "沙箱代币标记", marker === true, marker),
      );
    }
    return Number(resolutionWindow);
  } catch (error: unknown) {
    checks.push({
      id: "wiring",
      label: "关键接线 / 读取",
      state: "fail",
      detail: errorMessage(error),
    });
    return null;
  }
}

function check(
  id: string,
  label: string,
  pass: boolean,
  detail: string | boolean | bigint | Hex | Address,
): TrustCheck {
  return { id, label, state: pass ? "pass" : "fail", detail: String(detail) };
}

function sameAddress(actual: Address, expected: Address): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}
