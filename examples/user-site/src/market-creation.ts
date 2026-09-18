import { z } from "zod";
import type { Market } from "../../../offchain/app-core/src/catalog-contracts.js";
import { AppError } from "../../../offchain/app-core/src/contracts.js";

// The contract requires five minutes at inclusion; retain one minute for signing and inclusion.
export function checkCreationTime(closeAt: bigint, chainTime: bigint): void {
  if (closeAt < chainTime + 360n)
    throw new AppError("creation_close_too_soon", 409);
  if (closeAt > chainTime + 90n * 86400n)
    throw new AppError("creation_close_too_late", 409);
}

export const creationNoticeSchema = z.object({
  accountId: z.string(),
  identityKey: z.string(),
  rulesHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  blockNumber: z.string().regex(/^\d+$/).nullable(),
  operationId: z.string().uuid(),
  confirmedAt: z.number(),
});
export type CreationNotice = z.infer<typeof creationNoticeSchema>;
export function isNewlyCreatedMarket(market: Market, creation: CreationNotice) {
  return (
    creation.blockNumber !== null &&
    market.createdBlock === creation.blockNumber &&
    market.rulesHash?.toLowerCase() === creation.rulesHash.toLowerCase()
  );
}
