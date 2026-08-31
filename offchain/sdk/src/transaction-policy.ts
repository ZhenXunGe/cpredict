import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";

/** Every browser write uses one of these reviewed execution ceilings. */
export const gasLimitByOperation = {
  "token-approval": 150_000n,
  "operator-approval": 150_000n,
  "market-create-full": 8_000_000n,
  "market-create-clone": 600_000n,
  "market-update": 350_000n,
  "primary-buy": 300_000n,
  "primary-buy-permit2": 370_000n,
  "market-resolve": 350_000n,
  "market-void": 300_000n,
  // Arbitrum's estimate includes network overhead beyond the Solidity gas gate.
  // Keep enough room for the policy's 20% send buffer without weakening the
  // contract-side 230k implementation target.
  "listing-create": 300_000n,
  "listing-fill": 350_000n,
  "listing-fill-permit2": 430_000n,
  "listing-maintenance": 250_000n,
  claim: 250_000n,
  "bond-settlement": 300_000n,
  "exposure-sync": 250_000n,
  "sandbox-mint": 150_000n,
} as const;

export type GasPolicyOperation = keyof typeof gasLimitByOperation;

const GAS_ESTIMATE_BUFFER_NUMERATOR = 120n;
const GAS_ESTIMATE_BUFFER_DENOMINATOR = 100n;
const DEFAULT_PRIORITY_FEE_PER_GAS = 10_000_000n; // 0.01 gwei
const MAX_PRIORITY_FEE_PER_GAS = 100_000_000n; // 0.1 gwei
const MAX_TRANSACTION_FEE = 10_000_000_000_000_000n; // 0.01 ETH

export type GasPolicyErrorCode =
  | "base-fee-unavailable"
  | "gas-above-limit"
  | "fee-above-limit";

/** Raised before wallet interaction when a transaction cannot be bounded safely. */
export class GasPolicyError extends Error {
  override readonly name = "GasPolicyError";

  constructor(
    readonly code: GasPolicyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SafeTransactionRequest {
  account: Account;
  to: Address;
  data: Hex;
  value?: bigint;
}

/**
 * Produces explicit gas and EIP-1559 fee fields before the browser wallet is opened.
 * A missing or implausible RPC gas estimate falls back to the reviewed operation
 * ceiling; a fee that cannot be bounded is rejected before signing.
 */
export async function sendTransactionWithGasPolicy(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain, Account>,
  operation: GasPolicyOperation,
  request: SafeTransactionRequest,
): Promise<Hex> {
  const transaction = {
    account: request.account,
    to: request.to,
    data: request.data,
    ...(request.value === undefined ? {} : { value: request.value }),
  };
  const gasCeiling = gasLimitByOperation[operation];
  const gas = await boundedGasLimit(publicClient, transaction, gasCeiling);
  const { maxFeePerGas, maxPriorityFeePerGas } = await boundedFees(
    publicClient,
    gas,
  );

  return walletClient.sendTransaction({
    ...transaction,
    chain: walletClient.chain,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
}

async function boundedGasLimit(
  publicClient: PublicClient<Transport, Chain>,
  request: SafeTransactionRequest,
  ceiling: bigint,
): Promise<bigint> {
  let estimate: bigint;
  try {
    estimate = await publicClient.estimateGas(request);
  } catch {
    // The contract simulation already passed. A broken estimate must not be
    // delegated to the wallet; use the reviewed operation ceiling instead.
    return ceiling;
  }
  if (estimate > 0n && estimate <= ceiling) {
    const buffered =
      (estimate * GAS_ESTIMATE_BUFFER_NUMERATOR +
        GAS_ESTIMATE_BUFFER_DENOMINATOR -
        1n) /
      GAS_ESTIMATE_BUFFER_DENOMINATOR;
    return buffered > ceiling ? ceiling : buffered;
  }
  if (estimate > ceiling && estimate <= ceiling * 100n) {
    throw new GasPolicyError(
      "gas-above-limit",
      `Gas 估算 ${estimate} 超过操作安全上限 ${ceiling}，已阻止签名`,
    );
  }
  // Estimates over 100x the reviewed ceiling are treated as the known RPC
  // corruption pattern and replaced with the reviewed ceiling.
  return ceiling;
}

async function boundedFees(
  publicClient: PublicClient<Transport, Chain>,
  gas: bigint,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const latestBlock = await publicClient.getBlock({ blockTag: "latest" });
  const baseFeePerGas = latestBlock.baseFeePerGas;
  if (baseFeePerGas === null || baseFeePerGas <= 0n) {
    throw new GasPolicyError(
      "base-fee-unavailable",
      "无法读取当前基础费，已在唤起钱包前阻止交易",
    );
  }

  let suggestedMaxFeePerGas = 0n;
  let suggestedPriorityFeePerGas = DEFAULT_PRIORITY_FEE_PER_GAS;
  try {
    const estimate = await publicClient.estimateFeesPerGas({ type: "eip1559" });
    suggestedMaxFeePerGas = estimate.maxFeePerGas;
    suggestedPriorityFeePerGas = estimate.maxPriorityFeePerGas;
  } catch {
    // The latest block still gives us a deterministic safe EIP-1559 fallback.
  }

  const maxPriorityFeePerGas = clamp(
    suggestedPriorityFeePerGas,
    DEFAULT_PRIORITY_FEE_PER_GAS,
    MAX_PRIORITY_FEE_PER_GAS,
  );
  const minimumMaxFeePerGas = baseFeePerGas * 2n + maxPriorityFeePerGas;
  const maxFeePerGas =
    suggestedMaxFeePerGas > minimumMaxFeePerGas
      ? suggestedMaxFeePerGas
      : minimumMaxFeePerGas;
  const maximumCost = gas * maxFeePerGas;
  if (maximumCost > MAX_TRANSACTION_FEE) {
    throw new GasPolicyError(
      "fee-above-limit",
      `预计最大网络费超过前端安全上限 0.01 ETH（当前 ${formatEth(maximumCost)} ETH），已阻止签名`,
    );
  }
  return { maxFeePerGas, maxPriorityFeePerGas };
}

function clamp(value: bigint, minimum: bigint, maximum: bigint): bigint {
  if (value < minimum) return minimum;
  if (value > maximum) return maximum;
  return value;
}

function formatEth(value: bigint): string {
  const whole = value / 1_000_000_000_000_000_000n;
  const fraction = (value % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, "0")
    .slice(0, 6)
    .replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}
