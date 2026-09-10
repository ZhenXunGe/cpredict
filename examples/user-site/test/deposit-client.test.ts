import { describe, it, expect, vi } from "vitest";
import { recoverTypedDataAddress, type PublicClient } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { ConnectedWallet } from "@privy-io/react-auth";
import {
  fixtureDeposit,
  depositEnvironment,
  depositDomain,
} from "./browser/deposit-fixture.js";
import { appAccount, A } from "../../../offchain/app-core/test/fixtures.js";
import {
  RECEIVE_TYPEHASH,
  receiveTypedData,
} from "../../../offchain/app-core/src/usdc.js";
import {
  assertDepositContext,
  signDepositAuthorization,
} from "../src/deposit-client.js";
import { SiteApi } from "../src/api.js";

function setup() {
  const source = privateKeyToAccount(generatePrivateKey()),
    account = {
      ...appAccount,
      environment: depositEnvironment.id,
      index: "1002",
    };
  const deposit = fixtureDeposit(account, source.address),
    api = new SiteApi(depositEnvironment);
  const client = {
    getChainId: async () => 421614,
    getCode: async () => "0x6000",
    getBlock: async () => ({
      number: 1n,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
    }),
    readContract: async ({ functionName }: { functionName: string }) =>
      ({
        name: "USD Coin",
        decimals: 6,
        DOMAIN_SEPARATOR:
          "0x85944e1292d007732838d6eadfa67589b78ffcededbd4df60488d0af251308bb",
        RECEIVE_WITH_AUTHORIZATION_TYPEHASH: RECEIVE_TYPEHASH,
      })[functionName],
  } as unknown as PublicClient;
  vi.spyOn(api, "publicClient").mockReturnValue(client);
  const state = {
    chain: "0x66eee",
    accounts: [source.address] as string[],
    current: true,
    reject: false,
  };
  const request = vi.fn(async ({ method }: { method: string }) => {
    if (method === "eth_chainId") return state.chain;
    if (method === "eth_accounts") return state.accounts;
    if (method === "eth_signTypedData_v4") {
      if (state.reject)
        throw Object.assign(new Error("sensitive wallet payload"), {
          code: 4001,
        });
      return source.signTypedData(
        receiveTypedData(depositDomain, deposit.authorization),
      );
    }
    throw new Error("unexpected wallet request");
  });
  const wallet = {
    address: source.address,
    switchChain: async () => {},
    getEthereumProvider: async () => ({ request }),
  } as unknown as ConnectedWallet;
  return { source, account, deposit, api, state, wallet, request };
}
describe("funding authorization browser boundary", () => {
  it("signs only the fixed verified domain and receive authorization", async () => {
    const s = setup();
    assertDepositContext(
      s.deposit,
      s.api,
      s.account,
      s.source.address,
      1000000n,
    );
    const signature = await signDepositAuthorization(
      s.api,
      s.deposit,
      s.wallet,
      () => s.state.current,
    );
    expect(
      await recoverTypedDataAddress({
        ...receiveTypedData(depositDomain, s.deposit.authorization),
        signature,
      }),
    ).toBe(s.source.address);
    expect(
      s.request.mock.calls.filter(([v]) => v.method === "eth_signTypedData_v4"),
    ).toHaveLength(1);
  });
  it.each(["environment", "recipient", "amount", "account", "operation"])(
    "rejects changed %s before requesting the funding signature",
    (field) => {
      const s = setup(),
        d = structuredClone(s.deposit);
      if (field === "environment") d.environment = "ctusd-test";
      if (field === "recipient") d.authorization.to = A(1);
      if (field === "amount") d.authorization.value = "2";
      if (field === "account") d.account = A(2);
      if (field === "operation") d.operationId = crypto.randomUUID();
      expect(() =>
        assertDepositContext(d, s.api, s.account, s.source.address, 1000000n),
      ).toThrow();
      expect(s.request).not.toHaveBeenCalled();
    },
  );
  it.each(["wallet", "chain", "context"])(
    "rejects a changed %s without signing",
    async (field) => {
      const s = setup();
      if (field === "wallet") s.state.accounts = [A(1)];
      if (field === "chain") s.state.chain = "0x1";
      if (field === "context") s.state.current = false;
      await expect(
        signDepositAuthorization(
          s.api,
          s.deposit,
          s.wallet,
          () => s.state.current,
        ),
      ).rejects.toMatchObject({ code: "confirmation_context_changed" });
      expect(
        s.request.mock.calls.some(([v]) => v.method === "eth_signTypedData_v4"),
      ).toBe(false);
    },
  );
  it("sanitizes a wallet rejection without exposing the signed request", async () => {
    const s = setup();
    s.state.reject = true;
    await expect(
      signDepositAuthorization(s.api, s.deposit, s.wallet, () => true),
    ).rejects.toMatchObject({ code: "deposit_signature_rejected" });
  });
});
