import { describe, expect, it } from "vitest";
import {
  getAddress,
  hashTypedData,
  keccak256,
  slice,
  toHex,
  type Hex,
} from "viem";
import {
  createSponsorship,
  type SponsorshipConfig,
} from "../src/sponsorship.js";
import type { PackedUserOperationInput, SponsorSigner } from "../src/types.js";

const ENTRY_POINT = getAddress("0x1111111111111111111111111111111111111111");
const PAYMASTER = getAddress("0x2222222222222222222222222222222222222222");
const SIGNER = getAddress("0x3333333333333333333333333333333333333333");
const SENDER = getAddress("0x4444444444444444444444444444444444444444");

function config(overrides: Partial<SponsorshipConfig> = {}): SponsorshipConfig {
  return {
    chainId: 84_532,
    entryPoint: ENTRY_POINT,
    paymaster: PAYMASTER,
    verificationGasLimit: 150_000n,
    postOpGasLimit: 100_000n,
    validitySeconds: 300,
    policyVersion: 7,
    ...overrides,
  };
}

function userOperation(): PackedUserOperationInput {
  return {
    sender: SENDER,
    nonce: 9n,
    initCode: "0x",
    callData: "0x12345678",
    accountGasLimits: `0x${"01".repeat(32)}`,
    preVerificationGas: 100_000n,
    gasFees: `0x${"02".repeat(32)}`,
    signature: "0x1234",
  };
}

class CapturingSigner implements SponsorSigner {
  digest: Hex | undefined;

  async ready(): Promise<void> {}

  async address() {
    return SIGNER;
  }

  async signDigest(digest: Hex): Promise<Hex> {
    this.digest = digest;
    return `0x${"11".repeat(65)}`;
  }
}

describe("sponsorship typed data", () => {
  it("matches an independent canonical EIP-712 vector and packs signed gas limits", async () => {
    const signer = new CapturingSigner();
    const operation = userOperation();
    const sponsorship = await createSponsorship(
      signer,
      config(),
      operation,
      5_000n,
      1_800_000_000,
    );
    const expected = hashTypedData({
      domain: {
        name: "Cpredict Sponsorship Paymaster",
        version: "1",
        chainId: 84_532,
        verifyingContract: PAYMASTER,
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
        sender: operation.sender,
        nonce: operation.nonce,
        initCodeHash: keccak256(operation.initCode),
        callDataHash: keccak256(operation.callData),
        accountGasLimits: operation.accountGasLimits,
        preVerificationGas: operation.preVerificationGas,
        gasFees: operation.gasFees,
        paymasterVerificationGasLimit: 150_000n,
        paymasterPostOpGasLimit: 100_000n,
        validAfter: sponsorship.validAfter,
        validUntil: sponsorship.validUntil,
        maxCost: 5_000n,
        policyVersion: 7,
        chainId: 84_532n,
        entryPoint: ENTRY_POINT,
        paymaster: PAYMASTER,
      },
    });

    expect(signer.digest).toBe(expected);
    expect(slice(sponsorship.paymasterAndData, 0, 20)).toBe(
      PAYMASTER.toLowerCase(),
    );
    expect(slice(sponsorship.paymasterAndData, 20, 36)).toBe(
      toHex(150_000n, { size: 16 }),
    );
    expect(slice(sponsorship.paymasterAndData, 36, 52)).toBe(
      toHex(100_000n, { size: 16 }),
    );
  });

  it("changes the authorization digest when either paymaster gas limit changes", async () => {
    const baseSigner = new CapturingSigner();
    const verificationSigner = new CapturingSigner();
    const postOpSigner = new CapturingSigner();
    const operation = userOperation();
    await createSponsorship(
      baseSigner,
      config(),
      operation,
      5_000n,
      1_800_000_000,
    );
    await createSponsorship(
      verificationSigner,
      config({ verificationGasLimit: 150_001n }),
      operation,
      5_000n,
      1_800_000_000,
    );
    await createSponsorship(
      postOpSigner,
      config({ postOpGasLimit: 100_001n }),
      operation,
      5_000n,
      1_800_000_000,
    );
    expect(verificationSigner.digest).not.toBe(baseSigner.digest);
    expect(postOpSigner.digest).not.toBe(baseSigner.digest);
  });
});
