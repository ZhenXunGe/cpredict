import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tradingSessionSchema } from "../../../offchain/app-core/src/trading-session-contracts.js";
import { A } from "../../../offchain/app-core/test/fixtures.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { EIP1193Provider } from "viem";
import {
  appAccount,
  operation,
  env,
  H,
} from "../../../offchain/app-core/test/fixtures.js";
import {
  AppError,
  type Operation,
} from "../../../offchain/app-core/src/contracts.js";
import { SiteApi } from "../src/api.js";
import { UserOperationClient } from "../src/operation-client.js";

const mocks = vi.hoisted(() => ({
  kernel: vi.fn(),
  sessionKernel: vi.fn(),
  accountClient: vi.fn(),
  paymaster: vi.fn(),
  bundler: vi.fn(),
  calls: vi.fn(),
  controller: vi.fn(),
}));
vi.mock("@zerodev/sdk", () => ({
  createKernelAccountClient: mocks.accountClient,
  createZeroDevPaymasterClient: mocks.paymaster,
}));
vi.mock("../../../offchain/app-core/src/kernel.js", async (original) => ({
  ...(await original<object>()),
  createAppKernel: mocks.kernel,
  assertCurrentController: mocks.controller,
}));
vi.mock("../../../offchain/app-core/src/calls.js", async (original) => ({
  ...(await original<object>()),
  buildBusinessCalls: mocks.calls,
}));
vi.mock(
  "../../../offchain/app-core/src/trading-session-kernel.js",
  async (original) => ({
    ...(await original<object>()),
    createSessionKernel: mocks.sessionKernel,
  }),
);
vi.mock("viem/account-abstraction", async (original) => ({
  ...(await original<object>()),
  createBundlerClient: mocks.bundler,
}));

function setup(balance = 1000000n) {
  const sign = vi.fn().mockResolvedValue("0x1234"),
    send = vi.fn().mockResolvedValue(H(20));
  const unsigned = {
    sender: appAccount.address,
    nonce: 0n,
    callData: operation.callData,
    callGasLimit: 100n,
    verificationGasLimit: 200n,
    preVerificationGas: 100n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  };
  mocks.kernel.mockResolvedValue({
    address: appAccount.address,
    encodeCalls: async () => operation.callData,
    signUserOperation: sign,
  });
  mocks.calls.mockResolvedValue(operation.calls);
  mocks.controller.mockResolvedValue(undefined);
  mocks.paymaster.mockReturnValue({ sponsorUserOperation: vi.fn() });
  mocks.accountClient.mockReturnValue({
    prepareUserOperation: vi.fn().mockResolvedValue(unsigned),
  });
  mocks.bundler.mockReturnValue({ sendUserOperation: send });
  const api = new SiteApi(env);
  const publicClient = {
    getBlock: async () => ({ timestamp: 1n }),
    getBalance: vi.fn().mockResolvedValue(balance),
    readContract: vi.fn().mockResolvedValue(0n),
  };
  vi.spyOn(api, "publicClient").mockReturnValue(publicClient as never);
  let saved: Operation | undefined;
  const request = vi
    .spyOn(api, "request")
    .mockImplementation(async (path, schema, options) => {
      let value: unknown;
      if (path.startsWith("/v1/operations?"))
        value = { items: saved ? [saved] : [] };
      else if (path === "/v1/operations/prepare")
        value = {
          account: appAccount,
          nonce: "0",
          calls: operation.calls,
          callData: operation.callData,
          factory: null,
          factoryData: null,
          maxGasCost: operation.maxGasCost,
          expiresInSeconds: 300,
        };
      else if (path === "/v1/operations") {
        expect(options?.body).toMatchObject({ gasPayment: "self-funded" });
        saved = {
          ...operation,
          gasPayment: "self-funded",
          sponsorshipAttempted: false,
        };
        value = { operation: saved };
      } else if (path === `/v1/operations/${operation.id}`)
        value = {
          operation: send.mock.calls.length
            ? { ...saved!, state: "submitted", userOperationHash: H(20) }
            : saved,
        };
      else throw new Error(`unexpected path ${path}`);
      return (schema as z.ZodType).parse(value);
    });
  let current = true;
  const client = new UserOperationClient(
    api,
    appAccount,
    async () => ({ request: vi.fn() }) as unknown as EIP1193Provider,
    () => current,
  );
  return {
    api,
    client,
    sign,
    send,
    request,
    unsigned,
    publicClient,
    invalidate: () => {
      current = false;
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  vi.stubGlobal("navigator", {});
});

describe("purchase preflight and signature stage", () => {
  const buy = {
    kind: "buy" as const,
    market: A(40),
    outcomeId: "0",
    units: "20000000",
    minUnits: "20000000",
    maxPayment: "20000000",
    deadline: "900",
  };
  it("rejects an impossible purchase before registration, kernel or wallet access", async () => {
    const f = setup();
    f.publicClient.readContract.mockImplementation(
      async ({ functionName }) =>
        ({
          perUserPrimaryCap: 10000000n,
          marketPrimaryCap: 100000000n,
          totalPrincipal: 0n,
          cumulativePrimaryBought: 0n,
          minimumPrimaryUnits: 10000n,
        })[functionName as "perUserPrimaryCap"],
    );
    await expect(f.client.submit(buy, vi.fn(), vi.fn())).rejects.toMatchObject({
      code: "primary_account_cap",
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(mocks.kernel).not.toHaveBeenCalled();
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("fails closed if capacity cannot be read", async () => {
    const f = setup();
    f.publicClient.readContract.mockRejectedValue(new Error("offline"));
    await expect(f.client.submit(buy, vi.fn(), vi.fn())).rejects.toMatchObject({
      code: "operation_preparation_failed",
    });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.sign).not.toHaveBeenCalled();
  });
  it("recovers an existing registration before attempting new purchase preparation", async () => {
    const f = setup();
    sessionStorage.setItem(
      `cpredict-register:${f.api.key}:${appAccount.id}`,
      operation.id,
    );
    f.request.mockImplementation(async (_path, schema) =>
      schema.parse({ items: [operation] }),
    );
    expect(await f.client.submit(buy, vi.fn(), vi.fn())).toEqual(operation);
    expect(f.publicClient.readContract).not.toHaveBeenCalled();
    expect(mocks.kernel).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("explains a simulation failure without falsely requesting a wallet signature", async () => {
    const f = setup();
    mocks.accountClient.mockReturnValue({
      prepareUserOperation: vi
        .fn()
        .mockRejectedValue(new Error("simulation failure")),
    });
    await expect(
      f.client.submit(operation.intent, vi.fn(), vi.fn(), {
        payment: "self-funded",
        confirm: async () => {},
      }),
    ).rejects.toMatchObject({
      code: "operation_preparation_failed_before_signing",
      operationId: operation.id,
    });
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("keeps failures after a signature request query-only", async () => {
    const f = setup();
    f.sign.mockRejectedValue(new Error("wallet disconnected"));
    await expect(
      f.client.submit(operation.intent, vi.fn(), vi.fn(), {
        payment: "self-funded",
        confirm: async () => {},
      }),
    ).rejects.toMatchObject({ code: "operation_query_required" });
    expect(f.sign).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe("self-funded UserOperation consent", () => {
  it("uses no paymaster, waits for explicit cost approval, and submits the same signed operation once", async () => {
    const s = setup(),
      onRecord = vi.fn(),
      onStage = vi.fn();
    let approve!: () => void;
    const confirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          approve = resolve;
        }),
    );
    const pending = s.client.submit(operation.intent, onRecord, onStage, {
      payment: "self-funded",
      confirm,
    });
    await vi.waitFor(() =>
      expect(confirm).toHaveBeenCalledWith({ cost: 800n, balance: 1000000n }),
    );
    expect(mocks.accountClient.mock.calls[0]![0].paymaster).toBeUndefined();
    expect(s.sign).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
    approve();
    await pending;
    expect(s.sign).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send.mock.calls[0]![0]).not.toHaveProperty("paymaster");
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([
      "preparing",
      "reviewing-gas",
      "awaiting-signature",
      "submitting",
    ]);
  });
  it("rejects insufficient ETH before wallet signing and never silently requests sponsorship", async () => {
    const s = setup(100n),
      confirm = vi.fn();
    await expect(
      s.client.submit(operation.intent, vi.fn(), vi.fn(), {
        payment: "self-funded",
        confirm,
      }),
    ).rejects.toMatchObject({ code: "self_funded_balance_insufficient" });
    expect(confirm).not.toHaveBeenCalled();
    expect(s.sign).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });
  it.each(["cancel", "account", "balance", "account-after-approval"])(
    "does not sign after a changed %s while reviewing fees",
    async (kind) => {
      const s = setup();
      const confirm = async () => {
        if (kind === "cancel")
          throw new AppError("confirmation_context_changed", 409);
        if (kind === "account") s.invalidate();
        if (kind === "balance") s.publicClient.getBalance.mockResolvedValue(0n);
        if (kind === "account-after-approval")
          s.publicClient.getBalance.mockImplementation(async () => {
            s.invalidate();
            return 1000000n;
          });
      };
      await expect(
        s.client.submit(operation.intent, vi.fn(), vi.fn(), {
          payment: "self-funded",
          confirm,
        }),
      ).rejects.toBeDefined();
      expect(s.sign).not.toHaveBeenCalled();
      expect(s.send).not.toHaveBeenCalled();
    },
  );
});

describe("quick trading signer boundary", () => {
  function quick() {
    const f = setup(),
      privateKey = generatePrivateKey();
    const session = tradingSessionSchema.parse({
      id: crypto.randomUUID(),
      accountId: appAccount.id,
      account: appAccount.address,
      controller: appAccount.controller,
      publicKey: privateKeyToAccount(privateKey).address,
      environment: env.id,
      deploymentId: env.deployment.id,
      permissionId: "0x12345678",
      state: "active",
      createdAt: new Date().toISOString(),
      validAfter: "0",
      validUntil: String(Math.floor(Date.now() / 1000) + 86400),
      perOperation: "100000000",
      total: "1000000000",
      authorizationHash: H(1),
      config: {
        enabled: true,
        version: 1,
        policy: A(21),
        policyCodeHash: H(2),
        signer: A(22),
        signerCodeHash: H(3),
        paymaster: A(23),
      },
    });
    const controller = vi.fn(async () => {
        throw new Error("controller must not be requested");
      }),
      credential = vi.fn(async () => ({
        session,
        privateKey,
        enableSignature: `0x${"11".repeat(65)}` as `0x${string}`,
      }));
    const nonce = 4242n;
    mocks.sessionKernel.mockResolvedValue({
      address: appAccount.address,
      encodeCalls: async () => operation.callData,
      signUserOperation: f.sign,
    });
    mocks.accountClient.mockReturnValue({
      prepareUserOperation: vi.fn(async () => ({
        ...f.unsigned,
        nonce,
        paymaster: session.config.paymaster,
      })),
    });
    let registered: Operation;
    f.request.mockImplementation(async (path, schema, options) => {
      let result;
      if (path === "/v1/operations/prepare")
        result = {
          account: appAccount,
          calls: operation.calls,
          callData: operation.callData,
          nonce: nonce.toString(),
          factory: null,
          factoryData: null,
          maxGasCost: operation.maxGasCost,
          expiresInSeconds: 300,
          signingMode: "session",
          sessionId: session.id,
        };
      else if (path === "/v1/operations") {
        expect(options?.body).toMatchObject({
          nonce: nonce.toString(),
          signingMode: "session",
          sessionId: session.id,
          gasPayment: "sponsored",
        });
        registered = {
          ...operation,
          nonce: nonce.toString(),
          signingMode: "session",
          sessionId: session.id,
          gasPayment: "sponsored",
        };
        result = { operation: registered };
      } else if (path === `/v1/trading-sessions/${session.id}`)
        result = { session, spent: "0", pending: "0", revoked: false };
      else if (path === `/v1/operations/${operation.id}`)
        result = {
          operation: {
            ...registered,
            state: f.send.mock.calls.length
              ? "submitted"
              : "awaiting-signature",
            userOperationHash: f.send.mock.calls.length ? H(20) : null,
          },
        };
      else result = { items: [] };
      return (schema as z.ZodType).parse(result);
    });
    vi.stubGlobal("navigator", {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          run: (lock: object) => unknown,
        ) => run({}),
      },
    });
    const client = new UserOperationClient(
      f.api,
      appAccount,
      controller,
      () => true,
      credential,
    );
    return { ...f, client, controller, credential, session };
  }
  it("submits two operations with the session signer and permission nonce, never requesting a controller provider", async () => {
    const f = quick();
    for (let i = 0; i < 2; i++)
      expect(
        (await f.client.submit(operation.intent, vi.fn(), vi.fn())).state,
      ).toBe("submitted");
    expect(f.controller).not.toHaveBeenCalled();
    expect(mocks.kernel).not.toHaveBeenCalled();
    expect(mocks.sessionKernel).toHaveBeenCalledTimes(2);
    expect(f.sign).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it("uses a cached session kernel but aborts when logout invalidates a pending signature", async () => {
    const f = quick(),
      credential = await f.credential();
    let valid = true;
    const cached = {
      address: appAccount.address,
      encodeCalls: async () => operation.callData,
      signUserOperation: async () => {
        valid = false;
        return "0x1234";
      },
    };
    f.credential.mockImplementation(async () => ({
      ...credential,
      kernel: async () => cached as never,
      assertCurrent: () => {
        if (!valid) throw new AppError("confirmation_context_changed", 409);
      },
    }));
    await expect(
      f.client.submit(operation.intent, vi.fn(), vi.fn()),
    ).rejects.toMatchObject({ code: "confirmation_context_changed" });
    expect(mocks.sessionKernel).not.toHaveBeenCalled();
    expect(f.controller).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("does not fall back to the controller when a session expires or self funding is selected", async () => {
    const f = quick();
    f.credential.mockRejectedValue(
      new AppError("trading_session_unavailable", 409),
    );
    await expect(
      f.client.submit(operation.intent, vi.fn(), vi.fn()),
    ).rejects.toMatchObject({ code: "trading_session_unavailable" });
    await expect(
      f.client.submit(operation.intent, vi.fn(), vi.fn(), {
        payment: "self-funded",
        confirm: async () => {},
      }),
    ).rejects.toMatchObject({ code: "trading_session_requires_sponsorship" });
    expect(f.controller).not.toHaveBeenCalled();
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
});

describe("creation-time preflight", () => {
  const intent = {
    kind: "create-market" as const,
    userSalt: H(70),
    maxPayment: "10000000",
    params: {
      rulesHash: H(71),
      metadataURI: "https://example.com/rules.json",
      resolutionSourceHash: H(72),
      resolutionSourceURI: "https://example.com/source",
      outcomeCount: 2,
      closeAt: "361",
      eventStartsAt: "0",
      outcomeDeadlineAt: "3000",
      creatorTreasury: A(10),
      deploymentMode: 0 as const,
      featureFlags: "0",
      creatorRakeBps: 200,
      creatorC2CFeeBps: 0,
      perUserPrimaryCap: "1000000",
      marketPrimaryCap: "20000000",
      minimumPrimaryUnits: "10000",
      minimumC2CUnits: "10000",
      creatorBond: "10000000",
    },
  };
  it("blocks a near-close creation before wallet access or operation registration", async () => {
    const f = setup();
    vi.spyOn(f.publicClient, "getBlock").mockResolvedValue({ timestamp: 62n });
    await expect(
      f.client.submit(intent, vi.fn(), vi.fn()),
    ).rejects.toMatchObject({ code: "creation_close_too_soon" });
    expect(f.request).not.toHaveBeenCalled();
    expect(mocks.kernel).not.toHaveBeenCalled();
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("rechecks after slow gas preparation before requesting the signature", async () => {
    const f = setup();
    vi.spyOn(f.publicClient, "getBlock")
      .mockResolvedValueOnce({ timestamp: 1n })
      .mockResolvedValue({ timestamp: 62n });
    await expect(
      f.client.submit(intent, vi.fn(), vi.fn(), {
        payment: "self-funded",
        confirm: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "creation_close_too_soon" });
    expect(mocks.accountClient).toHaveBeenCalled();
    expect(f.sign).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
});
