import { keccak256, type Address, type Hex } from "viem";
import {
  AppError,
  isRecoverable,
  type AppAccount,
  type Operation,
  type OperationState,
  type DepositReportQuery,
} from "../../app-core/src/contracts.js";
import type { SponsorConfig } from "../src/config.js";
import {
  assertAccountUnchanged,
  applyOperationPatch,
  assertQuota,
  assertDepositRegistration,
  depositView,
  depositActive,
  type ApplicationStore,
  type ControlChallenge,
  type OperationPatch,
  type StoredOperation,
  type StoredDeposit,
} from "../src/store.js";

/** Test double only: production always uses the transactional PostgreSQL store. */
export class MemoryApplicationStore implements ApplicationStore {
  readonly challenges = new Map<string, ControlChallenge>();
  readonly bindings = new Map<string, Set<string>>();
  readonly accountRows = new Map<string, AppAccount>();
  readonly records = new Map<string, StoredOperation>();
  readonly depositRows = new Map<string, StoredDeposit>();
  async deposit(id: string, now: string) {
    const r = this.depositRows.get(id);
    if (!r) return undefined;
    return structuredClone({
      ...r,
      deposit: depositView(
        r.deposit,
        r.deposit.operationId
          ? this.records.get(r.deposit.operationId)?.operation
          : undefined,
        now,
      ),
    });
  }
  async depositByKey(subject: string, key: string, now: string) {
    const r = [...this.depositRows.values()].find(
      (d) => d.subject === subject && d.idempotencyKey === key,
    );
    return r ? this.deposit(r.deposit.id, now) : undefined;
  }
  async createDeposit(value: StoredDeposit) {
    const old = await this.depositByKey(
      value.subject,
      value.idempotencyKey,
      value.deposit.createdAt,
    );
    if (old) {
      if (old.requestHash !== value.requestHash)
        throw new AppError("idempotency_conflict", 409);
      return old;
    }
    for (const r of this.depositRows.values()) {
      const d = (await this.deposit(r.deposit.id, value.deposit.createdAt))!
        .deposit;
      if (d.accountId === value.deposit.accountId && depositActive(d))
        throw new AppError("deposit_in_progress", 409);
    }
    this.depositRows.set(value.deposit.id, structuredClone(value));
    return structuredClone(value);
  }
  async depositPage(
    subject: string,
    accountId: string,
    now: string,
    limit: number,
    _cursor?: string,
    activeOnly = false,
  ) {
    const records = await Promise.all(
      [...this.depositRows.keys()].map((id) => this.deposit(id, now)),
    );
    return {
      items: records
        .filter(
          (r): r is StoredDeposit =>
            !!r &&
            r.subject === subject &&
            r.deposit.accountId === accountId &&
            (!activeOnly || depositActive(r.deposit)),
        )
        .map((r) => r.deposit)
        .sort(
          (a, b) =>
            b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
        )
        .slice(0, limit),
      nextCursor: null,
    };
  }
  async cancelDeposit(id: string, subject: string, now: string) {
    const r = await this.deposit(id, now);
    if (!r || r.subject !== subject)
      throw new AppError("deposit_not_found", 404);
    if (r.deposit.operationId)
      throw new AppError(
        "deposit_already_registered",
        409,
        "请查询原入金操作",
        r.deposit.operationId,
      );
    if (r.deposit.state !== "awaiting-authorization") return r;
    r.deposit = {
      ...r.deposit,
      state: "cancelled",
      updatedAt: now,
      reason: "user_cancelled_before_submission",
    };
    this.depositRows.set(id, structuredClone(r));
    return r;
  }
  async depositReport(q: DepositReportQuery, now: string) {
    const records = await Promise.all(
      [...this.depositRows.keys()].map((id) => this.deposit(id, now)),
    );
    return {
      items: records
        .map((r) => r!.deposit)
        .filter(
          (d) =>
            d.createdAt >= q.start &&
            d.createdAt < q.end &&
            (!q.accountId || d.accountId === q.accountId) &&
            (!q.id || d.id === q.id) &&
            (!q.source ||
              d.authorization.from.toLowerCase() === q.source.toLowerCase()),
        )
        .slice(0, q.limit),
      nextCursor: null,
    };
  }
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
    if (value.operation.intent.kind === "deposit-usdc") {
      const d = this.depositRows.get(value.operation.intent.depositId);
      assertDepositRegistration(d, value);
      d!.deposit = {
        ...d!.deposit,
        operationId: value.operation.id,
        state: "awaiting-signature",
        updatedAt: value.operation.updatedAt,
      };
    }
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
    r.operation = applyOperationPatch(r.operation, patch);
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
