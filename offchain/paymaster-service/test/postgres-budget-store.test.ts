import { beforeEach, describe, expect, it, vi } from "vitest";

const { postgresMock, sqlMock } = vi.hoisted(() => {
  const sqlMock = Object.assign(vi.fn(), { end: vi.fn() });
  return {
    postgresMock: vi.fn(() => sqlMock),
    sqlMock,
  };
});

vi.mock("postgres", () => ({ default: postgresMock }));

import { PostgresSponsorBudgetStore } from "../src/postgres-budget-store.js";

describe("PostgresSponsorBudgetStore readiness", () => {
  beforeEach(() => {
    postgresMock.mockClear();
    sqlMock.mockReset();
  });

  it.each([
    { name: "no result row", rows: [] },
    {
      name: "missing usage table",
      rows: [{ usage: null, leases: "sponsor_budget_leases" }],
    },
    {
      name: "missing leases table",
      rows: [{ usage: "sponsor_budget_user_usage", leases: null }],
    },
  ])("fails closed for $name", async ({ rows }) => {
    sqlMock.mockResolvedValueOnce(rows);
    const store = new PostgresSponsorBudgetStore(
      "postgresql://127.0.0.1/cpredict",
    );

    await expect(store.ready()).rejects.toThrow(
      "paymaster budget migration is not applied",
    );
  });

  it("accepts only a result row naming both required tables", async () => {
    sqlMock.mockResolvedValueOnce([
      { usage: "sponsor_budget_user_usage", leases: "sponsor_budget_leases" },
    ]);
    const store = new PostgresSponsorBudgetStore(
      "postgresql://127.0.0.1/cpredict",
    );

    await expect(store.ready()).resolves.toBeUndefined();
  });
});
