import { randomBytes, randomUUID } from "node:crypto";
import {
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
} from "viem";
import { z } from "zod";
import {
  AppError,
  depositPrepareSchema,
  depositSchema,
  sameAddress,
  type BusinessIntent,
  type Deposit,
  type VerifiedIdentity,
} from "../../app-core/src/contracts.js";
import {
  readUsdcDomain,
  receiveTypedData,
  USDC_ADDRESS,
  usdcAbi,
  type ReceiveAuthorization,
} from "../../app-core/src/usdc.js";
import type { OperationService } from "./operations.js";

type DepositIntent = Extract<BusinessIntent, { kind: "deposit-usdc" }>;
export class DepositService {
  constructor(private readonly service: OperationService) {}

  private enabled() {
    const { environment: env, sponsor } = this.service.runtime;
    if (
      env.asset !== "USDC" ||
      !sameAddress(env.deployment.paymentToken, USDC_ADDRESS) ||
      env.account.index !== "1002" ||
      !env.features.gaslessDeposit
    )
      throw new AppError("gasless_deposit_disabled", 503);
    if (!env.features.sponsorship || !sponsor)
      throw new AppError("sponsorship_disabled", 503);
    if (!env.features.newExposure)
      throw new AppError("new_exposure_disabled", 503);
    return sponsor;
  }

  private async funding(auth: ReceiveAuthorization, blockNumber: bigint) {
    const c = this.service.client;
    const [code, balance, used, paused, fromBlocked, toBlocked] =
      await Promise.all([
        c.getCode({ address: auth.from, blockNumber }),
        c.readContract({
          address: USDC_ADDRESS,
          abi: usdcAbi,
          functionName: "balanceOf",
          args: [auth.from],
          blockNumber,
        }),
        c.readContract({
          address: USDC_ADDRESS,
          abi: usdcAbi,
          functionName: "authorizationState",
          args: [auth.from, auth.nonce],
          blockNumber,
        }),
        c.readContract({
          address: USDC_ADDRESS,
          abi: usdcAbi,
          functionName: "paused",
          blockNumber,
        }),
        c.readContract({
          address: USDC_ADDRESS,
          abi: usdcAbi,
          functionName: "isBlacklisted",
          args: [auth.from],
          blockNumber,
        }),
        c.readContract({
          address: USDC_ADDRESS,
          abi: usdcAbi,
          functionName: "isBlacklisted",
          args: [auth.to],
          blockNumber,
        }),
      ]);
    if (code && code !== "0x")
      throw new AppError("deposit_source_not_eoa", 400);
    if (used) throw new AppError("deposit_authorization_used", 409);
    if (paused || fromBlocked || toBlocked)
      throw new AppError("usdc_transfers_unavailable", 409);
    if (balance < BigInt(auth.value))
      throw new AppError("deposit_insufficient_balance", 409);
  }

  async prepare(
    identity: VerifiedIdentity,
    input: z.infer<typeof depositPrepareSchema>,
  ): Promise<Deposit> {
    const s = this.service,
      now = s.now().toISOString();
    const account = await s.controlledAccount(identity, input.accountId, false);
    const requestHash = keccak256(stringToHex(JSON.stringify(input)));
    const prior = await s.store.depositByKey(
      identity.subject,
      input.idempotencyKey,
      now,
    );
    if (prior) {
      if (prior.requestHash !== requestHash)
        throw new AppError("idempotency_conflict", 409);
      return prior.deposit;
    }
    this.enabled();
    await s.controlledAccount(identity, input.accountId);
    if (sameAddress(input.source, account.address))
      throw new AppError("deposit_recipient_mismatch", 403);
    try {
      const block = await s.client.getBlock({ blockTag: "latest" });
      const domain = await readUsdcDomain(s.client, block.number);
      const authorization = {
        from: input.source,
        to: account.address,
        value: input.amount,
        validAfter: "0",
        validBefore: (block.timestamp + 600n).toString(),
        nonce: `0x${randomBytes(32).toString("hex")}` as const,
      };
      await this.funding(authorization, block.number);
      const deposit = depositSchema.parse({
        id: randomUUID(),
        environment: account.environment,
        deploymentId: account.deploymentId,
        accountId: account.id,
        account: account.address,
        domain,
        authorization,
        state: "awaiting-authorization",
        operationId: null,
        userOperationHash: null,
        transactionHash: null,
        blockNumber: null,
        blockHash: null,
        actualGasCost: null,
        finality: "pending",
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(
          Number(block.timestamp + 600n) * 1000,
        ).toISOString(),
        reason: null,
      });
      if (Date.parse(deposit.expiresAt) <= s.now().getTime())
        throw new AppError("chain_query_unavailable", 503);
      return (
        await s.store.createDeposit({
          deposit,
          subject: identity.subject,
          idempotencyKey: input.idempotencyKey,
          requestHash,
        })
      ).deposit;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("chain_query_unavailable", 503);
    }
  }

  async owned(identity: VerifiedIdentity, id: string): Promise<Deposit> {
    const r = await this.service.store.deposit(
      id,
      this.service.now().toISOString(),
    );
    if (!r || r.subject !== identity.subject)
      throw new AppError("deposit_not_found", 404);
    await this.service.controlledAccount(identity, r.deposit.accountId, false);
    return r.deposit;
  }

  async cancel(identity: VerifiedIdentity, id: string): Promise<Deposit> {
    const d = await this.owned(identity, id);
    if (d.operationId) {
      await this.service.cancel(identity, d.operationId);
      return this.owned(identity, id);
    }
    return (
      await this.service.store.cancelDeposit(
        id,
        identity.subject,
        this.service.now().toISOString(),
      )
    ).deposit;
  }

  /** Called on prepare/register and again for every provider admission or send. */
  async validate(
    subject: string,
    accountId: string,
    account: Address,
    intent: DepositIntent,
    minimumValiditySeconds: number,
    operationId?: string,
  ): Promise<void> {
    this.enabled();
    const s = this.service,
      r = await s.store.deposit(intent.depositId, s.now().toISOString());
    if (
      !r ||
      r.subject !== subject ||
      r.deposit.accountId !== accountId ||
      r.deposit.environment !== s.runtime.environment.id ||
      r.deposit.deploymentId !== s.runtime.environment.deployment.id
    )
      throw new AppError("deposit_not_found", 404);
    const d = r.deposit;
    if (operationId ? d.operationId !== operationId : d.operationId !== null)
      throw new AppError(
        "deposit_already_registered",
        409,
        "请查询原入金操作",
        d.operationId ?? undefined,
      );
    if (
      d.state === "cancelled" ||
      d.state === "expired" ||
      !sameAddress(d.account, account) ||
      !sameAddress(intent.authorization.to, account) ||
      sameAddress(intent.authorization.from, account) ||
      JSON.stringify(d.authorization) !== JSON.stringify(intent.authorization)
    )
      throw new AppError("deposit_authorization_mismatch", 403);
    try {
      const block = await s.client.getBlock({ blockTag: "latest" });
      if (
        block.timestamp <= BigInt(d.authorization.validAfter) ||
        BigInt(d.authorization.validBefore) <=
          block.timestamp + BigInt(minimumValiditySeconds)
      )
        throw new AppError("deposit_authorization_expired", 409);
      const domain = await readUsdcDomain(s.client, block.number);
      if (JSON.stringify(domain) !== JSON.stringify(d.domain))
        throw new AppError("deposit_domain_changed", 409);
      let signer: Address;
      try {
        signer = await recoverTypedDataAddress({
          ...receiveTypedData(domain, d.authorization),
          signature: intent.signature,
        });
      } catch {
        throw new AppError("deposit_signature_invalid", 403);
      }
      if (!sameAddress(signer, d.authorization.from))
        throw new AppError("deposit_signature_invalid", 403);
      await this.funding(d.authorization, block.number);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("chain_query_unavailable", 503);
    }
  }
}
