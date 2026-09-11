import { randomUUID } from "node:crypto";
import { keccak256, stringToHex, type PublicClient } from "viem";
import { z } from "zod";
import {
  buildBusinessCalls,
  type AdmissionReader,
} from "../../app-core/src/calls.js";
import {
  AppError,
  accountSchema,
  budgetLane,
  environmentKey,
  operationSchema,
  registerOperationSchema,
  sameAddress,
  type BusinessIntent,
  type GasPayment,
  type Operation,
  type VerifiedIdentity,
} from "../../app-core/src/contracts.js";
import {
  assertCurrentController,
  createAppKernel,
  deriveAssetAddress,
  readOnlyController,
} from "../../app-core/src/kernel.js";
import type { AppRuntime } from "./config.js";
import type { ApplicationStore } from "./store.js";
import { DepositService } from "./deposits.js";

export class OperationService {
  readonly deposits: DepositService;
  constructor(
    readonly runtime: AppRuntime,
    readonly store: ApplicationStore,
    readonly client: PublicClient,
    readonly reader: AdmissionReader,
    readonly now: () => Date = () => new Date(),
  ) {
    this.deposits = new DepositService(this);
  }
  async controlledAccount(
    identity: VerifiedIdentity,
    accountId: string,
    checkChain = true,
  ) {
    const a = await this.store.account(accountId, identity.subject);
    if (
      !a ||
      a.environment !== this.runtime.environment.id ||
      a.deploymentId !== this.runtime.environment.deployment.id
    )
      throw new AppError("account_not_found", 404);
    if (!identity.controllers.some((c) => sameAddress(c.address, a.controller)))
      throw new AppError("controller_not_linked", 403);
    if (checkChain)
      await assertCurrentController(this.client, a.address, a.controller);
    return a;
  }
  async challenge(identity: VerifiedIdentity, controller: `0x${string}`) {
    if (!identity.controllers.some((c) => sameAddress(c.address, controller)))
      throw new AppError("controller_not_linked", 403);
    const env = this.runtime.environment,
      id = randomUUID();
    const address = await deriveAssetAddress(this.client, controller, env);
    const expiresAt = new Date(this.now().getTime() + 300_000).toISOString();
    const message = [
      "Cpredict account control verification",
      `Environment: ${environmentKey(env)}`,
      `Chain: ${env.deployment.chainId}`,
      `Controller: ${controller}`,
      `Asset account: ${address}`,
      `Kernel: ${env.account.kernelVersion}`,
      `EntryPoint: ${env.account.entryPointVersion}`,
      `Index: ${env.account.index}`,
      `Subject commitment: ${keccak256(stringToHex(identity.subject))}`,
      `Challenge: ${id}`,
      `Expires: ${expiresAt}`,
      "This signature proves account control only. It does not authorize a transfer, transaction, account upgrade or session key.",
    ].join("\n");
    await this.store.createChallenge({
      id,
      subject: identity.subject,
      controller,
      environment: env.id,
      deploymentId: env.deployment.id,
      message,
      expiresAt,
      consumed: false,
    });
    return { id, message, address, controller, expiresAt };
  }
  async bind(
    identity: VerifiedIdentity,
    challengeId: string,
    signature: `0x${string}`,
  ) {
    const c = await this.store.challenge(challengeId),
      env = this.runtime.environment;
    if (
      !c ||
      c.subject !== identity.subject ||
      c.consumed ||
      Date.parse(c.expiresAt) <= this.now().getTime() ||
      c.environment !== env.id ||
      c.deploymentId !== env.deployment.id
    )
      throw new AppError("challenge_unavailable", 409);
    const wallet = identity.controllers.find((w) =>
      sameAddress(w.address, c.controller),
    );
    if (
      !wallet ||
      !(await this.client.verifyMessage({
        address: c.controller,
        message: c.message,
        signature,
      }))
    )
      throw new AppError("invalid_control_proof", 401);
    const address = await deriveAssetAddress(this.client, c.controller, env);
    await assertCurrentController(this.client, address, c.controller);
    const a = accountSchema.parse({
      id: randomUUID(),
      environment: env.id,
      deploymentId: env.deployment.id,
      address,
      controller: c.controller,
      walletKind: wallet.kind,
      ...env.account,
      createdAt: this.now().toISOString(),
    });
    return this.store.bindAccount(
      c.id,
      identity.subject,
      a,
      this.now().toISOString(),
    );
  }
  async prepare(
    identity: VerifiedIdentity,
    accountId: string,
    intent: BusinessIntent,
    gasPayment: GasPayment = "sponsored",
  ) {
    const env = this.runtime.environment;
    if (
      !this.runtime.sponsor ||
      (gasPayment === "sponsored" && !env.features.sponsorship)
    )
      throw new AppError("sponsorship_disabled", 503);
    const account = await this.controlledAccount(identity, accountId);
    if (intent.kind === "deposit-usdc")
      await this.deposits.validate(
        identity.subject,
        accountId,
        account.address,
        intent,
        this.runtime.sponsor.validitySeconds + 10,
      );
    const kernel = await createAppKernel(
      this.client,
      readOnlyController(account.controller),
      env,
    );
    if (!sameAddress(kernel.address, account.address))
      throw new AppError("account_derivation_mismatch", 409);
    const block = await this.client.getBlock({ blockTag: "latest" });
    const calls = await buildBusinessCalls(
      env,
      account.address,
      intent,
      this.reader,
      block.timestamp,
    );
    const [nonce, callData, factoryArgs] = await Promise.all([
      kernel.getNonce(),
      kernel.encodeCalls(calls.map((c) => ({ ...c, value: 0n }))),
      kernel.getFactoryArgs(),
    ]);
    return {
      account,
      nonce: nonce.toString(),
      calls,
      callData,
      factory: factoryArgs.factory ?? null,
      factoryData: factoryArgs.factoryData ?? null,
      maxGasCost: this.runtime.sponsor.maxCostPerOperation,
      expiresInSeconds: this.runtime.sponsor.validitySeconds,
    };
  }
  async register(
    identity: VerifiedIdentity,
    input: z.infer<typeof registerOperationSchema>,
  ): Promise<Operation> {
    const env = this.runtime.environment;
    if (
      input.environment !== env.id ||
      input.deploymentId !== env.deployment.id
    )
      throw new AppError("environment_mismatch", 409);
    await this.controlledAccount(identity, input.accountId, false);
    const requestHash = keccak256(stringToHex(JSON.stringify(input)));
    const old = await this.store.byKey(identity.subject, input.idempotencyKey);
    if (old) {
      if (old.requestHash !== requestHash)
        throw new AppError("idempotency_conflict", 409);
      return old.operation;
    }
    const prepared = await this.prepare(
      identity,
      input.accountId,
      input.intent,
      input.gasPayment,
    );
    if (
      input.callData.toLowerCase() !== prepared.callData.toLowerCase() ||
      input.nonce !== prepared.nonce ||
      input.factory?.toLowerCase() !== prepared.factory?.toLowerCase() ||
      input.factoryData?.toLowerCase() !== prepared.factoryData?.toLowerCase()
    )
      throw new AppError("operation_preparation_changed", 409);
    const now = this.now(),
      limits = this.runtime.sponsor;
    if (!limits) throw new AppError("sponsorship_disabled", 503);
    const operation = operationSchema.parse({
      id: randomUUID(),
      environment: env.id,
      deploymentId: env.deployment.id,
      accountId: prepared.account.id,
      account: prepared.account.address,
      kind: input.intent.kind,
      intent: input.intent,
      state: "awaiting-signature",
      nonce: input.nonce,
      calls: prepared.calls,
      callData: input.callData,
      factory: input.factory,
      factoryData: input.factoryData,
      providerOperationId: null,
      userOperationHash: null,
      transactionHash: null,
      blockNumber: null,
      blockHash: null,
      actualGasCost: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + limits.validitySeconds * 1000,
      ).toISOString(),
      maxGasCost: limits.maxCostPerOperation,
      gasPayment: input.gasPayment ?? "sponsored",
      sponsorshipAttempted: false,
      lane: budgetLane(input.intent.kind),
      reason: null,
    });
    return (
      await this.store.admit(
        {
          operation,
          subject: identity.subject,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        },
        limits,
      )
    ).operation;
  }
  async ownedOperation(
    identity: VerifiedIdentity,
    id: string,
  ): Promise<Operation> {
    const record = await this.store.operation(id);
    if (!record) throw new AppError("operation_not_found", 404);
    await this.controlledAccount(identity, record.operation.accountId, false);
    return record.operation;
  }
  async cancel(identity: VerifiedIdentity, id: string): Promise<Operation> {
    await this.ownedOperation(identity, id);
    const result = await this.store.transition(
      id,
      ["preparing", "awaiting-signature"],
      {
        state: "cancelled",
        reason: "user_cancelled_before_submission",
        updatedAt: this.now().toISOString(),
      },
    );
    if (!result.changed)
      throw new AppError(
        "operation_already_submitted",
        409,
        "已提交或结果未知的操作只能继续查询",
        id,
      );
    return result.record.operation;
  }
}
