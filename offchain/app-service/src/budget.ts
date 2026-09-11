import {
  isRecoverable,
  type BudgetLane,
  type Operation,
} from "../../app-core/src/contracts.js";
import type { SponsorConfig } from "./config.js";

const DAY = 86_400_000;
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;

/** Fixed Asia/Shanghai Monday [start,end), independent of host/DB timezone. */
export function weeklyBudgetWindow(at: string | Date): {
  start: Date;
  end: Date;
} {
  const instant = new Date(at);
  if (!Number.isFinite(instant.getTime()))
    throw new Error("invalid budget time");
  const local = new Date(instant.getTime() + SHANGHAI_OFFSET);
  const localMidnight = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
  );
  const daysSinceMonday = (local.getUTCDay() + 6) % 7;
  const start = new Date(
    localMidnight - daysSinceMonday * DAY - SHANGHAI_OFFSET,
  );
  return { start, end: new Date(start.getTime() + 7 * DAY) };
}

export function weeklyLaneLimit(
  limits: SponsorConfig,
  lane: BudgetLane,
): bigint {
  return lane === "exit"
    ? BigInt(limits.weekly.exitReserveWei)
    : BigInt(limits.weekly.projectWei) - BigInt(limits.weekly.exitReserveWei);
}

/** Unresolved liabilities survive a weekly reset. Late final settlement is also
 * charged in its settlement week, independently of routine recovery polling. */
export function countsTowardWeek(
  o: Operation,
  week: { start: Date; end: Date },
): boolean {
  const created = Date.parse(o.createdAt);
  return (
    (created >= week.start.getTime() && created < week.end.getTime()) ||
    (created < week.start.getTime() &&
      (isRecoverable(o.state) ||
        o.state === "preparing" ||
        o.state === "awaiting-signature" ||
        Date.parse(o.gasSettledAt ?? o.updatedAt) >= week.start.getTime()))
  );
}

function nonceKey(o: Operation): string {
  return `${o.deploymentId}:${o.account.toLowerCase()}:${o.nonce}`;
}

function hasFinalGas(o: Operation): boolean {
  return (
    ["confirmed", "reverted"].includes(o.state) &&
    o.finality === "finalized" &&
    o.actualGasCost !== null &&
    o.userOperationHash !== null &&
    o.transactionHash !== null &&
    o.blockHash !== null &&
    o.blockNumber !== null
  );
}

/** Pending/unknown operations retain their ceiling. Only canonical finalized
 * receipts settle it. A cancellation is free only if no sponsorship could have
 * escaped, or a recorded finalized execution already paid for that exact nonce.
 * This also safely reconciles historical cancelled attempts without rewriting them. */
export function budgetCharges(
  operations: readonly Operation[],
): Map<string, bigint> {
  const finalNonces = new Set(operations.filter(hasFinalGas).map(nonceKey));
  return new Map(
    operations.map((o) => {
      let cost = BigInt(o.maxGasCost);
      if (o.gasPayment === "self-funded") cost = 0n;
      else if (hasFinalGas(o)) cost = BigInt(o.actualGasCost!);
      else if (
        o.state === "cancelled" &&
        o.userOperationHash === null &&
        o.transactionHash === null &&
        o.providerOperationId === null &&
        ((o.sponsorshipAttempted === false && o.gasReleasedAt !== undefined) ||
          finalNonces.has(nonceKey(o)))
      )
        cost = 0n;
      return [o.id, cost];
    }),
  );
}

/** Reports and admission use identical charge calculations, including carryover. */
export function budgetTotals(operations: readonly Operation[], at: Date) {
  const charges = budgetCharges(operations),
    week = weeklyBudgetWindow(at);
  const day = at.toISOString().slice(0, 10);
  const sponsored = operations.filter((o) => o.gasPayment !== "self-funded");
  const sum = (items: readonly Operation[]) =>
    items.reduce((n, o) => n + charges.get(o.id)!, 0n);
  return (["exposure", "exit"] as const).map((lane) => {
    const rows = sponsored.filter((o) => o.lane === lane);
    const daily = rows.filter((o) => o.createdAt.slice(0, 10) === day);
    return {
      lane,
      dailyWei: sum(daily),
      dailyOperations: daily.length,
      weeklyWei: sum(rows.filter((o) => countsTowardWeek(o, week))),
    };
  });
}

/** Include the week, the rolling faucet cooldown and unresolved older nonces. */
export function quotaHistoryStart(createdAt: string): string {
  return new Date(
    Math.min(
      weeklyBudgetWindow(createdAt).start.getTime(),
      Date.parse(createdAt) - DAY,
    ),
  ).toISOString();
}
