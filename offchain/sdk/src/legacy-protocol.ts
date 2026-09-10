import { parseAbi } from "viem";
import { assertMarketState } from "./market-state.js";

/** The existing ctUSD deployment predates the time-v2 ABI. Select explicitly
 * from the verified deployment manifest, never by catching an RPC failure. */
export type ProtocolVersion = "legacy-v1" | "time-v2";
export const legacyMarketEvents = parseAbi([
  "event MarketInitialized(address indexed market,address indexed creator,uint8 indexed mode,uint8 outcomeCount,uint64 closeAt,uint64 resolutionWindow,uint128 marketPrimaryCap,uint128 creatorBond)",
  "event MarketMetadataUpdated(bytes32 indexed rulesHash,string metadataURI,bytes32 indexed resolutionSourceHash,string resolutionSourceURI,uint64 closeAt,uint64 earlyBirdStart,address indexed creatorTreasury,uint256 featureFlags)",
  "event MarketVoided(uint8 indexed terminalState,address indexed caller,uint256 refundPrincipal,bytes32 indexed evidenceHash)",
]);

/** Normalize only at the public-site boundary. Retain legacy state 3 in the
 * database and legacy API so existing clients can still identify timeouts. */
export function publicMarketState(
  protocol: ProtocolVersion | undefined,
  state: number,
  voidReason: number,
): { state: number; voidReason: number } {
  if (protocol === "legacy-v1") {
    if (!Number.isInteger(state) || state < 0 || state > 3)
      throw new RangeError("invalid legacy market state");
    return {
      state: state < 2 ? state : 2,
      voidReason: state === 2 ? 1 : state === 3 ? 3 : 0,
    };
  }
  assertMarketState(state, voidReason);
  return { state, voidReason };
}
