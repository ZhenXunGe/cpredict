import { SHARE_SCALE } from "../../../offchain/sdk/src/index.js";

export const PRIMARY_MARKET_UNIT_PRICE = SHARE_SCALE;

export function shouldFoldListingBeforeClose(
  unitPrice: bigint,
  observedAt: bigint,
  closeAt: bigint,
): boolean {
  return observedAt < closeAt && unitPrice > PRIMARY_MARKET_UNIT_PRICE;
}
