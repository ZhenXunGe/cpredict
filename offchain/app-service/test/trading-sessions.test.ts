import { afterEach, describe, expect, it, vi } from "vitest";
import { hashTypedData, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  appAccount,
  env,
  operation,
  A,
  H,
} from "../../app-core/test/fixtures.js";
import {
  AppError,
  environmentSchema,
  quickTradingConfigSchema,
  type Operation,
} from "../../app-core/src/contracts.js";
import {
  sessionSpend,
  supportsQuickTrading,
} from "../../app-core/src/trading-session-contracts.js";
import * as sdk from "../../app-core/src/trading-session-kernel.js";
import { TradingSessions } from "../src/trading-sessions.js";
import { assertTradingSessionQuota } from "../src/store.js";
import type { OperationService } from "../src/operations.js";
import { verifyQuickTrading } from "../src/chain.js";
import { MemoryApplicationStore } from "./memory-store.js";

export const quickConfig = quickTradingConfigSchema.parse({
  enabled: true,
  version: 1,
  policy: A(101),
  policyCodeHash: H(1),
  signer: A(102),
  signerCodeHash: H(2),
  paymaster: A(103),
});
afterEach(() => vi.restoreAllMocks());
function setup() {
  const owner = privateKeyToAccount(generatePrivateKey()),
    key = privateKeyToAccount(generatePrivateKey());
  const account = { ...appAccount, controller: owner.address };
  const identity = {
    subject: "session-user",
    controllers: [{ address: owner.address, kind: "external" as const }],
  };
  const store = new MemoryApplicationStore();
  const clock = {
    now: new Date("2026-09-14T08:00:00.000Z"),
    nonce: 1n,
    spent: 0n,
    revoked: false,
  };
  const environment = { ...env, quickTrading: structuredClone(quickConfig) };
  const controlledAccount = vi.fn(async (_identity: unknown, id: string) => {
    if (id !== account.id) throw new AppError("account_not_found", 404);
    return account;
  });
  const typed = () => ({
    domain: {
      name: "Kernel",
      version: "0.3.1",
      chainId: 421614,
      verifyingContract: account.address,
    },
    types: { Enable: [{ name: "nonce", type: "uint256" }] },
    primaryType: "Enable" as const,
    message: { nonce: clock.nonce },
  });
  vi.spyOn(sdk, "createSessionKernel").mockResolvedValue({
    address: account.address,
    kernelPluginManager: { getPluginsEnableTypedData: async () => typed() },
  } as never);
  const client = {
    readContract: vi.fn(async () => [
      100000000n,
      1000000000n,
      clock.spent,
      0,
      0,
      true,
      clock.revoked,
    ]),
  };
  const service = {
    runtime: { environment },
    store,
    client,
    controlledAccount,
    now: () => clock.now,
  } as unknown as OperationService;
  const sessions = new TradingSessions(service);
  const prepare = () =>
    sessions.prepare(identity, {
      accountId: account.id,
      publicKey: key.address,
      perOperation: "100000000",
      total: "1000000000",
    });
  const active = async () => {
    const s = await prepare();
    const signature = await owner.signTypedData(typed());
    return sessions.activate(identity, s.id, signature);
  };
  const buy = {
    kind: "buy" as const,
    market: A(10),
    outcomeId: "0",
    units: "1",
    minUnits: "1",
    maxPayment: "100000000",
    deadline: "2000000000",
  };
  return {
    sessions,
    identity,
    account,
    clock,
    environment,
    store,
    owner,
    key,
    typed,
    prepare,
    active,
    buy,
    client,
    controlledAccount,
  };
}
describe("browser trading session permissions", () => {
  it("prepares canonical public metadata and verifies one controller authorization without retaining its signature", async () => {
    const f = setup(),
      s = await f.prepare();
    expect(s.authorizationHash).toBe(hashTypedData(f.typed()));
    expect(BigInt(s.validUntil) - BigInt(s.validAfter)).toBe(86400n);
    const signature = await f.owner.signTypedData(f.typed());
    const active = await f.sessions.activate(f.identity, s.id, signature);
    expect(active.state).toBe("active");
    expect(JSON.stringify([...f.store.sessions.values()])).not.toContain(
      signature,
    );
    expect(f.controlledAccount).toHaveBeenCalledWith(f.identity, s.accountId);
  });
  it("rejects another controller, another user, and a changed Kernel authorization nonce", async () => {
    const f = setup(),
      s = await f.prepare();
    await expect(
      f.sessions.activate(
        f.identity,
        s.id,
        await f.key.signTypedData(f.typed()),
      ),
    ).rejects.toMatchObject({ code: "invalid_session_authorization" });
    await expect(
      f.sessions.owned({ ...f.identity, subject: "other" }, s.id),
    ).rejects.toMatchObject({ code: "trading_session_not_found" });
    const signature = await f.owner.signTypedData(f.typed());
    f.clock.nonce++;
    await expect(
      f.sessions.activate(f.identity, s.id, signature),
    ).rejects.toMatchObject({ code: "invalid_session_authorization" });
  });
  it("enforces limits, expiry, revocation and explicit sponsorship", async () => {
    const f = setup(),
      s = await f.active();
    await expect(
      f.sessions.usable(f.identity, s.id, s.accountId, f.buy),
    ).resolves.toMatchObject({ id: s.id });
    f.clock.spent = 950000000n;
    await expect(
      f.sessions.usable(f.identity, s.id, s.accountId, f.buy),
    ).rejects.toMatchObject({ code: "trading_session_budget_exceeded" });
    f.clock.spent = 0n;
    f.clock.revoked = true;
    await expect(
      f.sessions.usable(f.identity, s.id, s.accountId, f.buy),
    ).rejects.toMatchObject({ code: "trading_session_unavailable" });
    f.clock.revoked = false;
    f.clock.now = new Date(Number(s.validUntil) * 1000);
    await expect(
      f.sessions.usable(f.identity, s.id, s.accountId, f.buy),
    ).rejects.toMatchObject({ code: "trading_session_unavailable" });
    await expect(
      f.sessions.validateOperation(f.identity, {
        ...operation,
        signingMode: "session",
        sessionId: s.id,
        gasPayment: "self-funded",
      }),
    ).rejects.toMatchObject({ code: "trading_session_requires_sponsorship" });
  });
  it("keeps old descriptors immutable, allows query/revocation with switch off and cannot reactivate disabled permissions", async () => {
    const f = setup(),
      s = await f.active();
    f.environment.quickTrading.enabled = false;
    await expect(
      f.sessions.usable(f.identity, s.id, s.accountId, f.buy),
    ).rejects.toMatchObject({ code: "quick_trading_disabled" });
    const call = await f.sessions.revokeCall(f.identity, s.id, s.accountId);
    expect(call.to).toBe(s.config.policy);
    expect((await f.sessions.view(f.identity, s.id)).session.state).toBe(
      "disabled",
    );
    f.environment.quickTrading.enabled = true;
    await expect(
      f.sessions.activate(
        f.identity,
        s.id,
        await f.owner.signTypedData(f.typed()),
      ),
    ).rejects.toMatchObject({ code: "trading_session_authorization_expired" });
    const renewed = await f.active();
    expect(renewed.permissionId).not.toBe(s.permissionId);
    expect((await f.sessions.owned(f.identity, s.id)).total).toBe(s.total);
  });
  it("counts pending reservations and failed execution budgets conservatively without refunding from claims", async () => {
    const f = setup(),
      s = { ...(await f.active()), total: "100000000" };
    const old = {
      ...operation,
      accountId: s.accountId,
      intent: f.buy,
      sessionId: s.id,
      signingMode: "session" as const,
      createdAt: f.clock.now.toISOString(),
    };
    expect(() =>
      assertTradingSessionQuota([{ ...old, state: "reverted" }], s, old),
    ).toThrowError("trading_session_budget_exceeded");
    expect(() =>
      assertTradingSessionQuota(
        [
          {
            ...old,
            state: "cancelled",
            transactionHash: null,
            userOperationHash: null,
          },
        ],
        s,
        old,
      ),
    ).not.toThrow();
    expect(() =>
      assertTradingSessionQuota([{ ...old, state: "reverted" }], s, {
        ...old,
        intent: { kind: "claim-fees" },
      }),
    ).not.toThrow();
    expect(sessionSpend({ kind: "claim-fees" })).toBe(0n);
  });
  it("logout disables only the authenticated user's records", async () => {
    const f = setup(),
      s = await f.active();
    await f.store.disableUserTradingSessions("other");
    expect((await f.sessions.owned(f.identity, s.id)).state).toBe("active");
    await f.store.disableUserTradingSessions(f.identity.subject);
    expect((await f.sessions.owned(f.identity, s.id)).state).toBe("disabled");
  });
  it("rejects unsupported intents and invalid configuration", () => {
    expect(supportsQuickTrading({ kind: "faucet" })).toBe(false);
    expect(
      supportsQuickTrading({ kind: "transfer", recipient: A(1), amount: "1" }),
    ).toBe(false);
    expect(
      environmentSchema.safeParse({
        ...env,
        asset: "USDC",
        quickTrading: quickConfig,
      }).success,
    ).toBe(false);
    expect(
      quickTradingConfigSchema.safeParse({
        ...quickConfig,
        maxDurationSeconds: 86401,
      }).success,
    ).toBe(false);
    expect(
      quickTradingConfigSchema.safeParse({
        ...quickConfig,
        maxTotal: (2n ** 128n).toString(),
      }).success,
    ).toBe(false);
    expect(
      quickTradingConfigSchema.safeParse({
        ...quickConfig,
        defaultPerOperation: "100000001",
      }).success,
    ).toBe(false);
  });
  it("fails closed when configured module bytecode is missing or changed", async () => {
    const client = { getCode: async () => "0x6000" } as unknown as PublicClient;
    await expect(
      verifyQuickTrading(client, { ...env, quickTrading: quickConfig }),
    ).rejects.toMatchObject({ code: "trading_session_module_mismatch" });
    await expect(verifyQuickTrading(client, env)).resolves.toBeUndefined();
  });
});
