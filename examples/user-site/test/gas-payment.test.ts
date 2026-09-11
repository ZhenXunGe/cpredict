import { describe, expect, it, vi } from "vitest";
import type { EIP1193Provider, PublicClient } from "viem";
import { appAccount, A, H } from "../../../offchain/app-core/test/fixtures.js";
import { fundGas, gasBalance, requireGasBalance } from "../src/gas-payment.js";

describe("explicit ETH gas funding", () => {
  it("includes existing EntryPoint deposit and rejects insufficient funds", async () => {
    const client = {
      getBalance: vi.fn().mockResolvedValue(10n),
      readContract: vi.fn().mockResolvedValue(20n),
    } as unknown as PublicClient;
    expect(await gasBalance(client, appAccount)).toBe(30n);
    expect(() => requireGasBalance(30n, 30n)).not.toThrow();
    expect(() => requireGasBalance(29n, 30n)).toThrowError(
      expect.objectContaining({ code: "self_funded_balance_insufficient" }),
    );
  });
  it("sends only the explicitly requested ETH amount from the verified controller to its smart account", async () => {
    const calls: unknown[] = [];
    const provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === "eth_accounts") return [appAccount.controller];
        if (method === "eth_chainId") return "0x66eee";
        if (method === "eth_sendTransaction") {
          calls.push(params);
          return H(12);
        }
        throw new Error(`unexpected ${method}`);
      }),
    } as unknown as EIP1193Provider;
    expect(await fundGas(provider, appAccount, "0.005")).toBe(H(12));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      expect.objectContaining({
        from: appAccount.controller,
        to: appAccount.address,
        value: "0x11c37937e08000",
      }),
    ]);
  });
  it.each(["wallet", "chain", "context", "amount"])(
    "rejects a changed %s before requesting any transaction",
    async (kind) => {
      const request = vi.fn(async ({ method }: { method: string }) =>
        method === "eth_accounts"
          ? [kind === "wallet" ? A(900) : appAccount.controller]
          : kind === "chain"
            ? "0x1"
            : "0x66eee",
      );
      await expect(
        fundGas(
          { request } as unknown as EIP1193Provider,
          appAccount,
          kind === "amount" ? "0" : "0.005",
          () => kind !== "context",
        ),
      ).rejects.toBeDefined();
      expect(
        request.mock.calls.some(([c]) => c.method === "eth_sendTransaction"),
      ).toBe(false);
    },
  );
});
