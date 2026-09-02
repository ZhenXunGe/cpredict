import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { marketVaultAbi } from "../../sdk/src/abis.js";
import {
  normalizePermit2RelayBuyInput,
  type Permit2RelayBuyInput,
} from "../../sdk/src/permit2-relay.js";
import type { Permit2RelayServiceConfig } from "./config.js";
import {
  Permit2RelayPolicyDeniedError,
  type Permit2RelayChain,
  type RelayTransactionRequest,
} from "./types.js";

const factoryReadAbi = parseAbi([
  "function isMarket(address market) view returns (bool)",
]);
const vaultReadAbi = parseAbi([
  "function factory() view returns (address)",
  "function paymentToken() view returns (address)",
  "function permit2() view returns (address)",
  "function permit2Enabled() view returns (bool)",
]);

export class ViemPermit2RelayChain implements Permit2RelayChain {
  private readonly client: PublicClient<Transport>;

  constructor(
    private readonly config: Permit2RelayServiceConfig,
    client?: PublicClient<Transport>,
  ) {
    this.client =
      client ??
      createPublicClient({
        chain: defineChain({
          id: config.chainId,
          name: "Arbitrum Sepolia",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: { default: { http: [config.rpcUrl] } },
        }),
        transport: http(config.rpcUrl, { timeout: 5_000, retryCount: 0 }),
      });
  }

  async ready(): Promise<void> {
    const chainId = await this.client.getChainId();
    if (chainId !== this.config.chainId) throw new Error("relay RPC chain mismatch");
  }

  async prepare(
    rawInput: Permit2RelayBuyInput,
    sender: Address,
  ): Promise<RelayTransactionRequest> {
    const input = normalizePermit2RelayBuyInput(rawInput);
    this.validateStaticPolicy(input);
    const [registered, factory, paymentToken, permit2, permit2Enabled] =
      await Promise.all([
        this.client.readContract({
          address: this.config.factory,
          abi: factoryReadAbi,
          functionName: "isMarket",
          args: [input.vault],
        }),
        this.client.readContract({
          address: input.vault,
          abi: vaultReadAbi,
          functionName: "factory",
        }),
        this.client.readContract({
          address: input.vault,
          abi: vaultReadAbi,
          functionName: "paymentToken",
        }),
        this.client.readContract({
          address: input.vault,
          abi: vaultReadAbi,
          functionName: "permit2",
        }),
        this.client.readContract({
          address: input.vault,
          abi: vaultReadAbi,
          functionName: "permit2Enabled",
        }),
      ]);
    if (
      !registered ||
      getAddress(factory) !== this.config.factory ||
      getAddress(paymentToken) !== this.config.paymentToken ||
      getAddress(permit2) !== this.config.permit2 ||
      !permit2Enabled
    ) {
      throw new Permit2RelayPolicyDeniedError("vault wiring is not trusted");
    }

    const data = encodeFunctionData({
      abi: marketVaultAbi,
      functionName: "buyWithPermit2",
      args: [
        input.owner,
        input.outcomeId,
        input.desiredUnits,
        input.minimumUnits,
        input.maximumPayment,
        input.deadline,
        input.permit,
        input.signature,
      ],
    });
    const transaction = { account: sender, to: input.vault, data };
    await this.client.call(transaction);
    const estimate = await this.client.estimateGas(transaction);
    const bufferedGas = (estimate * 120n + 99n) / 100n;
    if (estimate <= 0n || bufferedGas > this.config.maxGas) {
      throw new Permit2RelayPolicyDeniedError("relay gas estimate exceeds policy");
    }
    const fees = await this.client.estimateFeesPerGas({
      chain: undefined,
      type: "eip1559",
    });
    if (
      fees.maxFeePerGas <= 0n ||
      fees.maxPriorityFeePerGas <= 0n ||
      bufferedGas * fees.maxFeePerGas > this.config.maxTransactionFee
    ) {
      throw new Permit2RelayPolicyDeniedError("relay fee exceeds policy");
    }
    return {
      chainId: this.config.chainId,
      to: input.vault,
      data,
      gas: bufferedGas,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
  }

  private validateStaticPolicy(input: Permit2RelayBuyInput): void {
    const now = BigInt(Math.floor(Date.now() / 1_000));
    const latestDeadline = now + BigInt(this.config.maxDeadlineSeconds);
    if (
      input.chainId !== BigInt(this.config.chainId) ||
      input.factory !== this.config.factory ||
      input.permit2 !== this.config.permit2 ||
      input.permit.permitted.token !== this.config.paymentToken ||
      input.permit.permitted.amount !== input.maximumPayment ||
      input.minimumUnits > input.desiredUnits ||
      input.deadline < now ||
      input.deadline > latestDeadline ||
      input.permit.deadline < input.deadline ||
      input.permit.deadline > latestDeadline
    ) {
      throw new Permit2RelayPolicyDeniedError();
    }
  }
}
