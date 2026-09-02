import { getAddress, type Address, type Hex } from "viem";
import {
  validateManifest,
  validateRuntime,
  type StandaloneValidateFunction,
} from "./generated-validators.js";

export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614 as const;

export type PaymentTokenKind = "canonical-usdc" | "sandbox-test-token";

export interface PaymentTokenConfig {
  kind: PaymentTokenKind;
  name: "USD Coin" | "Cpredict Test USD";
  symbol: "USDC" | "ctUSD";
  decimals: 6;
  faucetEnabled: boolean;
  faucetAmount: string;
}

export const CANONICAL_PAYMENT_TOKEN: PaymentTokenConfig = {
  kind: "canonical-usdc",
  name: "USD Coin",
  symbol: "USDC",
  decimals: 6,
  faucetEnabled: false,
  faucetAmount: "0",
};

export type ContractKey =
  | "timelock"
  | "config"
  | "emergencyController"
  | "exposureGuard"
  | "feeVault"
  | "bondEscrow"
  | "cloneImplementation"
  | "fullMarketDeployer"
  | "factory"
  | "marketplace"
  | "paymaster";

export const CONTRACT_KEYS: readonly ContractKey[] = [
  "timelock",
  "config",
  "emergencyController",
  "exposureGuard",
  "feeVault",
  "bondEscrow",
  "cloneImplementation",
  "fullMarketDeployer",
  "factory",
  "marketplace",
  "paymaster",
];

export interface RuntimeConfig {
  schemaVersion: "cpredict.web-demo.runtime.v1";
  chain: {
    id: typeof ARBITRUM_SEPOLIA_CHAIN_ID;
    name: "Arbitrum Sepolia";
    rpcPath: string;
    explorerOrigin: "https://sepolia.arbiscan.io";
  };
  deployment: {
    manifestPath: string;
    requiredStatus: "FINALIZED_VERIFIED";
    allowDebugAddresses: boolean;
  };
  paymentToken: PaymentTokenConfig;
  indexer: { enabled: boolean; basePath: string };
  metadata: { enabled: boolean; basePath: string };
  permit2Relay: { enabled: boolean; basePath: string };
  evidence: { uploadEnabled: boolean; endpointPath: string };
}

type RuntimeConfigInput = Omit<RuntimeConfig, "permit2Relay"> & {
  permit2Relay?: RuntimeConfig["permit2Relay"];
};

export interface CodeRecord {
  address: Address;
  runtimeCodehash: Hex;
  deploymentTx: Hex;
  deploymentBlock: number;
  deploymentBlockHash: Hex;
}

export interface FinalManifest {
  schemaVersion: "cpredict.arbitrum-sepolia.deployment.v1";
  evidenceClass: "ARBITRUM_SEPOLIA_RUNTIME";
  status: "FINALIZED_VERIFIED";
  chainId: typeof ARBITRUM_SEPOLIA_CHAIN_ID;
  network: "arbitrum-sepolia";
  generatedAt: string;
  source: {
    commit: string;
    tag: string;
    sourceManifestSha256: string;
  };
  referenceBlock: { number: number; hash: Hex; finality: "FINALIZED" };
  contracts: Record<ContractKey, CodeRecord>;
  externalContracts: {
    usdc: CodeRecord;
    permit2: CodeRecord;
    entryPoint: CodeRecord;
  };
  bootstrap: Record<string, unknown>;
  configuration: Record<string, unknown>;
  roles: Record<string, unknown>;
  canaryEvidence: Record<string, unknown>;
}

export interface LoadedRuntime {
  config: RuntimeConfig;
  manifest: FinalManifest | null;
  debugAddresses: DebugAddressInput | null;
  manifestError: string | null;
}

export type DebugAddressInput = Record<ContractKey, string> & {
  usdc: string;
  permit2: string;
  entryPoint: string;
};

const runtimeValidator =
  validateRuntime as StandaloneValidateFunction<RuntimeConfigInput>;
const manifestValidator =
  validateManifest as StandaloneValidateFunction<FinalManifest>;

export async function loadRuntime(): Promise<LoadedRuntime> {
  const configResponse = await fetch("/runtime-config.json", {
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
  });
  if (!configResponse.ok) {
    throw new Error(`runtime config HTTP ${configResponse.status}`);
  }
  if (!isJsonResponse(configResponse)) {
    throw new Error("runtime config response is not JSON");
  }
  const config = parseRuntimeConfig(await configResponse.json());
  try {
    const manifestResponse = await fetch(config.deployment.manifestPath, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
    });
    if (!manifestResponse.ok) {
      return {
        config,
        manifest: null,
        debugAddresses: null,
        manifestError: `部署清单不可用（HTTP ${manifestResponse.status}）`,
      };
    }
    if (!isJsonResponse(manifestResponse)) {
      return {
        config,
        manifest: null,
        debugAddresses: null,
        manifestError: "部署清单响应不是 JSON（可能尚未发布 final.json）",
      };
    }
    const manifestValue: unknown = await manifestResponse.json();
    if (config.deployment.allowDebugAddresses) {
      try {
        return {
          config,
          manifest: null,
          debugAddresses: parseDebugAddressPackage(
            manifestValue,
            config.paymentToken,
          ),
          manifestError:
            "DEBUG 地址包已加载；仅通过实时 code/wiring 检查后允许测试网交互",
        };
      } catch (error: unknown) {
        return {
          config,
          manifest: null,
          debugAddresses: null,
          manifestError:
            error instanceof Error ? error.message : "DEBUG 地址包校验失败",
        };
      }
    }
    try {
      return {
        config,
        manifest: parseFinalManifest(manifestValue),
        debugAddresses: null,
        manifestError: null,
      };
    } catch (error: unknown) {
      return {
        config,
        manifest: null,
        debugAddresses: null,
        manifestError:
          error instanceof Error ? error.message : "部署清单校验失败",
      };
    }
  } catch (error: unknown) {
    return {
      config,
      manifest: null,
      debugAddresses: null,
      manifestError:
        error instanceof Error ? error.message : "部署清单读取失败",
    };
  }
}

export function parseDebugAddressPackage(
  value: unknown,
  expectedPaymentToken: PaymentTokenConfig = CANONICAL_PAYMENT_TOKEN,
): DebugAddressInput {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("DEBUG 地址包必须是对象");
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== "cpredict.deployment-addresses.v1" ||
    candidate.mode !== "DEBUG" ||
    candidate.status !== "DEBUG_NOT_FINALIZED" ||
    candidate.chainId !== ARBITRUM_SEPOLIA_CHAIN_ID
  )
    throw new Error("DEBUG 地址包状态或链不正确");
  const contracts = candidate.contracts;
  const external = candidate.externalContracts;
  if (
    contracts === null ||
    typeof contracts !== "object" ||
    external === null ||
    typeof external !== "object"
  )
    throw new Error("DEBUG 地址包缺少合约地址");
  if (!samePaymentToken(candidate.paymentToken, expectedPaymentToken))
    throw new Error("DEBUG 地址包与运行配置的支付测试币配置不一致");
  const contractValues = contracts as Record<string, unknown>;
  const externalValues = external as Record<string, unknown>;
  const result = Object.fromEntries([
    ...CONTRACT_KEYS.map((key) => [
      key,
      normalizeDebugAddress(contractValues[key], key),
    ]),
    ...(["usdc", "permit2", "entryPoint"] as const).map((key) => [
      key,
      normalizeDebugAddress(externalValues[key], key),
    ]),
  ]);
  return result as DebugAddressInput;
}

function normalizeDebugAddress(value: unknown, key: string): string {
  if (typeof value !== "string") throw new Error(`DEBUG ${key} 地址无效`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`DEBUG ${key} 地址无效`);
  }
}

function isJsonResponse(response: Response): boolean {
  return (
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/json") === true
  );
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  if (!runtimeValidator(value)) {
    throw new Error(
      `invalid runtime config: ${formatErrors(runtimeValidator.errors)}`,
    );
  }
  const normalized: RuntimeConfig = {
    ...value,
    permit2Relay: value.permit2Relay ?? { enabled: false, basePath: "/relay" },
  };
  if (
    normalized.deployment.allowDebugAddresses === false &&
    normalized.paymentToken.kind !== "canonical-usdc"
  ) {
    throw new Error(
      "invalid runtime config: finalized runtime must use canonical USDC",
    );
  }
  return normalized;
}

export function parseFinalManifest(value: unknown): FinalManifest {
  if (!manifestValidator(value)) {
    throw new Error(
      `部署清单校验失败：${formatErrors(manifestValidator.errors)}`,
    );
  }
  return normalizeManifest(value);
}

export function normalizeManifest(manifest: FinalManifest): FinalManifest {
  const contracts = Object.fromEntries(
    CONTRACT_KEYS.map((key) => [key, normalizeRecord(manifest.contracts[key])]),
  ) as Record<ContractKey, CodeRecord>;
  return {
    ...manifest,
    contracts,
    externalContracts: {
      usdc: normalizeRecord(manifest.externalContracts.usdc),
      permit2: normalizeRecord(manifest.externalContracts.permit2),
      entryPoint: normalizeRecord(manifest.externalContracts.entryPoint),
    },
  };
}

function normalizeRecord(record: CodeRecord): CodeRecord {
  return { ...record, address: getAddress(record.address) };
}

function samePaymentToken(
  value: unknown,
  expected: PaymentTokenConfig,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === expected.kind &&
    candidate.name === expected.name &&
    candidate.symbol === expected.symbol &&
    candidate.decimals === expected.decimals &&
    candidate.faucetEnabled === expected.faucetEnabled &&
    candidate.faucetAmount === expected.faucetAmount
  );
}

function formatErrors(
  errors:
    readonly { instancePath: string; message?: string }[] | null | undefined,
): string {
  if (errors === null || errors === undefined || errors.length === 0) {
    return "unknown validation error";
  }
  return errors
    .slice(0, 3)
    .map(
      (error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`,
    )
    .join("; ");
}
