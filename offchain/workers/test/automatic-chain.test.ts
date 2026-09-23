import { describe, expect, it, vi } from "vitest";
import {
  keccak256,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  AutomationGasCapExceeded,
  type AutomaticAction,
} from "../src/automatic-claims.js";
import { ViemAutomationChain } from "../src/automatic-chain.js";

const account = privateKeyToAccount(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);
const action: AutomaticAction = {
  key: "match:test",
  owner: account.address,
  kind: "match-orders",
  target: "0x2222222222222222222222222222222222222222" as Address,
  data: "0x1234",
  requiresClaimPreference: false,
};

describe("keeper gas admission", () => {
  it("checks the maximum transaction cost before signing", async () => {
    const raw = "0x123456" as const;
    const wallet = {
      chain: undefined,
      prepareTransactionRequest: vi.fn(async () => ({
        nonce: 1n,
        gas: 21n,
        maxFeePerGas: 2n,
      })),
      signTransaction: vi.fn(async () => raw),
    } as unknown as WalletClient;
    const chain = new ViemAutomationChain(
      {} as PublicClient,
      wallet,
      account,
      1n,
      undefined,
      undefined,
      41n,
    );
    await expect(chain.prepare(action)).rejects.toBeInstanceOf(
      AutomationGasCapExceeded,
    );
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    const allowed = new ViemAutomationChain(
      {} as PublicClient,
      wallet,
      account,
      1n,
      undefined,
      undefined,
      42n,
    );
    expect(await allowed.prepare(action)).toMatchObject({
      raw,
      hash: keccak256(raw),
      maximumCost: 42n,
    });
    expect(wallet.signTransaction).toHaveBeenCalledOnce();
  });
});
