import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  keccak256,
  stringToHex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  AppError,
  depositPrepareSchema,
  environmentSchema,
  intentSchema,
  type BusinessIntent,
} from "../../app-core/src/contracts.js";
import {
  receiveTypedData,
  USDC_ADDRESS,
  usdcAbi,
  RECEIVE_TYPEHASH,
} from "../../app-core/src/usdc.js";
import * as kernel from "../../app-core/src/kernel.js";
import {
  A,
  H,
  appAccount,
  env,
  operation,
} from "../../app-core/test/fixtures.js";
import { appRuntimeSchema, sponsorConfigSchema } from "../src/config.js";
import { OperationService } from "../src/operations.js";
import {
  AuthenticatedAAGateway,
  type WireUserOperation,
} from "../src/gateway.js";
import { assertQuota } from "../src/store.js";
import { MemoryApplicationStore } from "./memory-store.js";
import { createApplicationServer } from "../src/server.js";
import { OperationRecovery } from "../src/recovery.js";

afterEach(() => vi.restoreAllMocks());
function setup() {
  const source = privateKeyToAccount(generatePrivateKey());
  const now = new Date("2026-09-11T00:00:00.000Z");
  const environment = environmentSchema.parse({
    ...env,
    id: "usdc-test",
    asset: "USDC",
    deployment: { ...env.deployment, paymentToken: USDC_ADDRESS },
    account: { ...env.account, index: "1002" },
    features: { ...env.features, faucet: false, gaslessDeposit: true },
  });
  const account = { ...appAccount, environment: environment.id, index: "1002" };
  const identity = {
    subject: "did:privy:test",
    controllers: [{ address: account.controller, kind: "external" as const }],
  };
  const cap = {
    projectWei: "100000000000000000",
    accountWei: "100000000000000000",
    subjectWei: "100000000000000000",
    projectOperations: 100,
    accountOperations: 100,
    subjectOperations: 100,
  };
  const limits = sponsorConfigSchema.parse({
    projectId: "test",
    providerHardLimitUsd: "1.00",
    policyOperator: "and",
    passOnError: false,
    maxCostPerOperation: operation.maxGasCost,
    validitySeconds: 300,
    methodDailyOperations: 20,
    exposure: cap,
    exit: cap,
    weekly: {
      window: "shanghai-monday",
      projectWei: "100000000000000000",
      exitReserveWei: "20000000000000000",
    },
  });
  const runtime = appRuntimeSchema.parse({
    environment,
    sponsor: limits,
    allowedOrigins: ["http://127.0.0.1:4198"],
    adminSubjects: [],
  });
  const store = new MemoryApplicationStore();
  store.accountRows.set(account.id, account);
  store.bindings.set(identity.subject, new Set([account.id]));
  const state = {
    balance: 2000000n,
    used: false,
    paused: false,
    blacklisted: false,
    sourceCode: undefined as `0x${string}` | undefined,
    separator:
      "0x85944e1292d007732838d6eadfa67589b78ffcededbd4df60488d0af251308bb",
  };
  const client = {
    getChainId: async () => 421614,
    getCode: vi.fn(async ({ address }: { address: string }) =>
      address.toLowerCase() === USDC_ADDRESS.toLowerCase()
        ? "0x6000"
        : address.toLowerCase() === source.address.toLowerCase()
          ? state.sourceCode
          : undefined,
    ),
    getBlock: async () => ({
      number: 10n,
      timestamp: BigInt(Math.floor(now.getTime() / 1000)),
    }),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "name":
          return "USD Coin";
        case "decimals":
          return 6;
        case "DOMAIN_SEPARATOR":
          return state.separator;
        case "RECEIVE_WITH_AUTHORIZATION_TYPEHASH":
          return RECEIVE_TYPEHASH;
        case "balanceOf":
          return state.balance;
        case "authorizationState":
          return state.used;
        case "paused":
          return state.paused;
        case "isBlacklisted":
          return state.blacklisted;
        default:
          throw new Error(`unexpected read ${functionName}`);
      }
    }),
  };
  vi.spyOn(kernel, "createAppKernel").mockResolvedValue({
    address: account.address,
    getNonce: async () => 0n,
    getFactoryArgs: async () => ({}),
    encodeCalls: async (calls: unknown) =>
      keccak256(
        stringToHex(
          JSON.stringify(calls, (_, v: unknown) =>
            typeof v === "bigint" ? v.toString() : v,
          ),
        ),
      ),
  } as unknown as Awaited<ReturnType<typeof kernel.createAppKernel>>);
  const reader = {
    registeredMarket: async () => true,
    verifiedRules: async () => true,
    listing: async () => ({ market: A(1), seller: A(2), active: true }),
    creationPayment: async () => 1n,
  };
  const service = new OperationService(
    runtime,
    store,
    client as unknown as PublicClient,
    reader,
    () => now,
  );
  const input = depositPrepareSchema.parse({
    accountId: account.id,
    source: source.address,
    amount: "1000000",
    idempotencyKey: randomUUID(),
  });
  const authorize = async () => {
    const deposit = await service.deposits.prepare(identity, input);
    const signature = await source.signTypedData(
      receiveTypedData(deposit.domain, deposit.authorization),
    );
    const intent = intentSchema.parse({
      kind: "deposit-usdc",
      depositId: deposit.id,
      authorization: deposit.authorization,
      signature,
    }) as Extract<BusinessIntent, { kind: "deposit-usdc" }>;
    return { deposit, intent };
  };
  const register = async (intent: BusinessIntent) => {
    const prepared = await service.prepare(identity, account.id, intent);
    const request = {
      environment: environment.id,
      deploymentId: environment.deployment.id,
      accountId: account.id,
      idempotencyKey: randomUUID(),
      intent,
      nonce: prepared.nonce,
      callData: prepared.callData,
      factory: prepared.factory,
      factoryData: prepared.factoryData,
    };
    return { request, record: await service.register(identity, request) };
  };
  return {
    source,
    now,
    environment,
    account,
    identity,
    limits,
    runtime,
    store,
    state,
    client,
    service,
    input,
    authorize,
    register,
  };
}

describe("USDC signed deposit admission", () => {
  it("enforces HTTP ownership, environment, idempotency and read-only administrator boundaries", async () => {
    const s = setup(),
      transport = { request: vi.fn(async () => null) };
    s.runtime.adminSubjects = ["did:privy:admin"];
    const server = await createApplicationServer({
      operations: s.service,
      auth: {
        verify: async (token) => ({
          ...s.identity,
          subject: `did:privy:${token}`,
        }),
      },
      gateway: new AuthenticatedAAGateway(s.service, transport, transport),
      recovery: new OperationRecovery(
        s.store,
        s.client as unknown as PublicClient,
        transport,
        2,
      ),
      chainRpc: transport,
    });
    const headers = { authorization: "Bearer test" };
    try {
      expect(
        (
          await server.inject({
            method: "POST",
            url: "/v1/deposits/prepare",
            payload: s.input,
          })
        ).statusCode,
      ).toBe(401);
      const reply = await server.inject({
        method: "POST",
        url: "/v1/deposits/prepare",
        headers,
        payload: s.input,
      });
      expect(reply.statusCode).toBe(200);
      const d = reply.json().deposit;
      expect(
        (
          await server.inject({
            method: "POST",
            url: "/v1/deposits/prepare",
            headers,
            payload: s.input,
          })
        ).json().deposit.id,
      ).toBe(d.id);
      expect(
        (
          await server.inject({
            url: `/v1/deposits/${d.id}`,
            headers: { authorization: "Bearer other" },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await server.inject({
            url: `/v1/deposits?accountId=${s.account.id}`,
            headers: { ...headers, "x-cpredict-environment": "ctusd-test" },
          })
        ).statusCode,
      ).toBe(409);
      const page = await server.inject({
        url: `/v1/deposits?accountId=${s.account.id}&active=true`,
        headers,
      });
      expect(page.json().items.map((v: { id: string }) => v.id)).toEqual([
        d.id,
      ]);
      const report =
        "/v1/ops/deposits?start=2026-09-11T00:00:00.000Z&end=2026-09-12T00:00:00.000Z";
      expect((await server.inject({ url: report, headers })).statusCode).toBe(
        403,
      );
      const admin = await server.inject({
        url: report,
        headers: { authorization: "Bearer admin" },
      });
      expect(admin.statusCode).toBe(200);
      expect(admin.json().items[0].authorization.value).toBe("1000000");
      expect(admin.body).not.toContain('"signature":');
      expect(admin.body).not.toContain(s.identity.subject);
      expect(
        (
          await server.inject({
            method: "POST",
            url: `/v1/deposits/${d.id}/cancel`,
            headers,
            payload: {},
          })
        ).json().deposit.state,
      ).toBe("cancelled");
      expect(
        (
          await server.inject({
            url: `/v1/deposits?accountId=${s.account.id}&active=true`,
            headers,
          })
        ).json().items,
      ).toEqual([]);
    } finally {
      await server.close();
    }
  });
  it("prepares an independent EOA authorization once, without assigning it controller rights", async () => {
    const s = setup(),
      a = await s.service.deposits.prepare(s.identity, s.input);
    expect(await s.service.deposits.prepare(s.identity, s.input)).toEqual(a);
    expect(a.authorization).toMatchObject({
      from: s.source.address,
      to: s.account.address,
      value: "1000000",
      validAfter: "0",
    });
    expect(
      BigInt(a.authorization.validBefore) - BigInt(s.now.getTime() / 1000),
    ).toBe(600n);
    expect(s.store.accountRows.size).toBe(1);
    expect(s.identity.controllers.map((c) => c.address)).not.toContain(
      s.source.address,
    );
    expect(JSON.stringify(a)).not.toContain("signature");
    await expect(
      s.service.deposits.prepare(s.identity, { ...s.input, amount: "2000000" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      s.service.deposits.prepare(s.identity, {
        ...s.input,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "deposit_in_progress" });
    await expect(
      s.service.deposits.owned(
        { ...s.identity, subject: "did:privy:other" },
        a.id,
      ),
    ).rejects.toMatchObject({ code: "deposit_not_found" });
  });
  it("reconstructs a single receive call, registers atomically and recovers the original operation", async () => {
    const s = setup(),
      { deposit, intent } = await s.authorize(),
      { request, record } = await s.register(intent);
    expect(record.lane).toBe("exposure");
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]!.to).toBe(USDC_ADDRESS);
    const decoded = decodeFunctionData({
      abi: usdcAbi,
      data: record.calls[0]!.data,
    });
    expect(decoded.functionName).toBe("receiveWithAuthorization");
    expect(decoded.args?.slice(0, 3)).toEqual([
      s.source.address,
      s.account.address,
      1000000n,
    ]);
    expect(
      (await s.service.deposits.owned(s.identity, deposit.id)).operationId,
    ).toBe(record.id);
    expect((await s.service.register(s.identity, request)).id).toBe(record.id);
    await expect(
      s.service.register(s.identity, {
        ...request,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "deposit_already_registered",
      operationId: record.id,
    });
    expect(s.store.records.size).toBe(1);
  });
  it.each(["from", "to", "value", "nonce", "validBefore"] as const)(
    "rejects tampered %s before reserving any sponsorship",
    async (field) => {
      const s = setup(),
        { intent } = await s.authorize();
      const values = {
        from: A(90),
        to: A(91),
        value: "2",
        nonce: H(91),
        validBefore: "9999999999",
      };
      const changed = {
        ...intent,
        authorization: { ...intent.authorization, [field]: values[field] },
      };
      await expect(
        s.service.prepare(s.identity, s.account.id, changed),
      ).rejects.toBeInstanceOf(AppError);
      expect(s.store.records.size).toBe(0);
    },
  );
  it("checks the signer and signing domain, including domain changes at the token", async () => {
    const s = setup(),
      { intent, deposit } = await s.authorize();
    const stranger = privateKeyToAccount(generatePrivateKey());
    for (const signature of [
      await stranger.signTypedData(
        receiveTypedData(deposit.domain, deposit.authorization),
      ),
      await s.source.signTypedData({
        ...receiveTypedData(deposit.domain, deposit.authorization),
        domain: { ...deposit.domain, chainId: 1 },
      }),
    ]) {
      await expect(
        s.service.prepare(s.identity, s.account.id, { ...intent, signature }),
      ).rejects.toMatchObject({ code: "deposit_signature_invalid" });
    }
    s.state.separator = H(0);
    await expect(
      s.service.prepare(s.identity, s.account.id, intent),
    ).rejects.toMatchObject({ code: "usdc_authorization_unavailable" });
  });
  it("requires enough authorization lifetime for the complete AA admission window", async () => {
    const s = setup(),
      { intent } = await s.authorize();
    s.now.setTime(s.now.getTime() + 300000);
    await expect(
      s.service.prepare(s.identity, s.account.id, intent),
    ).rejects.toMatchObject({ code: "deposit_authorization_expired" });
    expect(s.store.records.size).toBe(0);
  });
  it.each(["used", "balance", "paused", "blacklisted", "sourceCode"] as const)(
    "rechecks %s at gateway and policy, after registration",
    async (field) => {
      const s = setup(),
        { intent } = await s.authorize(),
        { record } = await s.register(intent);
      if (field === "used") s.state.used = true;
      if (field === "balance") s.state.balance = 0n;
      if (field === "paused") s.state.paused = true;
      if (field === "blacklisted") s.state.blacklisted = true;
      if (field === "sourceCode") s.state.sourceCode = "0x6000";
      const wire: WireUserOperation = {
        sender: record.account,
        nonce: "0x0",
        callData: record.callData,
        callGasLimit: "0x1000",
        verificationGasLimit: "0x1000",
        preVerificationGas: "0x1000",
        maxFeePerGas: "0x1",
        maxPriorityFeePerGas: "0x1",
        signature: "0x",
      };
      const transport = { request: vi.fn(async () => ({})) },
        gateway = new AuthenticatedAAGateway(s.service, transport, transport);
      await expect(
        gateway.request(s.identity, record.id, {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_estimateUserOperationGas",
          params: [wire, kernel.ENTRY_POINT.address],
        }),
      ).rejects.toBeInstanceOf(AppError);
      expect(
        await gateway.policy({
          projectId: s.limits.projectId,
          chainId: 421614,
          userOp: wire,
        }),
      ).toEqual({ proceed: false, logicalOperator: "and" });
      expect(transport.request).not.toHaveBeenCalled();
      expect(
        s.store.records.get(record.id)?.operation.userOperationHash,
      ).toBeNull();
    },
  );
  it("closing only the deposit feature blocks new sponsorship and preserves queries", async () => {
    const s = setup(),
      { intent, deposit } = await s.authorize(),
      { record } = await s.register(intent);
    s.runtime.environment.features.gaslessDeposit = false;
    await expect(
      s.service.deposits.validate(
        s.identity.subject,
        s.account.id,
        s.account.address,
        intent,
        0,
        record.id,
      ),
    ).rejects.toMatchObject({ code: "gasless_deposit_disabled" });
    expect(
      (await s.service.deposits.owned(s.identity, deposit.id)).operationId,
    ).toBe(record.id);
  });
  it("cancels before submission, and keeps submitted unknown deposits active after expiry", async () => {
    const s = setup(),
      { intent, deposit } = await s.authorize(),
      { record } = await s.register(intent);
    await s.store.transition(record.id, ["awaiting-signature"], {
      state: "unknown",
      userOperationHash: H(99),
    });
    s.now.setTime(s.now.getTime() + 3600000);
    await expect(
      s.service.deposits.cancel(s.identity, deposit.id),
    ).rejects.toMatchObject({ code: "operation_already_submitted" });
    expect((await s.service.deposits.owned(s.identity, deposit.id)).state).toBe(
      "unknown",
    );
    await expect(
      s.service.deposits.prepare(s.identity, {
        ...s.input,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "deposit_in_progress" });
  });
  it("cancellation of an unsigned preparation does not consume a source quota", async () => {
    const s = setup(),
      { deposit } = await s.authorize();
    expect(
      (await s.service.deposits.cancel(s.identity, deposit.id)).state,
    ).toBe("cancelled");
    expect(s.store.records.size).toBe(0);
    expect(
      (
        await s.service.deposits.prepare(s.identity, {
          ...s.input,
          idempotencyKey: randomUUID(),
        })
      ).id,
    ).not.toBe(deposit.id);
  });
  it("limits one verified source across different accounts and login subjects", async () => {
    const s = setup(),
      { intent } = await s.authorize(),
      { record } = await s.register(intent);
    const existing = s.store.records.get(record.id)!;
    const next = {
      ...existing,
      subject: "did:privy:second",
      operation: {
        ...record,
        id: randomUUID(),
        accountId: randomUUID(),
        nonce: "1",
      },
    };
    expect(() =>
      assertQuota([existing], next, { ...s.limits, methodDailyOperations: 1 }),
    ).toThrowError(
      expect.objectContaining({ code: "deposit_source_quota_exhausted" }),
    );
  });
  it("keeps existing ctUSD configuration valid with deposits absent or disabled", () => {
    expect(
      environmentSchema.parse(env).features.gaslessDeposit,
    ).toBeUndefined();
    expect(() =>
      environmentSchema.parse({
        ...env,
        features: { ...env.features, gaslessDeposit: true },
      }),
    ).toThrow();
    expect(() =>
      depositPrepareSchema.parse({
        accountId: appAccount.id,
        source: A(1),
        amount: "0",
        idempotencyKey: randomUUID(),
      }),
    ).toThrow();
  });
});
