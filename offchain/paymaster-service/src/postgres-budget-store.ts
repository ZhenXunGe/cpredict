import { randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { getAddress } from "viem";
import {
  SponsorBudgetExceededError,
  type SponsorBudgetLease,
  type SponsorBudgetRequest,
  type SponsorBudgetStore,
} from "./types.js";

type Db = Sql | TransactionSql;

interface CostUsageRow {
  reserved_cost: string;
  committed_cost: string;
}

interface UserUsageRow extends CostUsageRow {
  reserved_create_listing: number;
  committed_create_listing: number;
  reserved_cancel_listing: number;
  committed_cancel_listing: number;
}

interface LeaseRow {
  policy_day: string;
  subject: string;
  max_cost: string;
  create_listing_count: number;
  cancel_listing_count: number;
  state: "reserved" | "committed" | "released";
}

/**
 * Atomic shared budget implementation. `subject` must be a stable opaque identifier rather than
 * an email, phone number or other direct PII. Reservations are deliberately not reclaimed before
 * their policy day rolls over: uncertain post-signature commits fail closed instead of authorizing
 * a second signature against the same budget.
 */
export class PostgresSponsorBudgetStore implements SponsorBudgetStore {
  private readonly sql: Sql;

  constructor(connectionString: string) {
    if (
      !connectionString.startsWith("postgres://") &&
      !connectionString.startsWith("postgresql://")
    ) {
      throw new TypeError(
        "budget DATABASE_URL must use postgres:// or postgresql://",
      );
    }
    this.sql = postgres(connectionString, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: true,
      onnotice: () => undefined,
    });
  }

  async ready(): Promise<void> {
    const rows = await this.sql<
      Array<{ usage: string | null; leases: string | null }>
    >`
      SELECT
        to_regclass('sponsor_budget_user_usage')::text AS usage,
        to_regclass('sponsor_budget_leases')::text AS leases
    `;
    const row = rows[0];
    if (row === undefined || row.usage === null || row.leases === null) {
      throw new Error("paymaster budget migration is not applied");
    }
  }

  async reserve(request: SponsorBudgetRequest): Promise<SponsorBudgetLease> {
    validateRequest(request);
    const leaseId = randomUUID();
    const sender = getAddress(request.sender).toLowerCase();

    await this.sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO sponsor_budget_global_usage (policy_day)
        VALUES (${request.policyDay})
        ON CONFLICT (policy_day) DO NOTHING
      `;
      await transaction`
        INSERT INTO sponsor_budget_user_usage (policy_day, subject)
        VALUES (${request.policyDay}, ${request.subject})
        ON CONFLICT (policy_day, subject) DO NOTHING
      `;

      const global = await lockGlobalUsage(transaction, request.policyDay);
      const user = await lockUserUsage(
        transaction,
        request.policyDay,
        request.subject,
      );
      assertWithinLimits(request, global, user);

      await transaction`
        UPDATE sponsor_budget_global_usage
        SET reserved_cost = reserved_cost + ${request.maxCost.toString()}, updated_at = NOW()
        WHERE policy_day = ${request.policyDay}
      `;
      await transaction`
        UPDATE sponsor_budget_user_usage
        SET
          reserved_cost = reserved_cost + ${request.maxCost.toString()},
          reserved_create_listing = reserved_create_listing + ${request.operationCounts.createListing},
          reserved_cancel_listing = reserved_cancel_listing + ${request.operationCounts.cancelListing},
          updated_at = NOW()
        WHERE policy_day = ${request.policyDay} AND subject = ${request.subject}
      `;
      await transaction`
        INSERT INTO sponsor_budget_leases (
          lease_id, policy_day, subject, sender, max_cost, create_listing_count,
          cancel_listing_count, valid_until, state
        ) VALUES (
          ${leaseId}, ${request.policyDay}, ${request.subject}, ${sender},
          ${request.maxCost.toString()}, ${request.operationCounts.createListing},
          ${request.operationCounts.cancelListing}, ${request.validUntil}, 'reserved'
        )
      `;
    });

    return new PostgresSponsorBudgetLease(this.sql, leaseId);
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

class PostgresSponsorBudgetLease implements SponsorBudgetLease {
  constructor(
    private readonly sql: Sql,
    private readonly leaseId: string,
  ) {}

  async commit(): Promise<void> {
    await transitionLease(this.sql, this.leaseId, "committed");
  }

  async release(): Promise<void> {
    await transitionLease(this.sql, this.leaseId, "released");
  }
}

async function transitionLease(
  sql: Sql,
  leaseId: string,
  target: "committed" | "released",
): Promise<void> {
  await sql.begin(async (transaction) => {
    const rows = await transaction<Array<LeaseRow>>`
      SELECT policy_day, subject, max_cost, create_listing_count, cancel_listing_count, state
      FROM sponsor_budget_leases WHERE lease_id = ${leaseId} FOR UPDATE
    `;
    const lease = rows[0];
    if (lease === undefined) throw new Error("budget lease does not exist");
    if (lease.state === target) return;
    if (lease.state !== "reserved")
      throw new Error("budget lease is already finalized");

    const policyDay = Number(lease.policy_day);
    await lockGlobalUsage(transaction, policyDay);
    await lockUserUsage(transaction, policyDay, lease.subject);
    const committedCost = target === "committed" ? lease.max_cost : "0";
    const committedCreate =
      target === "committed" ? lease.create_listing_count : 0;
    const committedCancel =
      target === "committed" ? lease.cancel_listing_count : 0;

    await transaction`
      UPDATE sponsor_budget_global_usage
      SET
        reserved_cost = reserved_cost - ${lease.max_cost},
        committed_cost = committed_cost + ${committedCost},
        updated_at = NOW()
      WHERE policy_day = ${policyDay}
    `;
    await transaction`
      UPDATE sponsor_budget_user_usage
      SET
        reserved_cost = reserved_cost - ${lease.max_cost},
        committed_cost = committed_cost + ${committedCost},
        reserved_create_listing = reserved_create_listing - ${lease.create_listing_count},
        committed_create_listing = committed_create_listing + ${committedCreate},
        reserved_cancel_listing = reserved_cancel_listing - ${lease.cancel_listing_count},
        committed_cancel_listing = committed_cancel_listing + ${committedCancel},
        updated_at = NOW()
      WHERE policy_day = ${policyDay} AND subject = ${lease.subject}
    `;
    await transaction`
      UPDATE sponsor_budget_leases SET state = ${target}, updated_at = NOW()
      WHERE lease_id = ${leaseId}
    `;
  });
}

async function lockGlobalUsage(
  db: Db,
  policyDay: number,
): Promise<CostUsageRow> {
  const rows = await db<Array<CostUsageRow>>`
    SELECT reserved_cost, committed_cost FROM sponsor_budget_global_usage
    WHERE policy_day = ${policyDay} FOR UPDATE
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("global budget row is missing");
  return row;
}

async function lockUserUsage(
  db: Db,
  policyDay: number,
  subject: string,
): Promise<UserUsageRow> {
  const rows = await db<Array<UserUsageRow>>`
    SELECT reserved_cost, committed_cost, reserved_create_listing, committed_create_listing,
           reserved_cancel_listing, committed_cancel_listing
    FROM sponsor_budget_user_usage
    WHERE policy_day = ${policyDay} AND subject = ${subject} FOR UPDATE
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("user budget row is missing");
  return row;
}

function assertWithinLimits(
  request: SponsorBudgetRequest,
  global: CostUsageRow,
  user: UserUsageRow,
): void {
  const nextGlobalCost =
    BigInt(global.reserved_cost) +
    BigInt(global.committed_cost) +
    request.maxCost;
  const nextUserCost =
    BigInt(user.reserved_cost) + BigInt(user.committed_cost) + request.maxCost;
  const nextCreate =
    user.reserved_create_listing +
    user.committed_create_listing +
    request.operationCounts.createListing;
  const nextCancel =
    user.reserved_cancel_listing +
    user.committed_cancel_listing +
    request.operationCounts.cancelListing;
  if (
    nextGlobalCost > request.limits.maxCostGlobalDay ||
    nextUserCost > request.limits.maxCostPerUserDay ||
    nextCreate > request.limits.createListingPerUserDay ||
    nextCancel > request.limits.cancelListingPerUserDay
  ) {
    throw new SponsorBudgetExceededError();
  }
}

function validateRequest(request: SponsorBudgetRequest): void {
  if (!Number.isSafeInteger(request.policyDay) || request.policyDay < 0) {
    throw new TypeError("policyDay must be a non-negative safe integer");
  }
  if (request.subject.length < 1 || request.subject.length > 256) {
    throw new TypeError(
      "subject must be an opaque identifier of 1-256 characters",
    );
  }
  if (request.maxCost <= 0n || request.validUntil <= 0) {
    throw new TypeError(
      "budget reservation cost and validity must be positive",
    );
  }
  const integers = [
    request.operationCounts.createListing,
    request.operationCounts.cancelListing,
    request.limits.createListingPerUserDay,
    request.limits.cancelListingPerUserDay,
  ];
  if (integers.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(
      "operation counts and limits must be non-negative safe integers",
    );
  }
  if (
    request.maxCost > request.limits.maxCostPerUserDay ||
    request.limits.maxCostPerUserDay > request.limits.maxCostGlobalDay
  ) {
    throw new TypeError("budget cost limits are inconsistent");
  }
}
