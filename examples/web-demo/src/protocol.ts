import {
  formatUnits,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

const vaultReadAbi = parseAbi([
  "function creator() view returns (address)",
  "function creatorTreasury() view returns (address)",
  "function rulesHash() view returns (bytes32)",
  "function outcomeCount() view returns (uint8)",
  "function createdAt() view returns (uint64)",
  "function closeAt() view returns (uint64)",
  "function earlyBirdStart() view returns (uint64)",
  "function featureFlags() view returns (uint256)",
  "function perUserPrimaryCap() view returns (uint128)",
  "function marketPrimaryCap() view returns (uint128)",
  "function minimumPrimaryUnits() view returns (uint128)",
  "function minimumC2CUnits() view returns (uint128)",
  "function creatorBond() view returns (uint128)",
  "function marketState() view returns (uint8)",
  "function winningOutcome() view returns (uint8)",
  "function totalPrincipal() view returns (uint256)",
  "function resolutionDeadline() view returns (uint256)",
  "function permit2Enabled() view returns (bool)",
  "function earlyBirdEnabled() view returns (bool)",
  "function balanceOf(address account,uint256 id) view returns (uint256)",
  "function cumulativePrimaryBought(address user) view returns (uint256)",
  "function earlyBirdScore(address user) view returns (uint256)",
]);

const erc20ReadAbi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const configReadAbi = parseAbi([
  "function creationFee() view returns (uint128)",
  "function protocolShareBps() view returns (uint16)",
  "function earlyBirdShareBps() view returns (uint16)",
  "function platformC2CFeeBps() view returns (uint16)",
  "function maxFullMarketCap() view returns (uint128)",
  "function maxCloneMarketCap() view returns (uint128)",
]);

const paymasterReadAbi = parseAbi([
  "function getDeposit() view returns (uint256)",
  "function maxCostPerOperation() view returns (uint256)",
  "function maxCostPerUserPerDay() view returns (uint256)",
  "function maxCostGlobalPerDay() view returns (uint256)",
  "function policyVersion() view returns (uint32)",
]);

export interface MarketSnapshot {
  address: Address;
  creator: Address;
  creatorTreasury: Address;
  rulesHash: Hex;
  outcomeCount: number;
  createdAt: bigint;
  closeAt: bigint;
  earlyBirdStart: bigint;
  featureFlags: bigint;
  perUserPrimaryCap: bigint;
  marketPrimaryCap: bigint;
  minimumPrimaryUnits: bigint;
  minimumC2CUnits: bigint;
  creatorBond: bigint;
  marketState: number;
  winningOutcome: number;
  totalPrincipal: bigint;
  resolutionDeadline: bigint;
  permit2Enabled: boolean;
  earlyBirdEnabled: boolean;
}

export interface AccountSnapshot {
  usdcBalance: bigint;
  factoryAllowance: bigint;
  vaultAllowance: bigint;
  marketplaceAllowance: bigint;
  positions: bigint[];
  cumulativePrimaryBought: bigint;
  earlyBirdScore: bigint;
}

export interface ProtocolSnapshot {
  creationFee: bigint;
  protocolShareBps: number;
  earlyBirdShareBps: number;
  platformC2CFeeBps: number;
  maxFullMarketCap: bigint;
  maxCloneMarketCap: bigint;
  paymasterDeposit: bigint;
  paymasterPolicyVersion: number;
  paymasterBudgets: readonly [bigint, bigint, bigint];
}

export async function readMarket(client: PublicClient, address: Address): Promise<MarketSnapshot> {
  const values = await client.multicall({
    allowFailure: false,
    contracts: [
      "creator", "creatorTreasury", "rulesHash", "outcomeCount", "createdAt", "closeAt",
      "earlyBirdStart", "featureFlags", "perUserPrimaryCap", "marketPrimaryCap",
      "minimumPrimaryUnits", "minimumC2CUnits", "creatorBond", "marketState",
      "winningOutcome", "totalPrincipal", "resolutionDeadline", "permit2Enabled", "earlyBirdEnabled",
    ].map((functionName) => ({ address, abi: vaultReadAbi, functionName })) as never,
  });
  return {
    address,
    creator: values[0] as Address,
    creatorTreasury: values[1] as Address,
    rulesHash: values[2] as Hex,
    outcomeCount: Number(values[3]),
    createdAt: values[4] as bigint,
    closeAt: values[5] as bigint,
    earlyBirdStart: values[6] as bigint,
    featureFlags: values[7] as bigint,
    perUserPrimaryCap: values[8] as bigint,
    marketPrimaryCap: values[9] as bigint,
    minimumPrimaryUnits: values[10] as bigint,
    minimumC2CUnits: values[11] as bigint,
    creatorBond: values[12] as bigint,
    marketState: Number(values[13]),
    winningOutcome: Number(values[14]),
    totalPrincipal: values[15] as bigint,
    resolutionDeadline: values[16] as bigint,
    permit2Enabled: values[17] as boolean,
    earlyBirdEnabled: values[18] as boolean,
  };
}

export async function readAccount(
  client: PublicClient,
  account: Address,
  market: MarketSnapshot,
  usdc: Address,
  factory: Address,
  marketplace: Address,
): Promise<AccountSnapshot> {
  const [usdcBalance, factoryAllowance, vaultAllowance, marketplaceAllowance, cumulativePrimaryBought, earlyBirdScore] = await Promise.all([
    client.readContract({ address: usdc, abi: erc20ReadAbi, functionName: "balanceOf", args: [account] }),
    client.readContract({ address: usdc, abi: erc20ReadAbi, functionName: "allowance", args: [account, factory] }),
    client.readContract({ address: usdc, abi: erc20ReadAbi, functionName: "allowance", args: [account, market.address] }),
    client.readContract({ address: usdc, abi: erc20ReadAbi, functionName: "allowance", args: [account, marketplace] }),
    client.readContract({ address: market.address, abi: vaultReadAbi, functionName: "cumulativePrimaryBought", args: [account] }),
    client.readContract({ address: market.address, abi: vaultReadAbi, functionName: "earlyBirdScore", args: [account] }),
  ]);
  const positions = await Promise.all(
    Array.from({ length: market.outcomeCount }, (_, outcomeId) =>
      client.readContract({ address: market.address, abi: vaultReadAbi, functionName: "balanceOf", args: [account, BigInt(outcomeId)] }),
    ),
  );
  return { usdcBalance, factoryAllowance, vaultAllowance, marketplaceAllowance, positions, cumulativePrimaryBought, earlyBirdScore };
}

export async function readPaymentTokenBalance(
  client: PublicClient,
  account: Address,
  paymentToken: Address,
): Promise<bigint> {
  return client.readContract({
    address: paymentToken,
    abi: erc20ReadAbi,
    functionName: "balanceOf",
    args: [account],
  });
}

export async function readProtocol(
  client: PublicClient,
  config: Address,
  paymaster: Address,
): Promise<ProtocolSnapshot> {
  const [creationFee, protocolShareBps, earlyBirdShareBps, platformC2CFeeBps, maxFullMarketCap, maxCloneMarketCap, paymasterDeposit, operation, userDay, globalDay, policyVersion] = await Promise.all([
    client.readContract({ address: config, abi: configReadAbi, functionName: "creationFee" }),
    client.readContract({ address: config, abi: configReadAbi, functionName: "protocolShareBps" }),
    client.readContract({ address: config, abi: configReadAbi, functionName: "earlyBirdShareBps" }),
    client.readContract({ address: config, abi: configReadAbi, functionName: "platformC2CFeeBps" }),
    client.readContract({ address: config, abi: configReadAbi, functionName: "maxFullMarketCap" }),
    client.readContract({ address: config, abi: configReadAbi, functionName: "maxCloneMarketCap" }),
    client.readContract({ address: paymaster, abi: paymasterReadAbi, functionName: "getDeposit" }),
    client.readContract({ address: paymaster, abi: paymasterReadAbi, functionName: "maxCostPerOperation" }),
    client.readContract({ address: paymaster, abi: paymasterReadAbi, functionName: "maxCostPerUserPerDay" }),
    client.readContract({ address: paymaster, abi: paymasterReadAbi, functionName: "maxCostGlobalPerDay" }),
    client.readContract({ address: paymaster, abi: paymasterReadAbi, functionName: "policyVersion" }),
  ]);
  return { creationFee, protocolShareBps, earlyBirdShareBps, platformC2CFeeBps, maxFullMarketCap, maxCloneMarketCap, paymasterDeposit, paymasterPolicyVersion: policyVersion, paymasterBudgets: [operation, userDay, globalDay] };
}

export function formatPaymentToken(value: bigint, symbol: string): string {
  return `${formatUnits(value, 6)} ${symbol}`;
}

export function formatShareUnits(value: bigint): string {
  return `${formatUnits(value, 6)} shares`;
}

export const MARKET_STATE_LABELS = ["OPEN", "RESOLVED", "VOIDED_CREATOR", "VOIDED_TIMEOUT"] as const;
