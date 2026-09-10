import {
  encodeFunctionData,
  hashDomain,
  keccak256,
  parseAbi,
  parseSignature,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { AppError } from "./contracts.js";

export const USDC_ADDRESS =
  "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as const;
export const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
export const RECEIVE_TYPEHASH = keccak256(
  stringToHex(
    "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  ),
);
export const usdcAbi = parseAbi([
  "function name() view returns(string)",
  "function decimals() view returns(uint8)",
  "function DOMAIN_SEPARATOR() view returns(bytes32)",
  "function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() view returns(bytes32)",
  "function authorizationState(address authorizer,bytes32 nonce) view returns(bool)",
  "function balanceOf(address owner) view returns(uint256)",
  "function allowance(address owner,address spender) view returns(uint256)",
  "function paused() view returns(bool)",
  "function isBlacklisted(address account) view returns(bool)",
  "function receiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
  "event AuthorizationCanceled(address indexed authorizer,bytes32 indexed nonce)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
export interface ReceiveAuthorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}
export interface UsdcDomain {
  name: string;
  version: "2";
  chainId: 421614;
  verifyingContract: typeof USDC_ADDRESS;
}

/** The deployed proxy's separator, not its display symbol, establishes the signing domain. */
export async function readUsdcDomain(
  client: PublicClient,
  blockNumber: bigint,
): Promise<UsdcDomain> {
  const read = <
    N extends
      | "name"
      | "decimals"
      | "DOMAIN_SEPARATOR"
      | "RECEIVE_WITH_AUTHORIZATION_TYPEHASH",
  >(
    functionName: N,
  ) =>
    client.readContract({
      address: USDC_ADDRESS,
      abi: usdcAbi,
      functionName,
      blockNumber,
    });
  const [chain, code, name, decimals, separator, typehash] = await Promise.all([
    client.getChainId(),
    client.getCode({ address: USDC_ADDRESS, blockNumber }),
    read("name"),
    read("decimals"),
    read("DOMAIN_SEPARATOR"),
    read("RECEIVE_WITH_AUTHORIZATION_TYPEHASH"),
  ]);
  const domain: UsdcDomain = {
    name,
    version: "2",
    chainId: 421614,
    verifyingContract: USDC_ADDRESS,
  };
  if (
    chain !== 421614 ||
    !code ||
    code === "0x" ||
    decimals !== 6 ||
    typehash.toLowerCase() !== RECEIVE_TYPEHASH.toLowerCase() ||
    hashDomain({
      domain: { ...domain, chainId: BigInt(domain.chainId) },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
      },
    }).toLowerCase() !== separator.toLowerCase()
  )
    throw new AppError("usdc_authorization_unavailable", 503);
  return domain;
}

export function receiveTypedData(
  domain: UsdcDomain,
  authorization: ReceiveAuthorization,
) {
  return {
    domain,
    types: RECEIVE_TYPES,
    primaryType: "ReceiveWithAuthorization" as const,
    message: {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
    },
  };
}

export function receiveCall(
  authorization: ReceiveAuthorization,
  signature: Hex,
) {
  const { r, s, yParity } = parseSignature(signature);
  return {
    to: USDC_ADDRESS,
    value: "0" as const,
    data: encodeFunctionData({
      abi: usdcAbi,
      functionName: "receiveWithAuthorization",
      args: [
        authorization.from,
        authorization.to,
        BigInt(authorization.value),
        BigInt(authorization.validAfter),
        BigInt(authorization.validBefore),
        authorization.nonce,
        yParity + 27,
        r,
        s,
      ],
    }),
  };
}
