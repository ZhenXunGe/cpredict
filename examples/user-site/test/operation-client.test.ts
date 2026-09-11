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
