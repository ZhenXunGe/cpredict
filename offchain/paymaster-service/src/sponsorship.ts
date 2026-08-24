import {
  concatHex,
  hashTypedData,
  keccak256,
  size,
  toHex,
  type Address,
  type Hex,
} from "viem";
import type { PackedUserOperationInput, SponsorSigner } from "./types.js";

export interface SponsorshipConfig {
  chainId: 421_614;
  entryPoint: Address;
  paymaster: Address;
  verificationGasLimit: bigint;
  postOpGasLimit: bigint;
  validitySeconds: number;
  policyVersion: number;
}

export const MIN_PAYMASTER_VERIFICATION_GAS_LIMIT = 150_000n;
export const MAX_PAYMASTER_VERIFICATION_GAS_LIMIT = 500_000n;
export const MIN_PAYMASTER_POST_OP_GAS_LIMIT = 100_000n;
export const MAX_PAYMASTER_POST_OP_GAS_LIMIT = 300_000n;

function validateSponsorshipConfig(config: SponsorshipConfig): void {
  if (
    config.verificationGasLimit < MIN_PAYMASTER_VERIFICATION_GAS_LIMIT ||
    config.verificationGasLimit > MAX_PAYMASTER_VERIFICATION_GAS_LIMIT
  ) {
    throw new RangeError(
      "paymaster verification gas limit is outside contract bounds",
    );
  }
  if (
    config.postOpGasLimit < MIN_PAYMASTER_POST_OP_GAS_LIMIT ||
    config.postOpGasLimit > MAX_PAYMASTER_POST_OP_GAS_LIMIT
  ) {
    throw new RangeError(
      "paymaster postOp gas limit is outside contract bounds",
    );
  }
  if (
    !Number.isSafeInteger(config.validitySeconds) ||
    config.validitySeconds < 60 ||
    config.validitySeconds > 900
  ) {
    throw new RangeError(
      "sponsorship validity must be between 60 and 900 seconds",
    );
  }
  if (
    !Number.isSafeInteger(config.policyVersion) ||
    config.policyVersion < 1 ||
    config.policyVersion > 0xffff_ffff
  ) {
    throw new RangeError("invalid sponsorship policy version");
  }
}

export async function createSponsorship(
  signer: SponsorSigner,
  config: SponsorshipConfig,
  userOperation: PackedUserOperationInput,
  maxCost: bigint,
  nowSeconds: number,
): Promise<{ paymasterAndData: Hex; validAfter: number; validUntil: number }> {
  validateSponsorshipConfig(config);
  if (maxCost <= 0n || maxCost > (1n << 256n) - 1n)
    throw new RangeError("invalid maximum cost");
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 30)
    throw new RangeError("invalid current time");
  const validAfter = Math.max(0, nowSeconds - 30);
  const validUntil = nowSeconds + config.validitySeconds;
  const digest = hashTypedData({
    domain: {
      name: "Cpredict Sponsorship Paymaster",
      version: "1",
      chainId: config.chainId,
      verifyingContract: config.paymaster,
    },
    primaryType: "Sponsorship",
    types: {
      Sponsorship: [
        { name: "sender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "initCodeHash", type: "bytes32" },
        { name: "callDataHash", type: "bytes32" },
        { name: "accountGasLimits", type: "bytes32" },
        { name: "preVerificationGas", type: "uint256" },
        { name: "gasFees", type: "bytes32" },
        { name: "paymasterVerificationGasLimit", type: "uint128" },
        { name: "paymasterPostOpGasLimit", type: "uint128" },
        { name: "validAfter", type: "uint48" },
        { name: "validUntil", type: "uint48" },
        { name: "maxCost", type: "uint256" },
        { name: "policyVersion", type: "uint32" },
        { name: "chainId", type: "uint256" },
        { name: "entryPoint", type: "address" },
        { name: "paymaster", type: "address" },
      ],
    },
    message: {
      sender: userOperation.sender,
      nonce: userOperation.nonce,
      initCodeHash: keccak256(userOperation.initCode),
      callDataHash: keccak256(userOperation.callData),
      accountGasLimits: userOperation.accountGasLimits,
      preVerificationGas: userOperation.preVerificationGas,
      gasFees: userOperation.gasFees,
      paymasterVerificationGasLimit: config.verificationGasLimit,
      paymasterPostOpGasLimit: config.postOpGasLimit,
      validAfter,
      validUntil,
      maxCost,
      policyVersion: config.policyVersion,
      chainId: BigInt(config.chainId),
      entryPoint: config.entryPoint,
      paymaster: config.paymaster,
    },
  });
  const signature = await signer.signDigest(digest);
  if (size(signature) !== 65)
    throw new Error("KMS/HSM signer returned a non-65-byte signature");
  const paymasterAndData = concatHex([
    config.paymaster,
    toHex(config.verificationGasLimit, { size: 16 }),
    toHex(config.postOpGasLimit, { size: 16 }),
    toHex(validAfter, { size: 6 }),
    toHex(validUntil, { size: 6 }),
    toHex(maxCost, { size: 32 }),
    toHex(config.policyVersion, { size: 4 }),
    signature,
  ]);
  return { paymasterAndData, validAfter, validUntil };
}
