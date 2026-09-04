import {
  encodeMarketRules,
  type MarketRules,
} from "../../../offchain/sdk/src/index.js";
import type { AccountSnapshot, MarketSnapshot } from "../src/protocol.js";
import type { IndexedListing } from "../src/indexer-client.js";

export const UX_RULES: MarketRules = {
  version: "cpredict-rules-v2",
  question: "主播能在本场比赛中获胜吗？",
  outcomes: ["YES", "NO"],
  closeAt: 1_900_000_000,
  eventStartsAt: null,
  outcomeDeadlineAt: 1_900_000_600,
  resolutionDeadlineAt: 1_900_001_500,
  resolutionSource: "https://example.invalid/official-result",
  resolutionCriteria: "以直播结束时官方赛果中的获胜方为准。",
  cancellationPolicy: "比赛取消、延期或截止时无法观察到结果则作废退款。",
};
export const UX_MARKET: MarketSnapshot = {
  address: "0x0000000000000000000000000000000000001001",
  creator: "0x000000000000000000000000000000000000a001",
  creatorTreasury: "0x000000000000000000000000000000000000b001",
  rulesHash: encodeMarketRules(UX_RULES).rulesHash,
  outcomeCount: 2,
  createdAt: 1_899_999_000n,
  observedAt: 1_899_999_500n,
  closeAt: BigInt(UX_RULES.closeAt),
  eventStartsAt: null,
  outcomeDeadlineAt: BigInt(UX_RULES.outcomeDeadlineAt),
  resolutionDeadline: BigInt(UX_RULES.resolutionDeadlineAt),
  featureFlags: 0n,
  perUserPrimaryCap: 10_000_000n,
  marketPrimaryCap: 100_000_000n,
  minimumPrimaryUnits: 1_000_000n,
  minimumC2CUnits: 1_000_000n,
  creatorBond: 5_000_000n,
  marketState: 0,
  voidReason: 0,
  winningOutcome: 0,
  totalPrincipal: 0n,
  permit2Enabled: false,
  earlyBirdEnabled: false,
};
export const UX_ACCOUNT: AccountSnapshot = {
  usdcBalance: 20_000_000n,
  factoryAllowance: 0n,
  vaultAllowance: 0n,
  marketplaceAllowance: 0n,
  permit2Allowance: 0n,
  marketplaceApproved: true,
  cumulativePrimaryBought: 0n,
  earlyBirdScore: 0n,
  positions: [
    { outcomeId: 0, balance: 2_000_000n },
    { outcomeId: 1, balance: 0n },
  ],
};
export const UX_LISTING: IndexedListing = {
  listingId: `0x${"ab".repeat(32)}`,
  vault: UX_MARKET.address,
  seller: UX_MARKET.creator,
  outcomeId: 0n,
  unitPrice: 1_200_000n,
  remainingUnits: 2_000_000n,
  expiresAt: UX_MARKET.resolutionDeadline,
  active: true,
  updatedBlock: 100n,
  confirmationStatus: "confirmed",
};
