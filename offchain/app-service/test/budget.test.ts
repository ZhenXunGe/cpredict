import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { H, operation } from "../../app-core/test/fixtures.js";
import { sponsorConfigSchema } from "../src/config.js";
import {
  budgetCharges,
  budgetTotals,
  quotaHistoryStart,
  weeklyBudgetWindow,
} from "../src/budget.js";
import { assertQuota, type StoredOperation } from "../src/store.js";

const lane = {
  projectWei: "1000000000000000000",
  accountWei: "1000000000000000000",
  subjectWei: "1000000000000000000",
  projectOperations: 100,
  accountOperations: 100,
  subjectOperations: 100,
};
const rawLimits = {
  projectId: "weekly-test",
  providerHardLimitWei: "100000000000000000",
  providerHardLimitPeriodSeconds: 604800,
  policyOperator: "and",
  passOnError: false,
  maxCostPerOperation: "1000000000000000",
  validitySeconds: 300,
  methodDailyOperations: 100,
  exposure: lane,
  exit: lane,
  weekly: {
    window: "shanghai-monday",
    projectWei: "100000000000000000",
    exitReserveWei: "20000000000000000",
  },
};
const limits = sponsorConfigSchema.parse(rawLimits);
let nonce = 0;
function record(
  at: string,
  cost: string,
  budgetLane: "exposure" | "exit" = "exposure",
): StoredOperation {
  return {
    subject: "did:privy:weekly-test",
    idempotencyKey: randomUUID(),
    requestHash: H(1),
    operation: {
      ...operation,
      id: randomUUID(),
      nonce: String(++nonce),
      lane: budgetLane,
      kind: budgetLane === "exit" ? "transfer" : "buy",
      createdAt: at,
      updatedAt: at,
      maxGasCost: cost,
      state: "confirmed",
    },
  };
}

describe("per-environment weekly sponsorship budget", () => {
  it("uses the exact Shanghai Monday boundary across month and year changes", () => {
    const before = weeklyBudgetWindow("2026-09-13T15:59:59.999Z");
    expect(before.start.toISOString()).toBe("2026-09-06T16:00:00.000Z");
    expect(before.end.toISOString()).toBe("2026-09-13T16:00:00.000Z");
    expect(weeklyBudgetWindow(before.end).start).toEqual(before.end);
    expect(weeklyBudgetWindow("2027-01-01T00:00:00Z").start.toISOString()).toBe(
      "2026-12-27T16:00:00.000Z",
    );
    expect(quotaHistoryStart("2026-09-13T16:00:00.000Z")).toBe(
      "2026-09-12T16:00:00.000Z",
    );
  });

  it("counts earlier days, accepts the exact ceiling and preserves the exit allocation", () => {
    const existing = [record("2026-09-07T01:00:00.000Z", "79000000000000000")];
    const last = record("2026-09-12T01:00:00.000Z", "1000000000000000");
    expect(() => assertQuota(existing, last, limits)).not.toThrow();
    expect(() =>
      assertQuota(
        [...existing, last],
        record(last.operation.createdAt, "1"),
        limits,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "sponsorship_weekly_budget_exhausted" }),
    );
    const exit = record(last.operation.createdAt, "20000000000000000", "exit");
    expect(() => assertQuota([...existing, last], exit, limits)).not.toThrow();
    expect(() =>
      assertQuota(
        [exit],
        record(last.operation.createdAt, "1", "exit"),
        limits,
      ),
    ).toThrow();
  });

  it("keeps daily account and method limits in force below the weekly ceiling", () => {
    const previous = record("2026-09-09T01:00:00.000Z", "1000000000000000");
    const next = record(previous.operation.createdAt, "1");
    expect(() =>
      assertQuota([previous], next, {
        ...limits,
        exposure: { ...lane, accountWei: previous.operation.maxGasCost },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "sponsorship_budget_exhausted" }),
    );
    expect(() =>
      assertQuota([previous], next, { ...limits, methodDailyOperations: 1 }),
    ).toThrowError(expect.objectContaining({ code: "method_quota_exhausted" }));
  });

  it("does not release reservations for unknown, failed or cancelled operations", () => {
    for (const state of ["unknown", "reverted", "cancelled"] as const) {
      const previous = record("2026-09-08T00:00:00.000Z", "80000000000000000");
      previous.operation.state = state;
      expect(() =>
        assertQuota(
          [previous],
          record("2026-09-09T00:00:00.000Z", "1"),
          limits,
        ),
      ).toThrowError(
        expect.objectContaining({
          code: "sponsorship_weekly_budget_exhausted",
        }),
      );
    }
  });

  it("carries unresolved older operations and this week's late results across reset", () => {
    const old = record("2026-08-31T00:00:00.000Z", "80000000000000000");
    const next = record("2026-09-07T00:00:00.000Z", "1");
    expect(() => assertQuota([old], next, limits)).not.toThrow();
    old.operation.state = "unknown";
    expect(() => assertQuota([old], next, limits)).toThrow();
    old.operation.state = "confirmed";
    old.operation.updatedAt = next.operation.createdAt;
    expect(() => assertQuota([old], next, limits)).toThrow();
  });

  it("requires explicit provider limits and a funded weekly exit lane", () => {
    expect(limits.providerHardLimitUsd).toBeNull();
    expect(
      sponsorConfigSchema.safeParse({
        ...rawLimits,
        providerHardLimitWei: null,
      }).success,
    ).toBe(false);
    expect(
      sponsorConfigSchema.safeParse({
        ...rawLimits,
        providerHardLimitPeriodSeconds: null,
      }).success,
    ).toBe(false);
    expect(
      sponsorConfigSchema.safeParse({
        ...rawLimits,
        weekly: {
          ...rawLimits.weekly,
          exitReserveWei: rawLimits.weekly.projectWei,
        },
      }).success,
    ).toBe(false);
    expect(
      sponsorConfigSchema.safeParse({
        ...rawLimits,
        weekly: { ...rawLimits.weekly, exitReserveWei: "1" },
      }).success,
    ).toBe(false);
    expect(
      sponsorConfigSchema.safeParse({
        ...rawLimits,
        weekly: { ...rawLimits.weekly, projectWei: "CONFIGURE_WEEKLY_BUDGET" },
      }).success,
    ).toBe(false);
  });

  it("settles finalized successful and reverted receipts, retaining pending or incomplete evidence", () => {
    const row = record("2026-09-11T14:00:00.000Z", "5000000000000000", "exit");
    Object.assign(row.operation, {
      userOperationHash: H(10),
      transactionHash: H(11),
      blockHash: H(12),
      blockNumber: "100",
      actualGasCost: "50000000000000",
      finality: "finalized",
    });
    for (const state of ["confirmed", "reverted"] as const) {
      row.operation.state = state;
      expect(budgetCharges([row.operation]).get(row.operation.id)).toBe(
        50000000000000n,
      );
    }
    row.operation.finality = "application-confirmed";
    expect(budgetCharges([row.operation]).get(row.operation.id)).toBe(
      5000000000000000n,
    );
    row.operation.finality = "finalized";
    row.operation.blockHash = null;
    expect(budgetCharges([row.operation]).get(row.operation.id)).toBe(
      5000000000000000n,
    );
  });

  it("releases certified grant-free cancellations and reconciles a historical cancelled nonce exactly once", () => {
    const cancelled = record(
      "2026-09-11T14:00:00.000Z",
      "5000000000000000",
      "exit",
    ).operation;
    cancelled.state = "cancelled";
    expect(budgetCharges([cancelled]).get(cancelled.id)).toBe(
      5000000000000000n,
    );
    cancelled.sponsorshipAttempted = false;
    // A legacy process may have issued a grant; an explicit cancellation certificate is required.
    expect(budgetCharges([cancelled]).get(cancelled.id)).toBe(
      5000000000000000n,
    );
    cancelled.gasReleasedAt = cancelled.updatedAt;
    expect(budgetCharges([cancelled]).get(cancelled.id)).toBe(0n);
    delete cancelled.gasReleasedAt;
    delete cancelled.sponsorshipAttempted;
    const final = {
      ...cancelled,
      id: randomUUID(),
      state: "confirmed" as const,
      finality: "finalized" as const,
      actualGasCost: "20000000000000",
      userOperationHash: H(20),
      transactionHash: H(21),
      blockHash: H(22),
      blockNumber: "100",
    };
    expect([...budgetCharges([cancelled, final]).values()]).toEqual([
      0n,
      20000000000000n,
    ]);
    expect(
      budgetCharges([
        cancelled,
        { ...final, nonce: String(BigInt(final.nonce) + 1n) },
      ]).get(cancelled.id),
    ).toBe(5000000000000000n);
    expect(
      budgetCharges([cancelled, { ...final, deploymentId: "another" }]).get(
        cancelled.id,
      ),
    ).toBe(5000000000000000n);
  });

  it("uses settled costs in weekly and daily admission and reports, while retaining count quotas", () => {
    const at = "2026-09-11T14:00:00.000Z";
    const rows = Array.from({ length: 4 }, (_, i) => {
      const r = record(at, "5000000000000000", "exit");
      Object.assign(r.operation, {
        finality: "finalized",
        actualGasCost: "100000000000000",
        userOperationHash: H(i + 1),
        transactionHash: H(11),
        blockHash: H(12),
        blockNumber: "100",
      });
      return r;
    });
    const next = record(at, "5000000000000000", "exit");
    expect(() => assertQuota(rows, next, limits)).not.toThrow();
    const totals = budgetTotals(
      rows.map((r) => r.operation),
      new Date(at),
    ).find((b) => b.lane === "exit")!;
    expect(totals).toMatchObject({
      dailyWei: 400000000000000n,
      weeklyWei: 400000000000000n,
      dailyOperations: 4,
    });
    expect(() =>
      assertQuota(rows, next, { ...limits, methodDailyOperations: 4 }),
    ).toThrowError(expect.objectContaining({ code: "method_quota_exhausted" }));
  });

  it("admits self-funded requests above sponsorship caps without spending project funds or bypassing nonce and faucet rules", () => {
    const at = "2026-09-11T14:00:00.000Z",
      full = record(at, "20000000000000000", "exit"),
      next = record(at, "5000000000000000", "exit");
    next.operation.gasPayment = "self-funded";
    expect(() =>
      assertQuota([full], next, { ...limits, methodDailyOperations: 1 }),
    ).not.toThrow();
    expect(budgetCharges([next.operation]).get(next.operation.id)).toBe(0n);
    full.operation.state = "unknown";
    next.operation.nonce = full.operation.nonce;
    expect(() => assertQuota([full], next, limits)).toThrowError(
      expect.objectContaining({ code: "operation_in_progress" }),
    );
    full.operation.state = "confirmed";
    full.operation.kind = "faucet";
    next.operation.kind = "faucet";
    expect(() => assertQuota([full], next, limits)).toThrowError(
      expect.objectContaining({ code: "faucet_cooldown" }),
    );
  });

  it("does not recharge a final settlement in later weeks due to routine polling timestamps", () => {
    const old = record(
      "2026-09-01T01:00:00.000Z",
      "1000000000000000",
    ).operation;
    Object.assign(old, {
      finality: "finalized",
      gasSettledAt: "2026-09-02T01:00:00.000Z",
      updatedAt: "2026-09-11T01:00:00.000Z",
    });
    expect(
      budgetTotals([old], new Date("2026-09-11T02:00:00.000Z"))[0]!.weeklyWei,
    ).toBe(0n);
  });
});
