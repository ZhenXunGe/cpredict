import { createKernelAccount } from "@zerodev/sdk";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
  toPermissionValidator,
  PolicyFlags,
  type Policy,
} from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  concatHex,
  encodeAbiParameters,
  parseAbi,
  type Hex,
  type PublicClient,
} from "viem";
import type { Signer } from "@zerodev/sdk/types";
import type { Environment } from "./contracts.js";
import type { TradingSession } from "./trading-session-contracts.js";
import { ACCOUNT_VERSION, ENTRY_POINT, readOnlyController } from "./kernel.js";
export const tradingPolicyAbi = parseAbi([
  "function sessionState(bytes32 id,address account) view returns (uint128 perOperation,uint128 total,uint128 spent,uint48 validAfter,uint48 validUntil,bool installed,bool revoked)",
  "function revoke(bytes32 id)",
  "function factory() view returns (address)",
  "function marketplace() view returns (address)",
  "function paymentToken() view returns (address)",
  "function bondEscrow() view returns (address)",
  "function feeVault() view returns (address)",
  "function paymaster() view returns (address)",
]);
export function policyId(s: Pick<TradingSession, "permissionId">): Hex {
  return `${s.permissionId}${"0".repeat(56)}` as Hex;
}
export async function createSessionKernel(
  client: PublicClient,
  environment: Environment,
  session: TradingSession,
  options: { controller?: Signer; signer?: Signer; enableSignature?: Hex } = {},
) {
  const policy: Policy = {
    getPolicyInfoInBytes: () =>
      concatHex([PolicyFlags.FOR_ALL_VALIDATION, session.config.policy]),
    getPolicyData: () =>
      encodeAbiParameters(
        [
          { type: "uint128" },
          { type: "uint128" },
          { type: "uint48" },
          { type: "uint48" },
        ],
        [
          BigInt(session.perOperation),
          BigInt(session.total),
          Number(session.validAfter),
          Number(session.validUntil),
        ],
      ),
    // Custom policies are reconstructed from our versioned descriptor, never
    // through the SDK serializer (whose union only lists bundled policies).
    policyParams: {
      type: "cpredict-trading-v1",
    } as unknown as Policy["policyParams"],
  };
  const [sudo, signer] = await Promise.all([
    signerToEcdsaValidator(client, {
      signer: options.controller ?? readOnlyController(session.controller),
      entryPoint: ENTRY_POINT,
      kernelVersion: ACCOUNT_VERSION,
    }),
    toECDSASigner({
      signer: options.signer ?? readOnlyController(session.publicKey),
      signerContractAddress: session.config.signer,
    }),
  ]);
  const regular = await toPermissionValidator(client, {
    signer,
    policies: [policy],
    entryPoint: ENTRY_POINT,
    kernelVersion: ACCOUNT_VERSION,
    permissionId: session.permissionId,
    flag: PolicyFlags.FOR_ALL_VALIDATION,
  });
  return createKernelAccount(client, {
    plugins: {
      sudo,
      regular,
      hook: {
        getIdentifier: () => session.config.policy,
        getEnableData: async () => "0x00",
      },
      ...(options.enableSignature
        ? { pluginEnableSignature: options.enableSignature }
        : {}),
    },
    entryPoint: ENTRY_POINT,
    kernelVersion: ACCOUNT_VERSION,
    index: BigInt(environment.account.index),
    useMetaFactory: true,
  });
}
