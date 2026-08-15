const tokenPermissionsComponents = [
  { name: "token", type: "address" },
  { name: "amount", type: "uint256" },
] as const;

const permitTransferFromComponents = [
  { name: "permitted", type: "tuple", components: tokenPermissionsComponents },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
] as const;

const createMarketComponents = [
  { name: "rulesHash", type: "bytes32" },
  { name: "metadataURI", type: "string" },
  { name: "resolutionSourceHash", type: "bytes32" },
  { name: "resolutionSourceURI", type: "string" },
  { name: "outcomeCount", type: "uint8" },
  { name: "closeAt", type: "uint64" },
  { name: "earlyBirdStart", type: "uint64" },
  { name: "creatorTreasury", type: "address" },
  { name: "deploymentMode", type: "uint8" },
  { name: "featureFlags", type: "uint256" },
  { name: "creatorRakeBps", type: "uint16" },
  { name: "creatorC2CFeeBps", type: "uint16" },
  { name: "perUserPrimaryCap", type: "uint128" },
  { name: "marketPrimaryCap", type: "uint128" },
  { name: "minimumPrimaryUnits", type: "uint128" },
  { name: "minimumC2CUnits", type: "uint128" },
  { name: "creatorBond", type: "uint128" },
] as const;

export const marketFactoryAbi = [
  {
    type: "function",
    name: "createMarket",
    stateMutability: "nonpayable",
    inputs: [
      { name: "params", type: "tuple", components: createMarketComponents },
      { name: "userSalt", type: "bytes32" },
    ],
    outputs: [{ name: "market", type: "address" }],
  },
  {
    type: "function",
    name: "requiredBond",
    stateMutability: "pure",
    inputs: [{ name: "marketPrimaryCap", type: "uint128" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "MarketCreated",
    anonymous: false,
    inputs: [
      { name: "market", type: "address", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "deploymentMode", type: "uint8", indexed: true },
      { name: "implementation", type: "address", indexed: false },
      { name: "salt", type: "bytes32", indexed: false },
      { name: "runtimeCodeHash", type: "bytes32", indexed: false },
      { name: "creatorNonce", type: "uint256", indexed: false },
      { name: "creationFee", type: "uint256", indexed: false },
      { name: "creatorBond", type: "uint256", indexed: false },
    ],
  },
] as const;

export const marketVaultAbi = [
  {
    type: "function",
    name: "buy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "outcomeId", type: "uint256" },
      { name: "desiredUnits", type: "uint256" },
      { name: "minUnits", type: "uint256" },
      { name: "maxPayment", type: "uint256" },
      { name: "deadline", type: "uint64" },
    ],
    outputs: [{ name: "filledUnits", type: "uint256" }],
  },
  {
    type: "function",
    name: "buyWithPermit2",
    stateMutability: "nonpayable",
    inputs: [
      { name: "owner", type: "address" },
      { name: "outcomeId", type: "uint256" },
      { name: "desiredUnits", type: "uint256" },
      { name: "minUnits", type: "uint256" },
      { name: "maxPayment", type: "uint256" },
      { name: "callDeadline", type: "uint64" },
      {
        name: "permit",
        type: "tuple",
        components: permitTransferFromComponents,
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "filledUnits", type: "uint256" }],
  },
  {
    type: "function",
    name: "updateBeforeFirstBuy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "newRulesHash", type: "bytes32" },
      { name: "newMetadataURI", type: "string" },
      { name: "newResolutionSourceHash", type: "bytes32" },
      { name: "newResolutionSourceURI", type: "string" },
      { name: "newCloseAt", type: "uint64" },
      { name: "newEarlyBirdStart", type: "uint64" },
      { name: "newCreatorTreasury", type: "address" },
      { name: "newFeatureFlags", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "resolve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "outcomeId", type: "uint256" },
      { name: "evidenceHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "creatorVoid",
    stateMutability: "nonpayable",
    inputs: [{ name: "evidenceHash", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "voidAfterDeadline",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimWinningsFor",
    stateMutability: "nonpayable",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "refundFor",
    stateMutability: "nonpayable",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimEarlyBirdFor",
    stateMutability: "nonpayable",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "reward", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimTimeoutBonusFor",
    stateMutability: "nonpayable",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "reward", type: "uint256" }],
  },
  {
    type: "function",
    name: "marketState",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "resolutionDeadline",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "MarketResolved",
    anonymous: false,
    inputs: [
      { name: "winningOutcome", type: "uint256", indexed: true },
      { name: "totalPrincipal", type: "uint256", indexed: false },
      { name: "totalRake", type: "uint256", indexed: false },
      { name: "protocolFee", type: "uint256", indexed: false },
      { name: "creatorFee", type: "uint256", indexed: false },
      { name: "earlyBirdPool", type: "uint256", indexed: false },
      { name: "winnerPool", type: "uint256", indexed: false },
      { name: "evidenceHash", type: "bytes32", indexed: true },
    ],
  },
  {
    type: "event",
    name: "MarketVoided",
    anonymous: false,
    inputs: [
      { name: "terminalState", type: "uint8", indexed: true },
      { name: "caller", type: "address", indexed: true },
      { name: "refundPrincipal", type: "uint256", indexed: false },
      { name: "evidenceHash", type: "bytes32", indexed: true },
    ],
  },
] as const;

export const marketplaceAbi = [
  {
    type: "function",
    name: "createListing",
    stateMutability: "nonpayable",
    inputs: [
      { name: "vault", type: "address" },
      { name: "outcomeId", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "unitPrice", type: "uint256" },
      { name: "expiresAt", type: "uint64" },
    ],
    outputs: [{ name: "listingId", type: "bytes32" }],
  },
  {
    type: "function",
    name: "fillListing",
    stateMutability: "nonpayable",
    inputs: [
      { name: "listingId", type: "bytes32" },
      { name: "desiredUnits", type: "uint256" },
      { name: "minUnits", type: "uint256" },
      { name: "maxGross", type: "uint256" },
      { name: "deadline", type: "uint64" },
    ],
    outputs: [
      { name: "filledUnits", type: "uint256" },
      { name: "gross", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "fillListingWithPermit2",
    stateMutability: "nonpayable",
    inputs: [
      { name: "listingId", type: "bytes32" },
      { name: "buyer", type: "address" },
      { name: "desiredUnits", type: "uint256" },
      { name: "minUnits", type: "uint256" },
      { name: "maxGross", type: "uint256" },
      { name: "callDeadline", type: "uint64" },
      {
        name: "permit",
        type: "tuple",
        components: permitTransferFromComponents,
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [
      { name: "filledUnits", type: "uint256" },
      { name: "gross", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "cancelListing",
    stateMutability: "nonpayable",
    inputs: [{ name: "listingId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "returnTerminalListing",
    stateMutability: "nonpayable",
    inputs: [{ name: "listingId", type: "bytes32" }],
    outputs: [],
  },
] as const;

export const bondEscrowAbi = [
  {
    type: "function",
    name: "settleBond",
    stateMutability: "nonpayable",
    inputs: [{ name: "market", type: "address" }],
    outputs: [{ name: "amount", type: "uint256" }],
  },
] as const;

export const exposureGuardAbi = [
  {
    type: "function",
    name: "sync",
    stateMutability: "nonpayable",
    inputs: [{ name: "market", type: "address" }],
    outputs: [
      { name: "previousExposure", type: "uint256" },
      { name: "currentExposure", type: "uint256" },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export type PermitTransferFrom = {
  permitted: { token: `0x${string}`; amount: bigint };
  nonce: bigint;
  deadline: bigint;
};
