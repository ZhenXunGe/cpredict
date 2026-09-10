import { keccak256, type Address, type Hex } from "viem";
import {
  AppError,
  isRecoverable,
  type AppAccount,
  type Operation,
  type OperationState,
} from "../../app-core/src/contracts.js";
import type { SponsorConfig } from "../src/config.js";
import {
  assertAccountUnchanged,
  assertQuota,
  type ApplicationStore,
  type ControlChallenge,
  type OperationPatch,
  type StoredOperation,
} from "../src/store.js";

/** Test double only: production always uses the transactional PostgreSQL store. */
export class MemoryApplicationStore implements ApplicationStore {
  readonly challenges = new Map<string, ControlChallenge>();
  readonly bindings = new Map<string, Set<string>>();
  readonly accountRows = new Map<string, AppAccount>();
  readonly records = new Map<string, StoredOperation>();
  async ready() {}
  async close() {}
  async createChallenge(c: ControlChallenge) {
    this.challenges.set(c.id, structuredClone(c));
  }
  async challenge(id: string) {
    const c = this.challenges.get(id);
    return c ? structuredClone(c) : undefined;
  }
  async bindAccount(
    challengeId: string,
    subject: string,
    value: AppAccount,
    now: string,
  ) {
    const c = this.challenges.get(challengeId);
    if (
      !c ||
      c.subject !== subject ||
      c.consumed ||
      c.controller !== value.controller ||
      c.environment !== value.environment ||
      c.deploymentId !== value.deploymentId ||
      Date.parse(c.expiresAt) <= Date.parse(now)
    )
      throw new AppError("challenge_unavailable", 409);
    const old = [...this.accountRows.values()].find(
      (a) =>
        a.controller === value.controller &&
        a.environment === value.environment &&
        a.deploymentId === value.deploymentId,
    );
    if (old) assertAccountUnchanged(old, value);
    const account = old ?? value;
    c.consumed = true;
    this.accountRows.set(account.id, structuredClone(account));
    this.bindings.set(
      subject,
      new Set([...(this.bindings.get(subject) ?? []), account.id]),
    );
    return structuredClone(account);
  }
  async accounts(subject: string) {
    return [...(this.bindings.get(subject) ?? [])].flatMap((id) =>
      this.accountRows.has(id)
        ? [structuredClone(this.accountRows.get(id)!)]
        : [],
    );
  }
  async allAccounts() {
    return [...this.accountRows.values()].map((a) => structuredClone(a));
  }
  async account(id: string, subject: string) {
    return (await this.accounts(subject)).find((a) => a.id === id);
  }
  async byKey(subject: string, key: string) {
    const r = [...this.records.values()].find(
      (r) => r.subject === subject && r.idempotencyKey === key,
    );
    return r ? structuredClone(r) : undefined;
  }
  async admit(value: StoredOperation, limits: SponsorConfig) {
    const old = [...this.records.values()].find(
      (r) =>
        r.subject === value.subject &&
        r.idempotencyKey === value.idempotencyKey,
    );
    if (old) {
      if (old.requestHash !== value.requestHash)
        throw new AppError("idempotency_conflict", 409);
      return structuredClone(old);
    }
    assertQuota([...this.records.values()], value, limits);
    this.records.set(value.operation.id, structuredClone(value));
    return structuredClone(value);
  }
  async operation(id: string) {
    const r = this.records.get(id);
    return r ? structuredClone(r) : undefined;
  }
  async operations(
    subject: string,
    limit: number,
    before?: string,
  ): Promise<Operation[]> {
    return [...this.records.values()]
      .filter(
        (r) =>
          this.bindings.get(subject)?.has(r.operation.accountId) &&
          (!before || r.operation.id < before),
      )
      .sort((a, b) => b.operation.id.localeCompare(a.operation.id))
      .slice(0, limit)
      .map((r) => structuredClone(r.operation));
  }
  async operationPage(subject: string, accountId: string, limit: number) {
    return {
      items: (await this.operations(subject, this.records.size))
        .filter((o) => o.accountId === accountId)
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        )
        .slice(0, limit),
      nextCursor: null,
    };
  }
  async pending(limit: number) {
    return [...this.records.values()]
      .filter(
        (r) =>
          isRecoverable(r.operation.state) ||
          (["confirmed", "reverted"].includes(r.operation.state) &&
            r.operation.finality !== "finalized"),
      )
      .slice(0, limit)
      .map((r) => structuredClone(r));
  }
  async policyCandidate(sender: Address, nonce: string, callData: Hex) {
    const r = [...this.records.values()].find(
      (r) =>
        r.operation.account.toLowerCase() === sender.toLowerCase() &&
        r.operation.nonce === nonce &&
        keccak256(r.operation.callData) === keccak256(callData) &&
        ["awaiting-signature", "submitted", "confirming", "unknown"].includes(
          r.operation.state,
        ),
    );
    return r ? structuredClone(r) : undefined;
  }
  async transition(
    id: string,
    from: readonly OperationState[],
    patch: OperationPatch,
  ) {
    const r = this.records.get(id);
    if (!r) throw new AppError("operation_not_found", 404);
    if (!from.includes(r.operation.state))
      return { changed: false, record: structuredClone(r) };
    r.operation = { ...r.operation, ...patch };
    return { changed: true, record: structuredClone(r) };
  }
  async report(start: string, end: string) {
    return [...this.records.values()]
      .filter(
        (r) => r.operation.createdAt >= start && r.operation.createdAt < end,
      )
      .map((r) => structuredClone(r));
  }
}
