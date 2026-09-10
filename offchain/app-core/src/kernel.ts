import {
  getKernelAddressFromECDSA,
  getValidatorAddress,
  signerToEcdsaValidator,
} from "@zerodev/ecdsa-validator";
import { createKernelAccount } from "@zerodev/sdk";
import {
  getEntryPoint,
  KERNEL_V3_1,
  KernelVersionToAddressesMap,
} from "@zerodev/sdk/constants";
import type { Signer } from "@zerodev/sdk/types";
import {
  getAddress,
  keccak256,
  parseAbi,
  stringToBytes,
  toHex,
  type Address,
  type PublicClient,
} from "viem";
import { toAccount } from "viem/accounts";
import { AppError, sameAddress, type Environment } from "./contracts.js";

// Never replace these with SDK defaults. Existing asset addresses depend on them.
export const ACCOUNT_VERSION = KERNEL_V3_1;
export const ENTRY_POINT = getEntryPoint("0.7");
export const ACCOUNT_ADDRESSES = KernelVersionToAddressesMap[ACCOUNT_VERSION];

export async function deriveAssetAddress(
  client: PublicClient,
  controller: Address,
  environment: Environment,
): Promise<Address> {
  return getAddress(
    await getKernelAddressFromECDSA({
      publicClient: client,
      entryPoint: ENTRY_POINT,
      kernelVersion: ACCOUNT_VERSION,
      eoaAddress: controller,
      index: BigInt(environment.account.index),
    }),
  );
}

export async function createAppKernel(
  client: PublicClient,
  signer: Signer,
  environment: Environment,
) {
  if (environment.account.kernelVersion !== ACCOUNT_VERSION)
    throw new AppError("account_version_mismatch", 409);
  const validator = await signerToEcdsaValidator(client, {
    signer,
    entryPoint: ENTRY_POINT,
    kernelVersion: ACCOUNT_VERSION,
  });
  return createKernelAccount(client, {
    plugins: { sudo: validator },
    entryPoint: ENTRY_POINT,
    kernelVersion: ACCOUNT_VERSION,
    index: BigInt(environment.account.index),
    useMetaFactory: true,
  });
}

/** Server-side construction uses only a public controller address. Signing is impossible here. */
export function readOnlyController(controller: Address) {
  const cannotSign = async (): Promise<never> => {
    throw new Error("server cannot sign for a controller");
  };
  return toAccount({
    address: controller,
    signMessage: cannotSign,
    signTypedData: cannotSign,
    signTransaction: cannotSign,
  });
}

export async function assertCurrentController(
  client: PublicClient,
  asset: Address,
  controller: Address,
): Promise<void> {
  const code = await client.getCode({ address: asset });
  if (code === undefined || code === "0x") return;
  const validator = getValidatorAddress(ENTRY_POINT, ACCOUNT_VERSION);
  const rootAbi = parseAbi([
    "function rootValidator() view returns(bytes21)",
    "function validationConfig(bytes21) view returns((uint32 nonce,address hook))",
  ]);
  const root = await client.readContract({
    address: asset,
    abi: rootAbi,
    functionName: "rootValidator",
  });
  if (root.toLowerCase() !== `0x01${validator.slice(2).toLowerCase()}`)
    throw new AppError("account_validator_changed", 409);
  const validation = await client.readContract({
    address: asset,
    abi: rootAbi,
    functionName: "validationConfig",
    args: [root],
  });
  if (
    !sameAddress(validation.hook, "0x0000000000000000000000000000000000000001")
  )
    throw new AppError("account_hook_changed", 409);
  const actual = await client.readContract({
    address: validator,
    abi: parseAbi([
      "function ecdsaValidatorStorage(address) view returns (address owner)",
    ]),
    functionName: "ecdsaValidatorStorage",
    args: [asset],
  });
  const implementation = await client.getStorageAt({
    address: asset,
    slot: toHex(
      BigInt(keccak256(stringToBytes("eip1967.proxy.implementation"))) - 1n,
      { size: 32 },
    ),
  });
  // The standard EIP-1967 slot is used below; never infer account compatibility
  // merely from a matching ECDSA validator owner.
  if (!sameAddress(actual, controller))
    throw new AppError("controller_changed", 409);
  if (
    implementation === undefined ||
    !sameAddress(
      `0x${implementation.slice(-40)}`,
      ACCOUNT_ADDRESSES.accountImplementationAddress,
    )
  )
    throw new AppError("account_implementation_changed", 409);
}
