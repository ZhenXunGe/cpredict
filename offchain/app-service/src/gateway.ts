import {
  formatUserOperationRequest,
  getUserOperationHash,
  toUserOperation as unpackUserOperation,
  type UserOperation,
} from "viem/account-abstraction";
import { concatHex, toHex } from "viem";
import { z } from "zod";
import {
  AppError,
  address,
  bytes,
  hash,
  sameAddress,
  type Operation,
  type VerifiedIdentity,
} from "../../app-core/src/contracts.js";
import { ENTRY_POINT } from "../../app-core/src/kernel.js";
import type { RpcTransport } from "./http.js";
import type { OperationService } from "./operations.js";

const quantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][\da-fA-F]{0,63})$/);
const gasFields = {
  callGasLimit: quantity,
  verificationGasLimit: quantity,
  preVerificationGas: quantity,
  maxFeePerGas: quantity,
  maxPriorityFeePerGas: quantity,
};
export const wireUserOperationSchema = z.strictObject({
  sender: address,
  nonce: quantity,
  callData: bytes,
  factory: address.optional(),
  factoryData: bytes.optional(),
  signature: bytes.optional(),
  callGasLimit: quantity.optional(),
  verificationGasLimit: quantity.optional(),
  preVerificationGas: quantity.optional(),
  maxFeePerGas: quantity.optional(),
  maxPriorityFeePerGas: quantity.optional(),
  paymaster: address.optional(),
  paymasterData: bytes.optional(),
  paymasterVerificationGasLimit: quantity.optional(),
  paymasterPostOpGasLimit: quantity.optional(),
});
export type WireUserOperation = z.infer<typeof wireUserOperationSchema>;
const completeSchema = wireUserOperationSchema.extend({
  ...gasFields,
  signature: bytes,
});
const callbackSchema = wireUserOperationSchema.extend({
  ...gasFields,
  signature: bytes,
});
const packedCallbackSchema = z.strictObject({
  sender: address,
  nonce: quantity,
  callData: bytes,
  initCode: bytes,
  paymasterAndData: bytes,
  signature: bytes,
  ...gasFields,
});
/** ZeroDev documents packed initCode/paymasterAndData callbacks as well as modern RPC fields. Decode with viem. */
function callbackOperation(input: unknown): WireUserOperation {
  const modern = callbackSchema.safeParse(input);
  if (modern.success) return modern.data;
  const p = packedCallbackSchema.parse(input);
  if (
    (p.initCode !== "0x" && p.initCode.length < 42) ||
    (p.paymasterAndData !== "0x" && p.paymasterAndData.length < 106)
  )
    throw new AppError("invalid_callback_packing");
  const unpacked = unpackUserOperation({
    sender: p.sender,
    nonce: BigInt(p.nonce),
    initCode: p.initCode,
    callData: p.callData,
    signature: p.signature,
    preVerificationGas: BigInt(p.preVerificationGas),
    paymasterAndData: p.paymasterAndData,
    accountGasLimits: concatHex([
      toHex(BigInt(p.verificationGasLimit), { size: 16 }),
      toHex(BigInt(p.callGasLimit), { size: 16 }),
    ]),
    gasFees: concatHex([
      toHex(BigInt(p.maxPriorityFeePerGas), { size: 16 }),
      toHex(BigInt(p.maxFeePerGas), { size: 16 }),
    ]),
  });
  return callbackSchema.parse(formatUserOperationRequest(unpacked));
}
export const rpcRequestSchema = z.strictObject({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number().int(), z.string().max(64)]),
  method: z.string().max(80),
  params: z.array(z.unknown()).max(2),
});

export function assertOperationBinding(
  o: Operation,
  u: WireUserOperation,
): void {
  if (
    !sameAddress(o.account, u.sender) ||
    o.nonce !== BigInt(u.nonce).toString() ||
    o.callData.toLowerCase() !== u.callData.toLowerCase() ||
    o.factory?.toLowerCase() !== (u.factory?.toLowerCase() ?? undefined) ||
    o.factoryData?.toLowerCase() !== (u.factoryData?.toLowerCase() ?? undefined)
  )
    throw new AppError("user_operation_mismatch", 403);
}
export function assertGasCeiling(
  o: Operation,
  u: WireUserOperation,
  complete: boolean,
): void {
  if (complete) completeSchema.parse(u);
  if (o.gasPayment === "self-funded") {
    if (
      [
        u.paymaster,
        u.paymasterData,
        u.paymasterVerificationGasLimit,
        u.paymasterPostOpGasLimit,
      ].some((v) => v !== undefined)
    )
      throw new AppError("self_funded_paymaster_forbidden", 403);
  } else if (complete) {
    z.object({
      paymaster: address,
      paymasterData: bytes,
      paymasterVerificationGasLimit: quantity,
      paymasterPostOpGasLimit: quantity,
    }).parse(u);
  }
  const fields = [
    u.callGasLimit,
    u.verificationGasLimit,
    u.preVerificationGas,
    u.paymasterVerificationGasLimit,
    u.paymasterPostOpGasLimit,
  ];
  const cost =
    fields.reduce<bigint>((sum, v) => sum + BigInt(v ?? "0x0"), 0n) *
    BigInt(u.maxFeePerGas ?? "0x0");
  if (
    cost > BigInt(o.maxGasCost) ||
    BigInt(u.maxPriorityFeePerGas ?? "0x0") > BigInt(u.maxFeePerGas ?? "0x0")
  )
    throw new AppError("gas_cost_exceeds_limit", 403);
  if (complete && cost === 0n) throw new AppError("invalid_gas_estimate", 403);
}
function toUserOperation(u: WireUserOperation): UserOperation<"0.7"> {
  const v = completeSchema.parse(u);
  return {
    ...v,
    nonce: BigInt(v.nonce),
    callGasLimit: BigInt(v.callGasLimit),
    verificationGasLimit: BigInt(v.verificationGasLimit),
    preVerificationGas: BigInt(v.preVerificationGas),
    maxFeePerGas: BigInt(v.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(v.maxPriorityFeePerGas),
    paymasterVerificationGasLimit:
      v.paymasterVerificationGasLimit === undefined
        ? undefined
        : BigInt(v.paymasterVerificationGasLimit),
    paymasterPostOpGasLimit:
      v.paymasterPostOpGasLimit === undefined
        ? undefined
        : BigInt(v.paymasterPostOpGasLimit),
  };
}

export class AuthenticatedAAGateway {
  constructor(
    private readonly service: OperationService,
    private readonly bundler: RpcTransport,
    private readonly paymaster: RpcTransport,
  ) {}
  async request(
    identity: VerifiedIdentity,
    operationId: string,
    rpc: z.infer<typeof rpcRequestSchema>,
  ): Promise<unknown> {
    let o = await this.service.ownedOperation(identity, operationId);
    const env = this.service.runtime.environment;
    if (rpc.method === "eth_getUserOperationReceipt") {
      const [queryHash] = z.tuple([hash]).parse(rpc.params);
      if (
        !o.userOperationHash ||
        queryHash.toLowerCase() !== o.userOperationHash.toLowerCase()
      )
        throw new AppError("operation_hash_mismatch", 403);
      return this.bundler.request(rpc.method, [queryHash]);
    }
    if (
      !this.service.runtime.sponsor ||
      (o.gasPayment !== "self-funded" && !env.features.sponsorship)
    )
      throw new AppError("sponsorship_disabled", 503);
    if (rpc.method === "zd_getUserOperationGasPrice") {
      if (rpc.params.length !== 0) throw new AppError("invalid_rpc_params");
      return this.bundler.request(rpc.method, []);
    }
    if (
      ![
        "zd_sponsorUserOperation",
        "eth_estimateUserOperationGas",
        "eth_sendUserOperation",
      ].includes(rpc.method)
    )
      throw new AppError("rpc_method_not_allowed", 403);
    const isSponsor = rpc.method === "zd_sponsorUserOperation";
    if (isSponsor && o.gasPayment === "self-funded")
      throw new AppError("self_funded_paymaster_forbidden", 403);
    const u = isSponsor
      ? (() => {
          const [p] = z
            .tuple([
              z.strictObject({
                chainId: z.literal(env.deployment.chainId),
                userOp: wireUserOperationSchema,
                entryPointAddress: address,
                shouldOverrideFee: z.literal(false),
                shouldConsume: z.boolean(),
              }),
            ])
            .parse(rpc.params);
          if (!sameAddress(p.entryPointAddress, ENTRY_POINT.address))
            throw new AppError("entry_point_mismatch", 403);
          return p.userOp;
        })()
      : (() => {
          const [p, ep] = z
            .tuple([wireUserOperationSchema, address])
            .parse(rpc.params);
          if (!sameAddress(ep, ENTRY_POINT.address))
            throw new AppError("entry_point_mismatch", 403);
          return p;
        })();
    assertOperationBinding(o, u);
    assertGasCeiling(o, u, rpc.method === "eth_sendUserOperation");
    const userOperationHash =
      rpc.method === "eth_sendUserOperation"
        ? getUserOperationHash({
            userOperation: toUserOperation(u),
            entryPointAddress: ENTRY_POINT.address,
            entryPointVersion: "0.7",
            chainId: env.deployment.chainId,
          })
        : null;
    if (o.userOperationHash !== null) {
      if (
        rpc.method === "eth_sendUserOperation" &&
        o.userOperationHash.toLowerCase() === userOperationHash?.toLowerCase()
      )
        return o.userOperationHash;
      throw new AppError(
        "operation_already_submitted",
        409,
        "请继续查询原操作",
        o.id,
      );
    }
    if (
      o.state !== "awaiting-signature" ||
      Date.parse(o.expiresAt) <= this.service.now().getTime() ||
      o.createdAt.slice(0, 10) !== this.service.now().toISOString().slice(0, 10)
    )
      throw new AppError("operation_admission_expired", 409);
    await this.service.controlledAccount(identity, o.accountId);
    if (o.intent.kind === "deposit-usdc")
      await this.service.deposits.validate(
        identity.subject,
        o.accountId,
        o.account,
        o.intent,
        0,
        o.id,
      );
    if (rpc.method === "eth_sendUserOperation" && userOperationHash) {
      // Persist the exact hash BEFORE the network side effect. A crash here is
      // deliberately recoverable as unknown; it never authorizes a second send.
      const admission = await this.service.store.transition(
        o.id,
        ["awaiting-signature"],
        {
          state: "submitted",
          userOperationHash,
          providerOperationId: userOperationHash,
          updatedAt: this.service.now().toISOString(),
        },
      );
      if (!admission.changed) {
        if (admission.record.operation.userOperationHash === userOperationHash)
          return userOperationHash;
        throw new AppError(
          "operation_already_submitted",
          409,
          "请继续查询原操作",
          o.id,
        );
      }
      o = admission.record.operation;
      try {
        const returnedHash = hash.parse(
          await this.bundler.request(rpc.method, [u, ENTRY_POINT.address]),
        );
        if (returnedHash.toLowerCase() !== userOperationHash.toLowerCase())
          throw new AppError("provider_hash_mismatch", 503);
        return userOperationHash;
      } catch {
        await this.service.store.transition(o.id, ["submitted"], {
          state: "unknown",
          reason: "provider_result_unknown",
          updatedAt: this.service.now().toISOString(),
        });
        throw new AppError(
          "operation_result_unknown",
          503,
          "提交结果未知，请继续查询原操作",
          o.id,
        );
      }
    }
    if (isSponsor) {
      // Serialize with cancellation before any provider request can issue a grant.
      const marked = await this.service.store.transition(
        o.id,
        ["awaiting-signature"],
        {
          sponsorshipAttempted: true,
          updatedAt: this.service.now().toISOString(),
        },
      );
      if (!marked.changed)
        throw new AppError("operation_admission_expired", 409);
      o = marked.record.operation;
    }
    const result = await (isSponsor ? this.paymaster : this.bundler).request(
      rpc.method,
      rpc.params,
    );
    if (isSponsor) {
      // SDK consumes the returned gas fields directly, so validate before returning.
      const sponsored = wireUserOperationSchema.parse({
        ...u,
        ...z.record(z.string(), z.unknown()).parse(result),
      });
      assertOperationBinding(o, sponsored);
      assertGasCeiling(
        o,
        { ...sponsored, signature: sponsored.signature ?? "0x" },
        true,
      );
    }
    return result;
  }
  async policy(
    body: unknown,
  ): Promise<{ proceed: boolean; logicalOperator: "and" }> {
    const deny = { proceed: false, logicalOperator: "and" as const };
    try {
      const runtime = this.service.runtime;
      if (!runtime.environment.features.sponsorship || !runtime.sponsor)
        return deny;
      const p = z
        .strictObject({
          projectId: z.literal(runtime.sponsor.projectId),
          chainId: z.literal(runtime.environment.deployment.chainId),
          userOp: z.unknown().transform(callbackOperation),
        })
        .parse(body);
      const admitted = await this.service.store.policyCandidate(
        p.userOp.sender,
        BigInt(p.userOp.nonce).toString(),
        p.userOp.callData,
      );
      if (!admitted) return deny;
      const o = admitted.operation;
      if (o.gasPayment === "self-funded") return deny;
      if (
        Date.parse(o.expiresAt) <= this.service.now().getTime() ||
        o.createdAt.slice(0, 10) !==
          this.service.now().toISOString().slice(0, 10)
      )
        return deny;
      assertOperationBinding(o, p.userOp);
      if (o.intent.kind === "deposit-usdc")
        await this.service.deposits.validate(
          admitted.subject,
          o.accountId,
          o.account,
          o.intent,
          0,
          o.id,
        );
      // A policy callback is never an identity credential. Only the authenticated,
      // quota-reserved exact inner-call registration above can make it eligible.
      // Paymaster data can still be absent while the provider is deciding whether to issue it.
      // Enforce all supplied costs here; the gateway requires the complete sponsored fields before returning or sending.
      assertGasCeiling(o, p.userOp, false);
      // Direct provider callbacks must also serialize possible issuance with cancellation.
      const marked = await this.service.store.transition(
        o.id,
        ["awaiting-signature", "submitted", "confirming", "unknown"],
        {
          sponsorshipAttempted: true,
          updatedAt: this.service.now().toISOString(),
        },
      );
      if (!marked.changed) return deny;
      return { proceed: true, logicalOperator: "and" };
    } catch {
      return deny;
    }
  }
}
