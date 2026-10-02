import {
  keccak256,
  decodeFunctionData,
  decodeFunctionResult,
  parseTransaction,
  recoverTransactionAddress,
  type Account,
  type PublicClient,
  type WalletClient,
  type Hex,
  type TransactionSerialized,
} from "viem";
import { automaticAbi } from "./automatic-source.js";
import { AutomationGasCapExceeded } from "./automatic-claims.js";
import type {
  AutomaticAction,
  AutomationChain,
  AutomationReceipt,
} from "./automatic-claims.js";
import type { AutomationRecord } from "./automatic-claims.js";
import { FinalValidationError } from "./automatic-diagnostics.js";

/** Arbitrum's L1 data component and execution estimate can move before inclusion.
 * Unused gas is not spent; admission still reserves the full buffered maximum. */
export function automationGasLimit(estimate: bigint): bigint {
  if (estimate <= 0n) throw new Error("invalid_automation_gas_estimate");
  return (estimate * 130n + 99n) / 100n;
}
/** Dedicated keeper account only; user signatures, bundler and paymaster submission never enter this sender. */
export class ViemAutomationChain implements AutomationChain {
  constructor(
    readonly client: PublicClient,
    readonly wallet: WalletClient,
    readonly account: Account,
    readonly confirmations: bigint,
    readonly eligibilityGuard?: (action: AutomaticAction) => Promise<boolean>,
    readonly submissionProbe?: () => Promise<boolean>,
    readonly maxTransactionCost?: bigint,
    readonly validationClient: PublicClient = client,
    readonly selectedProvider?: () => string,
    readonly receiptTime = false,
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
    request.gas = automationGasLimit(request.gas);
    const price = request.maxFeePerGas ?? request.gasPrice;
    if (price === undefined) throw new Error("missing_automation_fee");
    const maximumCost = request.gas * price;
    if (
      this.maxTransactionCost !== undefined &&
      maximumCost > this.maxTransactionCost
    )
      throw new AutomationGasCapExceeded();
    const raw = await this.wallet.signTransaction({
      ...request,
      account: this.account,
      chain: this.wallet.chain,
    });
    return {
      raw,
      hash: keccak256(raw),
      nonce: BigInt(request.nonce),
      maximumCost,
    };
  }
  async prepareRecovery(tx: AutomationRecord) {
    const original = parseTransaction(tx.raw);
    if (
      keccak256(tx.raw) !== tx.hash ||
      original.chainId !== this.wallet.chain?.id ||
      (
        await recoverTransactionAddress({
          serializedTransaction: tx.raw as TransactionSerialized,
        })
      ).toLowerCase() !== this.account.address.toLowerCase() ||
      original.nonce === undefined ||
      BigInt(original.nonce) !== tx.nonce ||
      original.to?.toLowerCase() !== tx.target.toLowerCase() ||
      original.data?.toLowerCase() !== tx.data.toLowerCase() ||
      (original.value ?? 0n) !== 0n
    )
      throw new FinalValidationError("intent_mismatch");
    const oldPrice = original.maxFeePerGas ?? original.gasPrice;
    if (!oldPrice || tx.nonce > BigInt(Number.MAX_SAFE_INTEGER))
      throw new FinalValidationError("intent_mismatch");
    const request = await this.wallet.prepareTransactionRequest({
      account: this.account,
      chain: this.wallet.chain,
      to: tx.target,
      data: tx.data,
      value: 0n,
      nonce: Number(tx.nonce),
      type: "eip1559",
    });
    if (request.gas === undefined || request.maxFeePerGas === undefined)
      throw new FinalValidationError("rejected");
    request.gas = automationGasLimit(request.gas);
    const bumped = (oldPrice * 125n + 99n) / 100n;
    if (request.maxFeePerGas < bumped) request.maxFeePerGas = bumped;
    const priority =
      ((original.maxPriorityFeePerGas ?? 0n) * 125n + 99n) / 100n || 1n;
    if ((request.maxPriorityFeePerGas ?? 0n) < priority)
      request.maxPriorityFeePerGas = priority;
    if (request.maxFeePerGas < request.maxPriorityFeePerGas!)
      request.maxFeePerGas = request.maxPriorityFeePerGas!;
    const maximumCost = request.gas * request.maxFeePerGas;
    if (
      this.maxTransactionCost !== undefined &&
      maximumCost > this.maxTransactionCost
    )
      throw new AutomationGasCapExceeded();
    const raw = await this.wallet.signTransaction({
      ...request,
      account: this.account,
      chain: this.wallet.chain,
    });
    return { raw, hash: keccak256(raw), nonce: tx.nonce, maximumCost };
  }
  send(raw: Hex) {
    return this.wallet.sendRawTransaction({ serializedTransaction: raw });
  }
  submissionProvider(): string {
    return this.selectedProvider?.() ?? "writer-unknown";
  }
  async validate(tx: AutomationRecord): Promise<void> {
    const signed = parseTransaction(tx.raw);
    const same = (a: string | null | undefined, b: string) =>
      a?.toLowerCase() === b.toLowerCase();
    if (
      keccak256(tx.raw) !== tx.hash ||
      !same(
        await recoverTransactionAddress({
          serializedTransaction: tx.raw as TransactionSerialized,
        }),
        this.account.address,
      ) ||
      signed.chainId !== this.wallet.chain?.id ||
      BigInt(signed.nonce ?? -1) !== tx.nonce ||
      !same(signed.to, tx.target) ||
      !same(signed.data, tx.data) ||
      (signed.value ?? 0n) !== 0n ||
      !signed.gas
    )
      throw new FinalValidationError("intent_mismatch");
    const price = signed.maxFeePerGas ?? signed.gasPrice;
    if (price === undefined || signed.gas * price !== tx.maximumCost)
      throw new FinalValidationError("intent_mismatch");
    const c = this.validationClient;
    const head = await c.getBlock();
    if (head.number === null || !head.hash)
      throw new FinalValidationError("rejected");
    if (
      BigInt(
        await c.getTransactionCount({
          address: this.account.address,
          blockTag: "latest",
        }),
      ) !== tx.nonce ||
      BigInt(
        await c.getTransactionCount({
          address: this.account.address,
          blockTag: "pending",
        }),
      ) !== tx.nonce
    )
      throw new FinalValidationError("nonce_changed");
    if (price < (await c.getGasPrice()))
      throw new FinalValidationError("fee_too_low");
    const args = {
      account: this.account.address,
      to: tx.target,
      data: tx.data,
      value: 0n,
      blockNumber: head.number,
    };
    const estimate = await c.estimateGas(args);
    if (estimate > signed.gas) throw new FinalValidationError("gas_limit");
    const result = await c.call({
      ...args,
      gas: signed.gas,
      ...(signed.maxFeePerGas !== undefined
        ? {
            maxFeePerGas: signed.maxFeePerGas,
            maxPriorityFeePerGas: signed.maxPriorityFeePerGas ?? 0n,
          }
        : { gasPrice: signed.gasPrice! }),
    });
    let decoded:
      | ReturnType<typeof decodeFunctionData<typeof automaticAbi>>
      | undefined;
    try {
      decoded = decodeFunctionData({ abi: automaticAbi, data: tx.data });
    } catch {
      /* Non-claim maintenance/matching calls are bounded by eth_call above. */
    }
    if (
      decoded &&
      [
        "claimFor",
        "claimWinningsFor",
        "claimEarlyBirdFor",
        "refundFor",
        "claimTimeoutBonusFor",
      ].includes(decoded.functionName)
    ) {
      try {
        if (
          !result.data ||
          BigInt(
            decodeFunctionResult({
              abi: automaticAbi,
              functionName: decoded.functionName,
              data: result.data,
            }) as bigint,
          ) <= 0n
        )
          throw new Error("empty_claim");
      } catch {
        throw new FinalValidationError("no_entitlement");
      }
    }
    if ((await c.getBlock({ blockNumber: head.number })).hash !== head.hash)
      throw new FinalValidationError("rejected");
  }
  async receipt(hash: Hex): Promise<AutomationReceipt | null> {
    try {
      const r = await this.client.getTransactionReceipt({ hash });
      return {
        status: r.status,
        blockNumber: r.blockNumber,
        blockHash: r.blockHash,
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.effectiveGasPrice,
        ...(this.receiptTime
          ? {
              blockTimestamp: Number(
                (await this.client.getBlock({ blockNumber: r.blockNumber }))
                  .timestamp,
              ),
            }
          : {}),
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
