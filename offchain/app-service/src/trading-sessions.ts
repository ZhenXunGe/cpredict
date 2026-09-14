import { randomUUID } from "node:crypto";
import {
  encodeFunctionData,
  hashTypedData,
  keccak256,
  recoverAddress,
  slice,
  stringToHex,
  type Hex,
} from "viem";
import {
  AppError,
  sameAddress,
  type BusinessIntent,
  type VerifiedIdentity,
  type Operation,
} from "../../app-core/src/contracts.js";
import {
  tradingSessionSchema,
  sessionPrepareSchema,
  sessionSpend,
  supportsQuickTrading,
  type TradingSession,
} from "../../app-core/src/trading-session-contracts.js";
import {
  createSessionKernel,
  policyId,
  tradingPolicyAbi,
} from "../../app-core/src/trading-session-kernel.js";
import type { OperationService } from "./operations.js";

export class TradingSessions {
  constructor(private readonly service: OperationService) {}
  private config() {
    const env = this.service.runtime.environment;
    if (env.asset !== "ctUSD" || !env.quickTrading?.enabled)
      throw new AppError("quick_trading_disabled", 503);
    return env.quickTrading;
  }
  async prepare(identity: VerifiedIdentity, raw: unknown) {
    const input = sessionPrepareSchema.parse(raw),
      config = this.config();
    if (!this.service.runtime.environment.features.sponsorship)
      throw new AppError("sponsorship_disabled", 503);
    if (
      BigInt(input.perOperation) > BigInt(config.maxPerOperation) ||
      BigInt(input.total) > BigInt(config.maxTotal) ||
      BigInt(input.perOperation) > BigInt(input.total)
    )
      throw new AppError("trading_session_limits_invalid", 400);
    const account = await this.service.controlledAccount(
      identity,
      input.accountId,
    );
    if (
      sameAddress(input.publicKey, account.controller) ||
      sameAddress(input.publicKey, account.address)
    )
      throw new AppError("trading_session_key_invalid", 400);
    const now = this.service.now(),
      id = randomUUID();
    const session = tradingSessionSchema.parse({
      id,
      accountId: account.id,
      account: account.address,
      controller: account.controller,
      environment: account.environment,
      deploymentId: account.deploymentId,
      publicKey: input.publicKey,
      permissionId: slice(keccak256(stringToHex(id)), 0, 4),
      config,
      perOperation: input.perOperation,
      total: input.total,
      validAfter: String(Math.floor(now.getTime() / 1000)),
      validUntil: String(
        Math.floor(now.getTime() / 1000) + config.maxDurationSeconds,
      ),
      createdAt: now.toISOString(),
      state: "prepared",
      authorizationHash: `0x${"0".repeat(64)}`,
    });
    const kernel = await createSessionKernel(
      this.service.client,
      this.service.runtime.environment,
      session,
    );
    if (!sameAddress(kernel.address, account.address))
      throw new AppError("account_derivation_mismatch", 409);
    session.authorizationHash = hashTypedData(
      await kernel.kernelPluginManager.getPluginsEnableTypedData(
        account.address,
      ),
    );
    await this.service.store.createTradingSession(identity.subject, session);
    return session;
  }
  async owned(identity: VerifiedIdentity, id: string) {
    const s = await this.service.store.tradingSession(identity.subject, id);
    if (!s) throw new AppError("trading_session_not_found", 404);
    const account = await this.service.controlledAccount(
      identity,
      s.accountId,
      false,
    );
    if (
      !sameAddress(account.address, s.account) ||
      !sameAddress(account.controller, s.controller)
    )
      throw new AppError("trading_session_account_changed", 409);
    return s;
  }
  async activate(identity: VerifiedIdentity, id: string, signature: Hex) {
    this.config();
    const s = await this.owned(identity, id);
    await this.service.controlledAccount(identity, s.accountId);
    if (
      s.state === "disabled" ||
      this.service.now().getTime() > Date.parse(s.createdAt) + 300000
    )
      throw new AppError("trading_session_authorization_expired", 409);
    const kernel = await createSessionKernel(
      this.service.client,
      this.service.runtime.environment,
      s,
    );
    const digest = hashTypedData(
      await kernel.kernelPluginManager.getPluginsEnableTypedData(s.account),
    );
    if (
      digest !== s.authorizationHash ||
      !sameAddress(
        await recoverAddress({ hash: digest, signature }),
        s.controller,
      )
    )
      throw new AppError("invalid_session_authorization", 403);
    return this.service.store.setTradingSessionState(
      identity.subject,
      id,
      "active",
    );
  }
  async disable(identity: VerifiedIdentity, id: string) {
    await this.owned(identity, id);
    return this.service.store.setTradingSessionState(
      identity.subject,
      id,
      "disabled",
    );
  }
  async view(identity: VerifiedIdentity, id: string) {
    const session = await this.owned(identity, id);
    const [state, operations] = await Promise.all([
      this.service.client.readContract({
        address: session.config.policy,
        abi: tradingPolicyAbi,
        functionName: "sessionState",
        args: [policyId(session), session.account],
      }),
      this.service.store.sessionOperations(id),
    ]);
    const pending = operations
      .filter(
        (o) =>
          [
            "preparing",
            "awaiting-signature",
            "submitted",
            "confirming",
            "unknown",
          ].includes(o.state) && o.blockNumber === null,
      )
      .reduce((n, o) => n + sessionSpend(o.intent), 0n);
    return {
      session,
      spent: state[2].toString(),
      pending: pending.toString(),
      revoked: state[6],
    };
  }
  async usable(
    identity: VerifiedIdentity,
    id: string,
    accountId: string,
    intent: BusinessIntent,
  ) {
    this.config();
    const view = await this.view(identity, id),
      s = view.session;
    if (
      s.state !== "active" ||
      s.accountId !== accountId ||
      s.environment !== this.service.runtime.environment.id ||
      s.deploymentId !== this.service.runtime.environment.deployment.id ||
      view.revoked ||
      BigInt(s.validUntil) * 1000n <= BigInt(this.service.now().getTime()) ||
      !supportsQuickTrading(intent)
    )
      throw new AppError("trading_session_unavailable", 409);
    const amount = sessionSpend(intent);
    if (
      amount > BigInt(s.perOperation) ||
      amount + BigInt(view.spent) + BigInt(view.pending) > BigInt(s.total)
    )
      throw new AppError("trading_session_budget_exceeded", 409);
    return s;
  }
  async validateOperation(identity: VerifiedIdentity, op: Operation) {
    if (op.signingMode !== "session") return;
    this.config();
    if (!op.sessionId || op.gasPayment !== "sponsored")
      throw new AppError("trading_session_requires_sponsorship", 403);
    const view = await this.view(identity, op.sessionId),
      s = view.session;
    if (
      s.state !== "active" ||
      s.accountId !== op.accountId ||
      s.environment !== this.service.runtime.environment.id ||
      s.deploymentId !== this.service.runtime.environment.deployment.id ||
      view.revoked ||
      !supportsQuickTrading(op.intent) ||
      BigInt(s.validUntil) * 1000n <= BigInt(this.service.now().getTime())
    )
      throw new AppError("trading_session_unavailable", 409);
    // Pending includes this operation already. On-chain policy remains final authority.
    if (sessionSpend(op.intent) + BigInt(view.spent) > BigInt(s.total))
      throw new AppError("trading_session_budget_exceeded", 409);
  }
  async revokeCall(identity: VerifiedIdentity, id: string, accountId: string) {
    const s = await this.owned(identity, id);
    if (s.accountId !== accountId)
      throw new AppError("trading_session_account_changed", 409);
    await this.disable(identity, id);
    return {
      to: s.config.policy,
      data: encodeFunctionData({
        abi: tradingPolicyAbi,
        functionName: "revoke",
        args: [policyId(s)],
      }),
      value: "0" as const,
    };
  }
}
