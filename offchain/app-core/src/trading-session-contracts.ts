import { z } from "zod";
import {
  address,
  hash,
  uint,
  positive,
  quickTradingConfigSchema,
  type BusinessIntent,
} from "./contracts.js";
export const permissionIdSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/)
  .transform((v) => v as `0x${string}`);
export const tradingSessionSchema = z.strictObject({
  id: z.string().uuid(),
  accountId: z.string().uuid(),
  account: address,
  controller: address,
  environment: z.string(),
  deploymentId: z.string(),
  publicKey: address,
  permissionId: permissionIdSchema,
  config: quickTradingConfigSchema,
  perOperation: positive,
  total: positive,
  validAfter: uint,
  validUntil: uint,
  createdAt: z.string().datetime(),
  state: z.enum(["prepared", "active", "disabled"]),
  authorizationHash: hash,
});
export type TradingSession = z.infer<typeof tradingSessionSchema>;
export const sessionPrepareSchema = z.strictObject({
  accountId: z.string().uuid(),
  publicKey: address,
  perOperation: positive,
  total: positive,
});
export const sessionViewSchema = z.object({
  session: tradingSessionSchema,
  spent: uint,
  pending: uint,
  revoked: z.boolean(),
});
export type SessionView = z.infer<typeof sessionViewSchema>;
export function supportsQuickTrading(intent: BusinessIntent): boolean {
  return [
    "buy",
    "fill-listing",
    "create-listing",
    "cancel-listing",
    "return-listing",
    "claim-winner",
    "claim-early-bird",
    "refund",
    "claim-timeout-bonus",
    "settle-bond",
    "settle-bond-and-claim",
    "claim-bond",
    "claim-fees",
  ].includes(intent.kind);
}
export function sessionSpend(intent: BusinessIntent): bigint {
  return intent.kind === "buy" || intent.kind === "fill-listing"
    ? BigInt(intent.maxPayment)
    : 0n;
}

export const tradingSessionPageSchema = z.object({
  items: z.array(tradingSessionSchema),
  nextCursor: z.string().uuid().nullable().default(null),
});
