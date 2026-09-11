import type { Address, Hex } from "viem";
import {
  AppError,
  isRecoverable,
  type AppAccount,
  type Operation,
  type OperationState,
  type Deposit,
  type DepositReportQuery,
} from "../../app-core/src/contracts.js";
import type { SponsorConfig } from "./config.js";
import {
  countsTowardWeek,
  budgetCharges,
  weeklyBudgetWindow,
  weeklyLaneLimit,
} from "./budget.js";

export interface ControlChallenge {
  id: string;
  subject: string;
  controller: Address;
  environment: string;
  deploymentId: string;
  message: string;
  expiresAt: string;
  consumed: boolean;
}
export interface StoredOperation {
  operation: Operation;
  subject: string;
  idempotencyKey: string;
  requestHash: Hex;
}
export interface StoredDeposit {
  deposit: Deposit;
  subject: string;
  idempotencyKey: string;
  requestHash: Hex;
}
export function depositView(
  d: Deposit,
  operation: Operation | undefined,
  now: string,
): Deposit {
  if (operation)
    return {
      ...d,
      state: operation.state,
      operationId: operation.id,
      userOperationHash: operation.userOperationHash,
      transactionHash: operation.transactionHash,
      blockNumber: operation.blockNumber,
      blockHash: operation.blockHash,
      actualGasCost: operation.actualGasCost,
      finality: operation.finality,
      reason: operation.reason,
      updatedAt: operation.updatedAt,
    };
  return d.state === "awaiting-authorization" &&
    Date.parse(d.expiresAt) <= Date.parse(now)
    ? { ...d, state: "expired", reason: "deposit_authorization_expired" }
    : d;
}
export function depositActive(d: Deposit): boolean {
  return (
    [
      "awaiting-authorization",
      "preparing",
      "awaiting-signature",
      "submitted",
      "confirming",
      "unknown",
    ].includes(d.state) ||
    (d.state === "reverted" && d.finality !== "finalized")
  );
}
export function assertDepositRegistration(
  d: StoredDeposit | undefined,
  value: StoredOperation,
): void {
  const o = value.operation,
    i = o.intent;
  if (i.kind !== "deposit-usdc") return;
  if (
    !d ||
    d.subject !== value.subject ||
    d.deposit.accountId !== o.accountId ||
    d.deposit.environment !== o.environment ||
    d.deposit.deploymentId !== o.deploymentId
  )
    throw new AppError("deposit_not_found", 404);
  if (d.deposit.operationId)
    throw new AppError(
      "deposit_already_registered",
      409,
      "请查询原入金操作",
      d.deposit.operationId,
    );
  if (
    d.deposit.state !== "awaiting-authorization" ||
    Date.parse(d.deposit.expiresAt) <= Date.parse(o.createdAt)
  )
    throw new AppError("deposit_authorization_expired", 409);
  if (
    JSON.stringify(d.deposit.authorization) !== JSON.stringify(i.authorization)
  )
    throw new AppError("deposit_authorization_mismatch", 403);
}
export type OperationPatch = Partial<
  Pick<
    Operation,
    | "state"
    | "providerOperationId"
    | "userOperationHash"
    | "transactionHash"
    | "blockNumber"
    | "blockHash"
    | "actualGasCost"
    | "updatedAt"
    | "reason"
    | "finality"
    | "sponsorshipAttempted"
    | "gasSettledAt"
  >
>;
/** Only the atomic cancellation writer can certify a grant-free cancellation. */
export function applyOperationPatch(
  old: Operation,
  patch: OperationPatch,
): Operation {
  const next = { ...old, ...patch };
  if (
    next.state === "cancelled" &&
    old.sponsorshipAttempted === false &&
    next.userOperationHash === null &&
    next.providerOperationId === null &&
    next.transactionHash === null
  )
    next.gasReleasedAt = next.gasReleasedAt ?? next.updatedAt;
  return next;
}
export interface ApplicationStore {
  ready(): Promise<void>;
  close(): Promise<void>;
  createChallenge(value: ControlChallenge): Promise<void>;
  challenge(id: string): Promise<ControlChallenge | undefined>;
  bindAccount(
    challengeId: string,
    subject: string,
    value: AppAccount,
    now: string,
  ): Promise<AppAccount>;
  accounts(subject: string): Promise<AppAccount[]>;
  allAccounts(): Promise<AppAccount[]>;
  account(id: string, subject: string): Promise<AppAccount | undefined>;
  deposit(id: string, now: string): Promise<StoredDeposit | undefined>;
  depositByKey(
    subject: string,
    key: string,
    now: string,
  ): Promise<StoredDeposit | undefined>;
  createDeposit(value: StoredDeposit): Promise<StoredDeposit>;
  depositPage(
    subject: string,
    accountId: string,
    now: string,
    limit: number,
    cursor?: string,
    activeOnly?: boolean,
  ): Promise<{ items: Deposit[]; nextCursor: string | null }>;
  depositReport(
    query: DepositReportQuery,
    now: string,
  ): Promise<{ items: Deposit[]; nextCursor: string | null }>;
  cancelDeposit(
    id: string,
    subject: string,
    now: string,
  ): Promise<StoredDeposit>;
  byKey(subject: string, key: string): Promise<StoredOperation | undefined>;
  admit(
    value: StoredOperation,
    limits: SponsorConfig,
  ): Promise<StoredOperation>;
  operation(id: string): Promise<StoredOperation | undefined>;
  operations(
    subject: string,
    limit: number,
    before?: string,
  ): Promise<Operation[]>;
  operationPage(
    subject: string,
    accountId: string,
    limit: number,
    cursor?: string,
  ): Promise<{ items: Operation[]; nextCursor: string | null }>;
  pending(limit: number): Promise<StoredOperation[]>;
  policyCandidate(
    sender: Address,
    nonce: string,
    callData: Hex,
  ): Promise<StoredOperation | undefined>;
  transition(
    id: string,
    from: readonly OperationState[],
    patch: OperationPatch,
  ): Promise<{ changed: boolean; record: StoredOperation }>;
  report(start: string, end: string): Promise<StoredOperation[]>;
}

/** Shared limits used by memory contract tests and the transactional PostgreSQL store. */
export function assertQuota(
  existing: readonly StoredOperation[],
  next: StoredOperation,
  limits: SponsorConfig,
): void {
  const o = next.operation;
  const now = Date.parse(o.createdAt),
    day = o.createdAt.slice(0, 10);
  const unfinished = existing.find(
    (v) =>
      v.operation.accountId === o.accountId &&
      v.operation.nonce === o.nonce &&
      (isRecoverable(v.operation.state) ||
        ["preparing", "awaiting-signature"].includes(v.operation.state)),
  );
  if (unfinished)
    throw new AppError(
      "operation_in_progress",
      409,
      "该账户已有待完成操作",
      unfinished.operation.id,
    );
  if (
    o.kind === "faucet" &&
    existing.some(
      (v) =>
        v.operation.accountId === o.accountId &&
        v.operation.kind === "faucet" &&
        v.operation.state !== "cancelled" &&
        Date.parse(v.operation.createdAt) > now - 86_400_000,
    )
  )
    throw new AppError("faucet_cooldown", 429);
  // Self-funded operations keep ownership, nonce and faucet restrictions, but
  // never consume the project's sponsorship money or sponsorship count quotas.
  if (o.gasPayment === "self-funded") return;
  const sponsored = existing.filter(
    (v) => v.operation.gasPayment !== "self-funded",
  );
  const charges = budgetCharges(existing.map((v) => v.operation));
  const sameDay = sponsored.filter(
    (v) =>
      v.operation.createdAt.slice(0, 10) === day && v.operation.lane === o.lane,
  );
  const cap = limits[o.lane],
    reserved = BigInt(o.maxGasCost);
  const week = weeklyBudgetWindow(o.createdAt);
  const weeklyReserved = sponsored
    .filter(
      (v) => v.operation.lane === o.lane && countsTowardWeek(v.operation, week),
    )
    .reduce((sum, v) => sum + charges.get(v.operation.id)!, 0n);
  // Reserve before issuing sponsorship. The exit allocation cannot fund exposure.
  if (weeklyReserved + reserved > weeklyLaneLimit(limits, o.lane))
    throw new AppError("sponsorship_weekly_budget_exhausted", 429);
  for (const [records, cost, count] of [
    [sameDay, cap.projectWei, cap.projectOperations],
    [
      sameDay.filter((v) => v.operation.accountId === o.accountId),
      cap.accountWei,
      cap.accountOperations,
    ],
    [
      sameDay.filter((v) => v.subject === next.subject),
      cap.subjectWei,
      cap.subjectOperations,
    ],
  ] as const) {
    if (
      records.length >= count ||
      records.reduce((sum, v) => sum + charges.get(v.operation.id)!, 0n) +
        reserved >
        BigInt(cost)
    )
      throw new AppError("sponsorship_budget_exhausted", 429);
  }
  if (
    sameDay.filter(
      (v) =>
        v.operation.accountId === o.accountId && v.operation.kind === o.kind,
    ).length >= limits.methodDailyOperations
  )
    throw new AppError("method_quota_exhausted", 429);
  if (
    sameDay.filter(
      (v) => v.subject === next.subject && v.operation.kind === o.kind,
    ).length >= limits.methodDailyOperations
  )
    throw new AppError("method_quota_exhausted", 429);
  if (o.intent.kind === "deposit-usdc") {
    const source = o.intent.authorization.from.toLowerCase();
    if (
      sameDay.filter(
        (v) =>
          v.operation.intent.kind === "deposit-usdc" &&
          v.operation.intent.authorization.from.toLowerCase() === source,
      ).length >= limits.methodDailyOperations
    )
      throw new AppError("deposit_source_quota_exhausted", 429);
  }
}

export function assertAccountUnchanged(a: AppAccount, b: AppAccount): void {
  if (
    a.address !== b.address ||
    a.controller !== b.controller ||
    a.index !== b.index ||
    a.kernelVersion !== b.kernelVersion ||
    a.entryPointVersion !== b.entryPointVersion ||
    a.deploymentId !== b.deploymentId ||
    a.environment !== b.environment
  )
    throw new AppError("account_configuration_changed", 409);
}
