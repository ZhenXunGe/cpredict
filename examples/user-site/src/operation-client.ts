import {
  createKernelAccountClient,
  createZeroDevPaymasterClient,
} from "@zerodev/sdk";
import { custom, type EIP1193Provider } from "viem";
import {
  createBundlerClient,
  formatUserOperationRequest,
  type UserOperation,
} from "viem/account-abstraction";
import { arbitrumSepolia } from "viem/chains";
import { z } from "zod";
import {
  AppError,
  accountIdentity,
  operationSchema,
  preparedOperationSchema,
  registerOperationSchema,
  sameAddress,
  type AppAccount,
  type BusinessIntent,
  type GasPayment,
  type Operation,
} from "../../../offchain/app-core/src/contracts.js";
import { buildBusinessCalls } from "../../../offchain/app-core/src/calls.js";
import { ProtocolAdmissionReader } from "../../../offchain/app-core/src/admission-reader.js";
import {
  assertCurrentController,
  createAppKernel,
  ENTRY_POINT,
} from "../../../offchain/app-core/src/kernel.js";
import { SiteApi } from "./api.js";
import { gasBalance, requireGasBalance } from "./gas-payment.js";
const operationResponse = z.object({ operation: operationSchema });
const rpcResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number(),
      message: z.string(),
      data: z.object({ code: z.string() }).optional(),
    })
    .optional(),
});
export type OperationStage =
  | "preparing"
  | "reviewing-gas"
  | "awaiting-signature"
  | "submitting";
export type GasQuote = { cost: bigint; balance: bigint };
export type GasOptions = {
  payment: GasPayment;
  confirm?: (quote: GasQuote) => Promise<void>;
};
export class UserOperationClient {
  constructor(
    private readonly api: SiteApi,
    private readonly account: AppAccount,
    private readonly controller: () => Promise<EIP1193Provider>,
    private readonly stillCurrent: () => boolean,
  ) {}
  private current() {
    if (!this.stillCurrent())
      throw new AppError("confirmation_context_changed", 409);
  }
  async submit(
    intent: BusinessIntent,
    onRecord: (operation: Operation) => void,
    onStage: (stage: OperationStage) => void,
    gas: GasOptions = { payment: "sponsored" },
  ): Promise<Operation> {
    const run = async () => {
      let recorded: Operation | undefined;
      const recoveryKey = `cpredict-register:${this.api.key}:${this.account.id}`;
      const lookupRegistration = async (key: string) => {
        const result = await this.api.request(
          `/v1/operations?accountId=${this.account.id}&key=${encodeURIComponent(key)}`,
          z.object({ items: z.array(operationSchema) }),
          { auth: true },
        );
        const original = result.items[0];
        if (original) {
          recorded = original;
          onRecord(original);
          sessionStorage.removeItem(recoveryKey);
        }
        return original;
      };
      try {
        this.current();
        const previousKey = sessionStorage.getItem(recoveryKey);
        if (previousKey) {
          const original = await lookupRegistration(previousKey);
          this.current();
          if (original) return original; // Recover the original record; never submit from a recovery path.
          sessionStorage.removeItem(recoveryKey); // No prior signed operation can exist without a returned registration.
        }
        onStage("preparing");
        const api = this.api,
          env = api.environment,
          account = this.account,
          client = api.publicClient();
        if (gas.payment === "self-funded") {
          if (!gas.confirm)
            throw new AppError("gas_confirmation_required", 409);
          requireGasBalance(await gasBalance(client, account), 1n);
          this.current();
        }
        const provider = await this.controller();
        this.current();
        const kernel = await createAppKernel(client, provider, env);
        this.current();
        if (!sameAddress(kernel.address, account.address))
          throw new AppError("account_derivation_mismatch", 409);
        await assertCurrentController(
          client,
          account.address,
          account.controller,
        );
        this.current();
        const block = await client.getBlock(),
          reader = new ProtocolAdmissionReader(
            client,
            env,
            env.services.metadata,
          );
        const expected = await buildBusinessCalls(
          env,
          account.address,
          intent,
          reader,
          block.timestamp,
        );
        this.current();
        const prepared = await api.request(
          "/v1/operations/prepare",
          preparedOperationSchema,
          {
            auth: true,
            body: { accountId: account.id, intent, gasPayment: gas.payment },
          },
        );
        this.current();
        const calls = expected.map((c) => ({ ...c, value: 0n })),
          callData = await kernel.encodeCalls(calls);
        const canonical = (items: typeof expected) =>
          JSON.stringify(
            items.map((c) => ({
              to: c.to.toLowerCase(),
              data: c.data.toLowerCase(),
              value: c.value,
            })),
          );
        if (
          canonical(expected) !== canonical(prepared.calls) ||
          callData.toLowerCase() !== prepared.callData.toLowerCase() ||
          prepared.account.id !== account.id ||
          !sameAddress(prepared.account.address, account.address)
        )
          throw new AppError("operation_preparation_changed", 409);
        const key = crypto.randomUUID(),
          input = registerOperationSchema.parse({
            environment: env.id,
            deploymentId: env.deployment.id,
            accountId: account.id,
            idempotencyKey: key,
            intent,
            nonce: prepared.nonce,
            callData,
            factory: prepared.factory,
            factoryData: prepared.factoryData,
            gasPayment: gas.payment,
          });
        // Only a non-executable operation key is retained. The server owns durable recovery across devices.
        sessionStorage.setItem(recoveryKey, key);
        const registration = await api.request(
          intent.kind === "faucet" ? "/v1/faucet/claims" : "/v1/operations",
          operationResponse,
          { auth: true, body: input },
        );
        recorded = registration.operation;
        onRecord(recorded);
        this.current();
        sessionStorage.removeItem(recoveryKey);
        if (recorded.state !== "awaiting-signature") return recorded;
        const operation = recorded;
        if ((operation.gasPayment ?? "sponsored") !== gas.payment)
          throw new AppError("gas_payment_mismatch", 409);
        const transport = custom(
          {
            request: async ({ method, params }) => {
              const reply = await api.request(
                `/v1/aa/${operation.id}`,
                rpcResponse,
                {
                  auth: true,
                  body: {
                    jsonrpc: "2.0",
                    id: crypto.randomUUID(),
                    method,
                    params: params ?? [],
                  },
                },
              );
              if (reply.error)
                throw new AppError(
                  reply.error.data?.code ?? "provider_request_rejected",
                  503,
                  undefined,
                  operation.id,
                );
              if (!("result" in reply))
                throw new AppError("provider_response_invalid", 503);
              return reply.result;
            },
          },
          { retryCount: 0 },
        );
        const paymaster =
          gas.payment === "self-funded"
            ? undefined
            : createZeroDevPaymasterClient({
                chain: arbitrumSepolia,
                transport,
              });
        const accountClient = createKernelAccountClient({
          account: kernel,
          chain: arbitrumSepolia,
          client,
          bundlerTransport: transport,
          paymaster:
            gas.payment === "self-funded"
              ? undefined
              : {
                  getPaymasterData: (parameters) =>
                    paymaster!.sponsorUserOperation({
                      userOperation: parameters,
                    }),
                },
        });
        const unsigned = await accountClient.prepareUserOperation({
          calls,
          nonce: BigInt(operation.nonce),
        });
        this.current();
        const cost =
          [
            unsigned.callGasLimit,
            unsigned.verificationGasLimit,
            unsigned.preVerificationGas,
            unsigned.paymasterVerificationGasLimit,
            unsigned.paymasterPostOpGasLimit,
          ].reduce<bigint>((sum, n) => sum + (n ?? 0n), 0n) *
          (unsigned.maxFeePerGas ?? 0n);
        if (
          (gas.payment === "sponsored"
            ? !unsigned.paymaster
            : !!unsigned.paymaster) ||
          cost === 0n ||
          cost > BigInt(operation.maxGasCost)
        )
          throw new AppError("gas_cost_exceeds_limit", 403);
        if (
          unsigned.nonce !== BigInt(operation.nonce) ||
          unsigned.callData?.toLowerCase() !==
            operation.callData.toLowerCase() ||
          unsigned.factory?.toLowerCase() !==
            (operation.factory?.toLowerCase() ?? undefined) ||
          unsigned.factoryData?.toLowerCase() !==
            (operation.factoryData?.toLowerCase() ?? undefined)
        )
          throw new AppError("operation_preparation_changed", 409);
        if (gas.payment === "self-funded") {
          const balance = await gasBalance(client, account);
          requireGasBalance(balance, cost);
          onStage("reviewing-gas");
          await gas.confirm!({ cost, balance });
          this.current();
          // Recheck after the explicit confirmation, immediately before wallet signing.
          requireGasBalance(await gasBalance(client, account), cost);
          this.current();
        }
        onStage("awaiting-signature");
        const signature = await kernel.signUserOperation(
          unsigned as UserOperation<"0.7">,
        );
        this.current();
        const signed = { ...unsigned, signature } as UserOperation<"0.7">;
        // Validate ordinary wire serialization before passing to the official accountless bundler client.
        formatUserOperationRequest(signed);
        onStage("submitting");
        const bundler = createBundlerClient({
          chain: arbitrumSepolia,
          transport,
        });
        await bundler.sendUserOperation({
          ...signed,
          entryPointAddress: ENTRY_POINT.address,
        });
        const result = await api.request(
          `/v1/operations/${operation.id}`,
          operationResponse,
          { auth: true },
        );
        onRecord(result.operation);
        return result.operation;
      } catch (error) {
        // Wallet/SDK errors may embed a signed request. Only sanitized application errors escape this boundary.
        const lostKey = sessionStorage.getItem(recoveryKey);
        if (!recorded && lostKey) {
          try {
            const original = await lookupRegistration(lostKey);
            if (original) return original;
          } catch {
            /* Retain the key for the next read-only recovery attempt. */
          }
        }
        if (recorded) {
          try {
            const result = await this.api.request(
              `/v1/operations/${recorded.id}`,
              operationResponse,
              { auth: true },
            );
            onRecord(result.operation);
            if (result.operation.userOperationHash !== null)
              return result.operation;
          } catch {
            /* Keep the original operation ID; never resend here. */
          }
        }
        if (error instanceof AppError) throw error;
        throw new AppError(
          recorded
            ? "operation_query_required"
            : "operation_preparation_failed",
          503,
          undefined,
          recorded?.id,
        );
      }
    };
    if (navigator.locks)
      return navigator.locks.request(
        `cpredict-operation:${this.api.key}:${accountIdentity(this.account)}`,
        { ifAvailable: true },
        (lock) => {
          if (!lock) throw new AppError("operation_in_progress", 409);
          return run();
        },
      );
    return run(); // Server-side account/nonce uniqueness still applies when Web Locks is unavailable.
  }
}
