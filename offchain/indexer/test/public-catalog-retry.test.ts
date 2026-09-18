import { describe, expect, it, vi } from "vitest";
import { env } from "../../app-core/test/fixtures.js";
import type { PostgresFinancialLedger } from "../src/financial-store.js";
import { publicCatalog } from "../src/public-catalog.js";

function fixture() {
  const begin = vi.fn();
  const ledger = {
    environment: env,
    sql: { begin },
  } as unknown as PostgresFinancialLedger;
  return { ledger, begin };
}

describe("catalog transaction retry boundary", () => {
  it("retries an explicitly rolled-back serialization failure with a new transaction", async () => {
    const { ledger, begin } = fixture();
    const page = { items: [], nextCursor: null };
    begin.mockRejectedValueOnce(
      Object.assign(new Error("serialization failure"), { code: "40001" }),
    );
    begin.mockResolvedValueOnce(page);
    expect(await publicCatalog(ledger, "markets", {})).toBe(page);
    expect(begin).toHaveBeenCalledTimes(2);
  });

  it("does not replay a connection failure with an unknown transaction outcome", async () => {
    const { ledger, begin } = fixture();
    const error = Object.assign(new Error("connection lost"), {
      code: "08006",
    });
    begin.mockRejectedValue(error);
    await expect(publicCatalog(ledger, "markets", {})).rejects.toBe(error);
    expect(begin).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated serialization failures to four attempts", async () => {
    const { ledger, begin } = fixture();
    const error = Object.assign(new Error("serialization failure"), {
      code: "40001",
    });
    begin.mockRejectedValue(error);
    await expect(publicCatalog(ledger, "markets", {})).rejects.toBe(error);
    expect(begin).toHaveBeenCalledTimes(4);
  });
});
