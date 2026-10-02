import { keccak256, zeroAddress, type Address, type Hex } from "viem";
import {
  submissionFailure,
  FinalValidationError,
  type SubmissionFailure,
} from "./automatic-diagnostics.js";

export type AutomationLane = "claims" | "matching";
export type AutomationEffect =
  | "payout"
  | "asset-return"
  | "market-maintenance"
  | "matching"
  | "unknown";

/** Public status must describe the effect, not merely a successful transaction. */
export function automationEffect(kind: string): AutomationEffect {
  if (
    [
      "winner",
      "early-bird",
      "refund",
      "timeout-bonus",
      "fees",
      "bond",
    ].includes(kind)
  )
    return "payout";
  if (kind.startsWith("return-listing:") || kind === "release-order")
    return "asset-return";
  if (kind === "void-timeout" || kind.startsWith("settle-bond:"))
    return "market-maintenance";
  if (kind === "match-orders") return "matching";
  return "unknown";
}

export interface AutomaticAction {
  key: string;
  owner: Address;
  kind: string;
  target: Address;
  data: Hex;
  // Matching and cleanup use the same durable sender, but do not depend on claim preferences.
  requiresClaimPreference: boolean;
  // Only sponsored escrow cleanup uses these fields. Manual exits never enter this worker.
  cleanupMarket?: Address;
  cleanupPriority?: "terminal-blocking" | "routine";
}
export type CleanupQuotaReason =
  | "cleanup_account_quota_exceeded"
  | "cleanup_market_quota_exceeded";
export class CleanupQuotaExceeded extends Error {
  constructor(readonly reason: CleanupQuotaReason) {
    super(reason);
  }
}
export class AutomationGasCapExceeded extends Error {
  constructor() {
    super("per_transaction_gas_cap_exceeded");
  }
}
export interface PreparedAutomation {
  raw: Hex;
  hash: Hex;
  nonce: bigint;
  maximumCost: bigint;
}
export interface AutomationRecord extends AutomaticAction, PreparedAutomation {
  id: string;
  state: "prepared" | "broadcasting" | "unknown" | "confirmed" | "reverted";
}
export interface AutomationReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
  blockTimestamp?: number;
}
export interface AutomationStore {
  // Session-level lock scoped to chain + signer. Lock connection must remain reserved until return.
  exclusive<T>(work: () => Promise<T>): Promise<T | undefined>;
  enabled(owner: Address): Promise<boolean>;
  pending(): Promise<AutomationRecord[]>;
  save(
    action: AutomaticAction,
    prepared: PreparedAutomation,
  ): Promise<AutomationRecord>;
  markBroadcasting(id: string, provider?: string): Promise<boolean>;
  unknown(
    id: string,
    result?: {
      outcome: "accepted" | "unknown";
      provider: string;
      failure?: SubmissionFailure;
    },
  ): Promise<void>;
  validation?(
    tx: AutomationRecord,
    provider: string,
    failure?: SubmissionFailure,
  ): Promise<void>;
  recoveryHashes?(id: string): Promise<Hex[]>;
  recoveryCheckDue?(tx: AutomationRecord): Promise<boolean>;
  cancelPrepared(id: string): Promise<void>;
  finish(id: string, receipt: AutomationReceipt, hash?: Hex): Promise<void>;
  spentToday(excludeId?: string): Promise<bigint>;
  status(owner: Address, reason: string): Promise<void>;
  cleanupQuota?(action: AutomaticAction): Promise<CleanupQuotaReason | null>;
  /** Reconcile finalized rows against the indexer's current canonical chain. */
  auditCanonical?(): Promise<AutomaticAction[]>;
}
export interface AutomationChain {
  eligible(action: AutomaticAction): Promise<boolean>;
  prepare(action: AutomaticAction): Promise<PreparedAutomation>;
  send(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<AutomationReceipt | null>;
  canonicalFinal(receipt: AutomationReceipt): Promise<boolean>;
  balance(): Promise<bigint>;
  submissionReady?(): Promise<boolean>;
  submissionProvider?(): string;
  validate?(tx: AutomationRecord): Promise<void>;
}
export interface AutomationSource {
  candidates(): AsyncIterable<AutomaticAction>;
  reject?(action: AutomaticAction, reason: string): Promise<void>;
}

/** A dedicated signer has a single durable nonce lane. Unknown outcomes block new submissions. */
export class AutomaticClaimsWorker {
  constructor(
    readonly store: AutomationStore,
    readonly chain: AutomationChain,
    readonly source: AutomationSource,
    readonly dailyBudget: bigint,
    readonly maxPerTick = 20,
    readonly maxTransactionCost = dailyBudget,
    readonly onSubmissionFailure?: (
      tx: AutomationRecord,
      failure: SubmissionFailure,
    ) => void,
    readonly recover?: (tx: AutomationRecord) => Promise<void>,
    readonly observe?: (
      phase: string,
      seconds: number,
      result: "ok" | "error",
    ) => void,
  ) {
    if (
      dailyBudget <= 0n ||
      maxPerTick < 1 ||
      maxPerTick > 100 ||
      maxTransactionCost <= 0n ||
      maxTransactionCost > dailyBudget
    )
      throw new Error("invalid_automation_budget");
  }
  async tick(): Promise<void> {
    await this.store.exclusive(async () => {
      for (const action of (await this.store.auditCanonical?.()) ?? [])
        await this.setStatus(action, "rechecking_after_reorg");
      for (const tx of await this.store.pending()) {
        // Once persisted, ALWAYS reconcile the original hash, including after opt-out.
        let confirmedHash = tx.hash;
        let receipt = await this.chain.receipt(tx.hash);
        if (!receipt)
          for (const hash of (await this.store.recoveryHashes?.(tx.id)) ?? []) {
            const oldReceipt = await this.chain.receipt(hash);
            if (oldReceipt) {
              receipt = oldReceipt;
              confirmedHash = hash;
              break;
            }
          }
        if (receipt && (await this.chain.canonicalFinal(receipt))) {
          await this.store.finish(tx.id, receipt, confirmedHash);
          await this.setStatus(
            tx,
            receipt.status === "success" ? "received" : "transaction_reverted",
          );
        } else if (tx.state === "prepared") {
          if (
            tx.requiresClaimPreference &&
            !(await this.store.enabled(tx.owner))
          ) {
            await this.store.cancelPrepared(tx.id);
            continue;
          }
          if (!(await this.chain.eligible(tx))) {
            await this.store.cancelPrepared(tx.id);
            continue;
          }
          if (tx.maximumCost > this.maxTransactionCost) {
            await this.setStatus(tx, "per_transaction_gas_cap_exceeded");
            return;
          }
          if (
            (await this.store.spentToday(tx.id)) + tx.maximumCost >
            this.dailyBudget
          ) {
            await this.setStatus(tx, "daily_gas_budget_exhausted");
            return;
          }
          if ((await this.chain.balance()) < tx.maximumCost) {
            await this.setStatus(tx, "gas_balance_insufficient");
            return;
          }
          if (!(await this.canSubmit(tx))) return;
          await this.broadcast(tx);
          return;
        } else {
          await this.setStatus(
            tx,
            receipt ? "confirming" : "checking_original_transaction",
          );
          if (
            !receipt &&
            this.recover &&
            (await this.store.recoveryCheckDue?.(tx))
          )
            await this.recover(tx);
          return;
        }
      }
      let count = 0;
      for await (const action of this.source.candidates()) {
        if (count++ >= this.maxPerTick) break;
        if (
          action.requiresClaimPreference &&
          !(await this.store.enabled(action.owner))
        ) {
          await this.source.reject?.(action, "owner_opted_out");
          continue;
        }
        try {
          if (
            !(await this.timed("chain-validation", () =>
              this.chain.eligible(action),
            ))
          ) {
            await this.source.reject?.(action, "no_entitlement");
            continue;
          }
          // Recheck preference immediately before creating a signed task.
          if (
            action.requiresClaimPreference &&
            !(await this.store.enabled(action.owner))
          ) {
            await this.source.reject?.(action, "owner_opted_out");
            continue;
          }
          if ((await this.chain.balance()) === 0n) {
            await this.setStatus(action, "gas_balance_insufficient");
            break;
          }
          if (!(await this.canSubmit(action))) break;
          const prepared = await this.timed("prepare", () =>
            this.chain.prepare(action),
          );
          if (keccak256(prepared.raw) !== prepared.hash)
            throw new Error("signed_hash_mismatch");
          if (prepared.maximumCost > this.maxTransactionCost)
            throw new AutomationGasCapExceeded();
          if (
            (await this.store.spentToday()) + prepared.maximumCost >
            this.dailyBudget
          ) {
            await this.setStatus(action, "daily_gas_budget_exhausted");
            break;
          }
          if ((await this.chain.balance()) < prepared.maximumCost) {
            await this.setStatus(action, "gas_balance_insufficient");
            break;
          }
          const tx = await this.store.save(action, prepared);
          await this.broadcast(tx);
          // Do not allocate another nonce until this transaction is canonically final.
          break;
        } catch (error) {
          // No private RPC errors or signed transaction bytes enter public status/logs.
          await this.setStatus(
            action,
            error instanceof CleanupQuotaExceeded
              ? error.reason
              : error instanceof AutomationGasCapExceeded
                ? error.message
                : "retry_after_chain_check",
            error instanceof CleanupQuotaExceeded ||
              error instanceof AutomationGasCapExceeded
              ? undefined
              : `chain_check_${submissionFailure(error).reason}`,
          );
          if ((await this.store.pending()).length) return;
          continue;
        }
      }
    });
  }
  private async canSubmit(action: AutomaticAction): Promise<boolean> {
    if (this.chain.submissionReady && !(await this.chain.submissionReady())) {
      await this.setStatus(action, "submission_rpc_unavailable");
      return false;
    }
    return true;
  }
  private async timed<T>(phase: string, work: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const result = await work();
      try {
        this.observe?.(phase, (performance.now() - start) / 1000, "ok");
      } catch {}
      return result;
    } catch (error) {
      try {
        this.observe?.(phase, (performance.now() - start) / 1000, "error");
      } catch {}
      throw error;
    }
  }
  private async broadcast(tx: AutomationRecord): Promise<void> {
    const provider = this.chain.submissionProvider?.() ?? "writer-unknown";
    try {
      await this.timed("pre-broadcast-validation", async () =>
        this.chain.validate?.(tx),
      );
      // Opt-out/budget/balance may change while the exact-writer simulation runs.
      if (tx.requiresClaimPreference && !(await this.store.enabled(tx.owner))) {
        await this.store.cancelPrepared(tx.id);
        return;
      }
      if (
        tx.maximumCost > this.maxTransactionCost ||
        (await this.store.spentToday(tx.id)) + tx.maximumCost > this.dailyBudget
      ) {
        await this.setStatus(tx, "daily_gas_budget_exhausted");
        return;
      }
      if ((await this.chain.balance()) < tx.maximumCost) {
        await this.setStatus(tx, "gas_balance_insufficient");
        return;
      }
    } catch (error) {
      await this.store.validation?.(tx, provider, submissionFailure(error));
      // Proven local validation failure happened before CAS/broadcast. Safe to
      // rediscover and sign again, including with this still-unused nonce.
      if (error instanceof FinalValidationError)
        await this.store.cancelPrepared(tx.id);
      throw error;
    }
    await this.store.validation?.(tx, provider);
    if (!(await this.store.markBroadcasting(tx.id, provider))) return;
    let result: {
      outcome: "accepted" | "unknown";
      provider: string;
      failure?: SubmissionFailure;
    } = { outcome: "accepted", provider };
    try {
      const hash = await this.timed("broadcast", () => this.chain.send(tx.raw));
      if (hash.toLowerCase() !== tx.hash.toLowerCase())
        throw new Error("broadcast_hash_mismatch");
    } catch (error) {
      result = {
        outcome: "unknown",
        provider,
        failure: submissionFailure(error),
      };
      // Diagnostics cannot change the durable unknown state or permit a retry.
      try {
        this.onSubmissionFailure?.(tx, submissionFailure(error));
      } catch {}
      throw error;
    } finally {
      // Even a connection error BEFORE a returned hash is submission-unknown, never retry with a new nonce.
      await this.store.unknown(tx.id, result);
    }
    await this.setStatus(tx, "confirming");
  }
  private async setStatus(
    action: AutomaticAction,
    reason: string,
    queueReason?: string,
  ): Promise<void> {
    const effect = automationEffect(action.kind);
    const subject = ["market-maintenance", "matching", "unknown"].includes(
      effect,
    )
      ? zeroAddress
      : action.owner;
    const finalReason =
      reason === "received"
        ? effect === "payout"
          ? "received"
          : effect === "asset-return"
            ? "assets_returned"
            : effect === "market-maintenance"
              ? "market_state_updated"
              : "operation_completed"
        : reason;
    await this.store.status(subject, finalReason);
    if (
      ![
        "received",
        "confirming",
        "checking_original_transaction",
        "rechecking_after_reorg",
      ].includes(reason)
    )
      await this.source.reject?.(action, queueReason ?? finalReason);
  }
}
