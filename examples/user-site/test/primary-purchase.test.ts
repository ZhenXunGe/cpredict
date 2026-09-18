import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import {
  checkPrimaryPurchase,
  primaryAvailability,
  primaryAlternativeBlockedReason,
  readPrimaryCapacity,
  type PrimaryCapacity,
} from "../src/primary-purchase.js";
import { errorCopy } from "../src/api.js";
import { A } from "../../../offchain/app-core/test/fixtures.js";

const u = 1000000n;
const capacity: PrimaryCapacity = {
  perUserCap: 10n * u,
  marketCap: 100n * u,
  principal: 0n,
  cumulativeBought: 0n,
  minimumPrimary: u / 100n,
};
describe("primary purchase limits", () => {
  it("explains 20 against an account cap of 10", () => {
    const result = checkPrimaryPurchase(capacity, 20n * u, 20n * u, "ctUSD");
    expect(result.error?.code).toBe("primary_account_cap");
    expect(errorCopy(result.error)).toContain("每账户一级投入上限 10 ctUSD");
    expect(errorCopy(result.error)).toContain("还可投入 10 ctUSD");
  });
  it("accepts the exact account boundary", () => {
    expect(checkPrimaryPurchase(capacity, 10n * u, 10n * u, "ctUSD")).toEqual({
      filled: 10n * u,
      error: null,
    });
  });
  it("uses cumulative purchases, not currently held shares", () => {
    const result = checkPrimaryPurchase(
      { ...capacity, cumulativeBought: 8n * u },
      3n * u,
      3n * u,
      "ctUSD",
    );
    expect(errorCopy(result.error)).toContain("还可投入 2 ctUSD");
    expect(
      checkPrimaryPurchase(
        { ...capacity, cumulativeBought: 10n * u },
        u,
        u,
        "ctUSD",
      ).error?.code,
    ).toBe("primary_account_full");
  });
  it("distinguishes full market and insufficient remaining market capacity", () => {
    expect(
      checkPrimaryPurchase({ ...capacity, principal: 100n * u }, u, u, "ctUSD")
        .error?.code,
    ).toBe("primary_market_full");
    expect(
      checkPrimaryPurchase(
        { ...capacity, principal: 99n * u },
        2n * u,
        2n * u,
        "ctUSD",
      ).error?.code,
    ).toBe("primary_market_cap");
  });
  it("allows partial filling only when the explicit minimum fits both limits", () => {
    expect(checkPrimaryPurchase(capacity, 20n * u, 10n * u, "ctUSD")).toEqual({
      filled: 10n * u,
      error: null,
    });
    expect(
      checkPrimaryPurchase(
        { ...capacity, principal: 97n * u },
        20n * u,
        3n * u,
        "ctUSD",
      ),
    ).toEqual({ filled: 3n * u, error: null });
    expect(
      checkPrimaryPurchase(
        { ...capacity, principal: 97n * u },
        20n * u,
        4n * u,
        "ctUSD",
      ).error?.code,
    ).toBe("primary_market_cap");
  });
  it("respects contract minimum and never reports negative remaining amounts", () => {
    expect(checkPrimaryPurchase(capacity, 1n, 1n, "ctUSD").error?.code).toBe(
      "primary_minimum_not_met",
    );
    expect(
      primaryAvailability({
        ...capacity,
        principal: 101n * u,
        cumulativeBought: 11n * u,
      }),
    ).toEqual({ market: 0n, account: 0n });
  });
  it("pins reads to one chain block and the application account", async () => {
    const values = {
      perUserPrimaryCap: 10n * u,
      marketPrimaryCap: 100n * u,
      totalPrincipal: 2n * u,
      cumulativePrimaryBought: 1n * u,
      minimumPrimaryUnits: 10000n,
    };
    const readContract = vi.fn(
      async ({ functionName }: { functionName: keyof typeof values }) =>
        values[functionName],
    );
    const client = {
      getBlock: vi.fn(async () => ({ number: 123n })),
      readContract,
    };
    const result = await readPrimaryCapacity(
      client as unknown as PublicClient,
      A(1),
      A(2),
    );
    expect(result.cumulativeBought).toBe(u);
    expect(
      readContract.mock.calls.every(
        ([args]) =>
          (args as object as { blockNumber: bigint }).blockNumber === 123n,
      ),
    ).toBe(true);
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "cumulativePrimaryBought",
        args: [A(2)],
      }),
    );
  });
  it("keeps anonymous account capacity unknown and fails a missing chain read", async () => {
    const readContract = vi.fn(async () => 10n);
    const client = { readContract };
    const result = await readPrimaryCapacity(
      client as unknown as PublicClient,
      A(1),
      undefined,
      123n,
    );
    expect(primaryAvailability(result).account).toBeNull();
    expect(readContract).toHaveBeenCalledTimes(4);
    readContract.mockRejectedValueOnce(new Error("offline"));
    await expect(
      readPrimaryCapacity(client as unknown as PublicClient, A(1), A(2), 123n),
    ).rejects.toThrow("offline");
  });
});

describe("C2C primary price alternative", () => {
  it("permits a primary review when the minimum fits, without guaranteeing the entire requested fill", () => {
    expect(
      primaryAlternativeBlockedReason(capacity, true, true, true),
    ).toBeNull();
    expect(
      primaryAlternativeBlockedReason(
        { ...capacity, cumulativeBought: null },
        true,
        true,
        true,
      ),
    ).toBeNull();
  });
  it("does not direct to closed, unverified, disabled or unknown primary buying", () => {
    expect(
      primaryAlternativeBlockedReason(capacity, false, true, true),
    ).toContain("封盘");
    expect(
      primaryAlternativeBlockedReason(capacity, true, false, true),
    ).toContain("规则");
    expect(
      primaryAlternativeBlockedReason(capacity, true, true, false),
    ).toContain("暂停");
    expect(primaryAlternativeBlockedReason(null, true, true, true)).toContain(
      "暂未核实",
    );
  });
  it("explains market-full, account-full and less-than-minimum capacity", () => {
    expect(
      primaryAlternativeBlockedReason(
        { ...capacity, principal: capacity.marketCap },
        true,
        true,
        true,
      ),
    ).toContain("市场一级投入额度已满");
    expect(
      primaryAlternativeBlockedReason(
        { ...capacity, cumulativeBought: capacity.perUserCap },
        true,
        true,
        true,
      ),
    ).toContain("你的一级投入额度已满");
    expect(
      primaryAlternativeBlockedReason(
        { ...capacity, principal: capacity.marketCap - 1n },
        true,
        true,
        true,
      ),
    ).toContain("最低");
    expect(
      primaryAlternativeBlockedReason(
        { ...capacity, cumulativeBought: capacity.perUserCap - 1n },
        true,
        true,
        true,
      ),
    ).toContain("最低");
  });
});
