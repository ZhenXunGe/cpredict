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

/** Carry old unresolved reservations forward. A late result retains its full
 * reservation for the week in which it is recovered, rather than freeing gas
 * that may just have been spent. This is deliberately more conservative than
 * actualGasCost, which is reported independently. */
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
        Date.parse(o.updatedAt) >= week.start.getTime()))
  );
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
