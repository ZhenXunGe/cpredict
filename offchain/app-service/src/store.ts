import type { Address, Hex } from "viem";
import {
  AppError,
  isRecoverable,
  type AppAccount,
  type Operation,
  type OperationState,
} from "../../app-core/src/contracts.js";
import type { SponsorConfig } from "./config.js";
import {
  countsTowardWeek,
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
  >
>;
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
  const sameDay = existing.filter(
    (v) =>
      v.operation.createdAt.slice(0, 10) === day && v.operation.lane === o.lane,
  );
  const cap = limits[o.lane],
    reserved = BigInt(o.maxGasCost);
  const week = weeklyBudgetWindow(o.createdAt);
  const weeklyReserved = existing
    .filter(
      (v) => v.operation.lane === o.lane && countsTowardWeek(v.operation, week),
    )
    .reduce((sum, v) => sum + BigInt(v.operation.maxGasCost), 0n);
  // Reserve the maximum before sponsorship; unknown/reverted/cancelled records
  // never release it automatically. The exit allocation cannot fund exposure.
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
      records.reduce((sum, v) => sum + BigInt(v.operation.maxGasCost), 0n) +
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
