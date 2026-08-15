import {
  getAddress,
  hashStruct,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";

export const BUY_WITNESS_TYPE_STRING =
  "BuyWitness witness)BuyWitness(address owner,address vault,bytes4 selector,uint256 outcomeId,uint256 desiredUnits,uint256 minUnits,uint256 maxPayment,uint64 callDeadline,uint256 chainId)TokenPermissions(address token,uint256 amount)";
export const FILL_WITNESS_TYPE_STRING =
  "FillWitness witness)FillWitness(address buyer,address marketplace,bytes4 selector,bytes32 listingId,uint256 desiredUnits,uint256 minUnits,uint256 maxGross,uint64 callDeadline,uint256 chainId)TokenPermissions(address token,uint256 amount)";
export const BUY_WITH_PERMIT2_SELECTOR = toFunctionSelector(
  "buyWithPermit2(address,uint256,uint256,uint256,uint256,uint64,((address,uint256),uint256,uint256),bytes)",
);
export const FILL_WITH_PERMIT2_SELECTOR = toFunctionSelector(
  "fillListingWithPermit2(bytes32,address,uint256,uint256,uint256,uint64,((address,uint256),uint256,uint256),bytes)",
);

const tokenPermissions = [
  { name: "token", type: "address" },
  { name: "amount", type: "uint256" },
] as const;
const permitWitnessTransferFrom = [
  { name: "permitted", type: "TokenPermissions" },
  { name: "spender", type: "address" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

export const buyPermit2Types = {
  TokenPermissions: tokenPermissions,
  BuyWitness: [
    { name: "owner", type: "address" },
    { name: "vault", type: "address" },
    { name: "selector", type: "bytes4" },
    { name: "outcomeId", type: "uint256" },
    { name: "desiredUnits", type: "uint256" },
    { name: "minUnits", type: "uint256" },
    { name: "maxPayment", type: "uint256" },
    { name: "callDeadline", type: "uint64" },
    { name: "chainId", type: "uint256" },
  ],
  PermitWitnessTransferFrom: [
    ...permitWitnessTransferFrom,
    { name: "witness", type: "BuyWitness" },
  ],
} as const;

export const fillPermit2Types = {
  TokenPermissions: tokenPermissions,
  FillWitness: [
    { name: "buyer", type: "address" },
    { name: "marketplace", type: "address" },
    { name: "selector", type: "bytes4" },
    { name: "listingId", type: "bytes32" },
    { name: "desiredUnits", type: "uint256" },
    { name: "minUnits", type: "uint256" },
    { name: "maxGross", type: "uint256" },
    { name: "callDeadline", type: "uint64" },
    { name: "chainId", type: "uint256" },
  ],
  PermitWitnessTransferFrom: [
    ...permitWitnessTransferFrom,
    { name: "witness", type: "FillWitness" },
  ],
} as const;

export interface Permit2TokenPermission {
  token: Address;
  amount: bigint;
}

export interface Permit2Authorization {
  permitted: Permit2TokenPermission;
  nonce: bigint;
  deadline: bigint;
}

export interface BuyWitness {
  owner: Address;
  vault: Address;
  selector: Hex;
  outcomeId: bigint;
  desiredUnits: bigint;
  minUnits: bigint;
  maxPayment: bigint;
  callDeadline: bigint;
  chainId: bigint;
}

export interface FillWitness {
  buyer: Address;
  marketplace: Address;
  selector: Hex;
  listingId: Hex;
  desiredUnits: bigint;
  minUnits: bigint;
  maxGross: bigint;
  callDeadline: bigint;
  chainId: bigint;
}

export function buildBuyPermit2TypedData(
  permit2: Address,
  authorization: Permit2Authorization,
  witness: BuyWitness,
) {
  assertAuthorization(authorization);
  assertWitnessChain(witness.chainId);
  const data = normalizeBuyWitness(witness);
  return {
    domain: permit2Domain(permit2, witness.chainId),
    types: buyPermit2Types,
    primaryType: "PermitWitnessTransferFrom" as const,
    message: {
      permitted: normalizePermission(authorization.permitted),
      spender: data.vault,
      nonce: authorization.nonce,
      deadline: authorization.deadline,
      witness: data,
    },
    witness: hashStruct({
      types: buyPermit2Types,
      primaryType: "BuyWitness",
      data,
    }),
  };
}

export function buildFillPermit2TypedData(
  permit2: Address,
  authorization: Permit2Authorization,
  witness: FillWitness,
) {
  assertAuthorization(authorization);
  assertWitnessChain(witness.chainId);
  const data = normalizeFillWitness(witness);
  return {
    domain: permit2Domain(permit2, witness.chainId),
    types: fillPermit2Types,
    primaryType: "PermitWitnessTransferFrom" as const,
    message: {
      permitted: normalizePermission(authorization.permitted),
      spender: data.marketplace,
      nonce: authorization.nonce,
      deadline: authorization.deadline,
      witness: data,
    },
    witness: hashStruct({
      types: fillPermit2Types,
      primaryType: "FillWitness",
      data,
    }),
  };
}

function permit2Domain(verifyingContract: Address, chainId: bigint) {
  return {
    name: "Permit2",
    chainId,
    verifyingContract: getAddress(verifyingContract),
  } as const;
}

function normalizePermission(permission: Permit2TokenPermission) {
  return { token: getAddress(permission.token), amount: permission.amount };
}

function normalizeBuyWitness(witness: BuyWitness) {
  return {
    ...witness,
    owner: getAddress(witness.owner),
    vault: getAddress(witness.vault),
  };
}

function normalizeFillWitness(witness: FillWitness) {
  return {
    ...witness,
    buyer: getAddress(witness.buyer),
    marketplace: getAddress(witness.marketplace),
  };
}

function assertAuthorization(authorization: Permit2Authorization): void {
  if (authorization.permitted.amount <= 0n)
    throw new RangeError("permit amount must be positive");
  if (authorization.nonce < 0n || authorization.deadline <= 0n) {
    throw new RangeError("permit nonce/deadline out of range");
  }
}

function assertWitnessChain(chainId: bigint): void {
  if (chainId <= 0n) throw new RangeError("chainId must be positive");
}
