import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import {
  AppError,
  type VerifiedIdentity,
} from "../../app-core/src/contracts.js";
import { ENTRY_POINT } from "../../app-core/src/kernel.js";
import {
  A,
  H,
  appAccount,
  env,
  operation,
} from "../../app-core/test/fixtures.js";
import { appRuntimeSchema, sponsorConfigSchema } from "../src/config.js";
import {
  AuthenticatedAAGateway,
  type WireUserOperation,
} from "../src/gateway.js";
import { OperationService } from "../src/operations.js";
import { MemoryApplicationStore } from "./memory-store.js";

export const limits = sponsorConfigSchema.parse({
  projectId: "zd-test",
  providerHardLimitUsd: "10.00",
  policyOperator: "and",
  passOnError: false,
  maxCostPerOperation: operation.maxGasCost,
  validitySeconds: 300,
  methodDailyOperations: 20,
  weekly: {
    window: "shanghai-monday",
    projectWei: "100000000000000000",
    exitReserveWei: "20000000000000000",
  },
  exposure: {
    projectWei: "10000000000000000",
    accountWei: "5000000000000000",
    subjectWei: "5000000000000000",
    projectOperations: 10,
    accountOperations: 5,
    subjectOperations: 5,
  },
  exit: {
    projectWei: "10000000000000000",
    accountWei: "5000000000000000",
    subjectWei: "5000000000000000",
    projectOperations: 10,
    accountOperations: 5,
    subjectOperations: 5,
  },
});
const identity: VerifiedIdentity = {
  subject: "did:privy:test",
  controllers: [{ address: appAccount.controller, kind: "external" }],
};
const wire: WireUserOperation = {
  sender: operation.account,
  nonce: "0x0",
  callData: operation.callData,
  callGasLimit: "0x1000",
  verificationGasLimit: "0x1000",
  preVerificationGas: "0x1000",
  maxFeePerGas: "0x1",
  maxPriorityFeePerGas: "0x1",
  paymaster: A(30),
  paymasterData: "0xab",
  paymasterVerificationGasLimit: "0x1000",
  paymasterPostOpGasLimit: "0x1000",
  signature: `0x${"ab".repeat(65)}`,
};
function setup() {
  const store = new MemoryApplicationStore();
  store.accountRows.set(appAccount.id, appAccount);
  store.bindings.set(identity.subject, new Set([appAccount.id]));
  store.records.set(operation.id, {
    operation: structuredClone(operation),
    subject: identity.subject,
    idempotencyKey: randomUUID(),
    requestHash: H(123),
  });
  const client = {
    getCode: vi.fn().mockResolvedValue(undefined),
  } as unknown as PublicClient;
  const reader = {
    async registeredMarket() {
      return true;
    },
    async verifiedRules() {
      return true;
    },
    async listing() {
      return { market: A(1), seller: A(10), active: true };
    },
    async creationPayment() {
      return 1n;
    },
  };
  const service = new OperationService(
    appRuntimeSchema.parse({
      environment: env,
      sponsor: limits,
      allowedOrigins: ["http://127.0.0.1:4198"],
      adminSubjects: [],
    }),
    store,
    client,
    reader,
    () => new Date("2026-09-09T00:01:00Z"),
  );
  const request = vi.fn(
    async (_method: string, _params: readonly unknown[]): Promise<unknown> => {
      const current = await store.operation(operation.id);
      return current!.operation.userOperationHash;
    },
  );
  return {
    store,
    service,
    request,
    gateway: new AuthenticatedAAGateway(service, { request }, { request }),
  };
}
const send = (u: WireUserOperation = wire) => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "eth_sendUserOperation",
  params: [u, ENTRY_POINT.address],
});

describe("authenticated sponsorship and single submission", () => {
  it("submits exactly once across simultaneous tabs and returns the original hash", async () => {
    const { gateway, store, request } = setup();
    const hashes = await Promise.all([
      gateway.request(identity, operation.id, send()),
      gateway.request(identity, operation.id, send()),
    ]);
    expect(hashes[0]).toBe(hashes[1]);
    expect(request).toHaveBeenCalledTimes(1);
    const recorded = await store.operation(operation.id);
    expect(recorded!.operation.state).toBe("submitted");
    expect(JSON.stringify(recorded)).not.toContain(wire.signature);
  });
  it("persists hash before a lost provider response, then queries without resending", async () => {
    const { gateway, store, request } = setup();
    request.mockImplementation(async () => {
      expect(
        (await store.operation(operation.id))!.operation.userOperationHash,
      ).not.toBeNull();
      throw new Error("response lost");
    });
    await expect(
      gateway.request(identity, operation.id, send()),
    ).rejects.toMatchObject({ code: "operation_result_unknown" });
    expect((await store.operation(operation.id))!.operation.state).toBe(
      "unknown",
    );
    const retry = await gateway.request(identity, operation.id, send());
    expect(retry).toMatch(/^0x[\da-f]{64}$/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    { sender: A(999) },
    { nonce: "0x1" },
    { callData: "0xdead" },
    { factory: A(20), factoryData: "0x12" },
  ] as const)("rejects an unbound UserOperation field %j", async (patch) => {
    const { gateway, request } = setup();
    await expect(
      gateway.request(identity, operation.id, send({ ...wire, ...patch })),
    ).rejects.toMatchObject({ code: "user_operation_mismatch" });
    expect(request).not.toHaveBeenCalled();
  });
  it("denies unauthenticated ownership, excessive gas and arbitrary RPC methods", async () => {
    const { gateway, request } = setup();
    await expect(
      gateway.request(
        { ...identity, subject: "did:privy:other" },
        operation.id,
        send(),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      gateway.request(
        identity,
        operation.id,
        send({ ...wire, maxFeePerGas: "0xffffffffffffffff" }),
      ),
    ).rejects.toMatchObject({ code: "gas_cost_exceeds_limit" });
    await expect(
      gateway.request(identity, operation.id, {
        ...send(),
        method: "eth_sendRawTransaction",
      }),
    ).rejects.toMatchObject({ code: "rpc_method_not_allowed" });
    expect(request).not.toHaveBeenCalled();
  });
  it("requires an authenticated exact registration for the AND policy", async () => {
    const { gateway, store } = setup();
    expect(
      await gateway.policy({
        projectId: "zd-test",
        chainId: 421614,
        userOp: wire,
      }),
    ).toEqual({ proceed: true, logicalOperator: "and" });
    for (const body of [
      { projectId: "other", chainId: 421614, userOp: wire },
      { projectId: "zd-test", chainId: 42161, userOp: wire },
      {
        projectId: "zd-test",
        chainId: 421614,
        userOp: { ...wire, callData: "0xdead" },
      },
      {
        projectId: "zd-test",
        chainId: 421614,
        userOp: { ...wire, authorization: {} },
      },
    ])
      expect(await gateway.policy(body)).toEqual({
        proceed: false,
        logicalOperator: "and",
      });
    store.records.clear();
    expect(
      await gateway.policy({
        projectId: "zd-test",
        chainId: 421614,
        userOp: wire,
      }),
    ).toEqual({ proceed: false, logicalOperator: "and" });
  });
  it("does not reuse an idempotency key for changed intent, or a nonce for overlapping operations", async () => {
    const { store } = setup(),
      old = (await store.operation(operation.id))!;
    await expect(
      store.admit({ ...old, requestHash: H(124) }, limits),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      store.admit(
        {
          ...old,
          idempotencyKey: randomUUID(),
          operation: { ...operation, id: randomUUID() },
        },
        limits,
      ),
    ).rejects.toMatchObject({ code: "operation_in_progress" });
  });
  it("validates pre-sponsorship and documented packed callback shapes without accepting mixed arbitrary fields", async () => {
    const { gateway } = setup();
    const {
      paymaster: _paymaster,
      paymasterData: _data,
      paymasterVerificationGasLimit: _verification,
      paymasterPostOpGasLimit: _post,
      ...beforeSponsorship
    } = wire;
    const base = { projectId: "zd-test", chainId: 421614 };
    expect(
      await gateway.policy({ ...base, userOp: beforeSponsorship }),
    ).toEqual({ proceed: true, logicalOperator: "and" });
    expect(
      await gateway.policy({
        ...base,
        userOp: {
          ...beforeSponsorship,
          initCode: "0x",
          paymasterAndData: "0x",
        },
      }),
    ).toEqual({ proceed: true, logicalOperator: "and" });
    expect(
      await gateway.policy({ ...base, userOp: { ...wire, initCode: "0x" } }),
    ).toEqual({ proceed: false, logicalOperator: "and" });
    expect(
      await gateway.policy({
        ...base,
        userOp: { ...beforeSponsorship, maxFeePerGas: "0xffffffffffffffff" },
      }),
    ).toEqual({ proceed: false, logicalOperator: "and" });
  });
  it("keeps exit budget available after the exposure lane is exhausted", async () => {
    const { store } = setup();
    store.records.clear();
    const base = {
      subject: identity.subject,
      requestHash: H(1),
      idempotencyKey: randomUUID(),
      operation: {
        ...operation,
        kind: "buy" as const,
        lane: "exposure" as const,
        maxGasCost: limits.exposure.projectWei,
      },
    };
    await expect(store.admit(base, limits)).rejects.toBeInstanceOf(AppError);
    await expect(
      store.admit(
        {
          ...base,
          operation: { ...operation, id: randomUUID(), lane: "exit" },
        },
        limits,
      ),
    ).resolves.toBeDefined();
  });
  it("will not cancel or re-sign an operation after submission", async () => {
    const { gateway, service } = setup();
    await gateway.request(identity, operation.id, send());
    await expect(service.cancel(identity, operation.id)).rejects.toMatchObject({
      code: "operation_already_submitted",
    });
  });
});
