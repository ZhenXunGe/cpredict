import {
  keccak256,
  decodeFunctionData,
  decodeFunctionResult,
  type Account,
  type PublicClient,
  type WalletClient,
  type Hex,
} from "viem";
import { automaticAbi } from "./automatic-source.js";
import type {
  AutomaticAction,
  AutomationChain,
  AutomationReceipt,
} from "./automatic-claims.js";
/** Dedicated keeper account only; user signatures, bundler and paymaster submission never enter this sender. */
export class ViemAutomationChain implements AutomationChain {
  constructor(
    readonly client: PublicClient,
    readonly wallet: WalletClient,
    readonly account: Account,
    readonly confirmations: bigint,
    readonly eligibilityGuard?: (action: AutomaticAction) => Promise<boolean>,
    readonly submissionProbe?: () => Promise<boolean>,
  ) {}
  async eligible(action: AutomaticAction): Promise<boolean> {
    if (this.eligibilityGuard && !(await this.eligibilityGuard(action)))
      return false;
    const result = await this.client.call({
      account: this.account.address,
      to: action.target,
      data: action.data,
    });
    let decoded: ReturnType<typeof decodeFunctionData<typeof automaticAbi>>;
    try {
      decoded = decodeFunctionData({ abi: automaticAbi, data: action.data });
    } catch {
      return true;
    } // Other calls already passed eth_call; invalid claim results must fail closed.
    if (
      [
        "claimFor",
        "claimWinningsFor",
        "claimEarlyBirdFor",
        "refundFor",
        "claimTimeoutBonusFor",
      ].includes(decoded.functionName)
    ) {
      if (!result.data) return false;
      return (
        BigInt(
          decodeFunctionResult({
            abi: automaticAbi,
            functionName: decoded.functionName,
            data: result.data,
          }) as bigint,
        ) > 0n
      );
    }
    return true;
  }
  async prepare(action: AutomaticAction) {
    const request = await this.wallet.prepareTransactionRequest({
      account: this.account,
      chain: this.wallet.chain,
      to: action.target,
      data: action.data,
      value: 0n,
    });
    if (request.nonce === undefined || request.gas === undefined)
      throw new Error("incomplete_automation_transaction");
    const price = request.maxFeePerGas ?? request.gasPrice;
    if (price === undefined) throw new Error("missing_automation_fee");
    const raw = await this.wallet.signTransaction({
      ...request,
      account: this.account,
      chain: this.wallet.chain,
    });
    return {
      raw,
      hash: keccak256(raw),
      nonce: BigInt(request.nonce),
      maximumCost: request.gas * price,
    };
  }
  send(raw: Hex) {
    return this.wallet.sendRawTransaction({ serializedTransaction: raw });
  }
  async receipt(hash: Hex): Promise<AutomationReceipt | null> {
    try {
      const r = await this.client.getTransactionReceipt({ hash });
      return {
        status: r.status,
        blockNumber: r.blockNumber,
        blockHash: r.blockHash,
      };
    } catch (e) {
      if (e instanceof Error && e.name === "TransactionReceiptNotFoundError")
        return null;
      throw e;
    }
  }
  async canonicalFinal(r: AutomationReceipt): Promise<boolean> {
    const head = await this.client.getBlockNumber();
    if (head < r.blockNumber + this.confirmations) return false;
    return (
      (
        await this.client.getBlock({ blockNumber: r.blockNumber })
      ).hash.toLowerCase() === r.blockHash.toLowerCase()
    );
  }
  async submissionReady(): Promise<boolean> {
    return this.submissionProbe ? this.submissionProbe() : true;
  }
  balance() {
    return this.client.getBalance({ address: this.account.address });
  }
}
