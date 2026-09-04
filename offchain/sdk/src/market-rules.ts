import { keccak256, toBytes, type Hex } from "viem";
import { z } from "zod";
import { assertMarketTimes } from "./market-times.js";

export const marketRulesSchema = z
  .strictObject({
    version: z.literal("cpredict-rules-v2"),
    question: z.string().trim().min(8).max(512),
    outcomes: z.array(z.string().trim().min(1).max(128)).min(2).max(32),
    closeAt: z.number().int().safe().positive(),
    eventStartsAt: z.number().int().safe().positive().nullable(),
    outcomeDeadlineAt: z.number().int().safe().positive(),
    resolutionDeadlineAt: z.number().int().safe().positive(),
    resolutionSource: z.string().trim().min(1).max(512),
    resolutionCriteria: z.string().trim().min(8).max(2_048),
    cancellationPolicy: z.string().trim().min(8).max(2_048),
  })
  .superRefine((rules, ctx) => {
    try {
      assertMarketTimes({
        closeAt: BigInt(rules.closeAt),
        eventStartsAt:
          rules.eventStartsAt === null ? null : BigInt(rules.eventStartsAt),
        outcomeDeadlineAt: BigInt(rules.outcomeDeadlineAt),
        resolutionDeadlineAt: BigInt(rules.resolutionDeadlineAt),
      });
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["outcomeDeadlineAt"],
        message: String(error),
      });
    }
  });

export type MarketRules = z.output<typeof marketRulesSchema>;

export function marketRulesMatchTimes(
  rules: MarketRules,
  chain: {
    closeAt: bigint | null;
    eventStartsAt: bigint | null;
    outcomeDeadlineAt: bigint | null;
    resolutionDeadlineAt: bigint | null;
  },
): boolean {
  return (
    BigInt(rules.closeAt) === chain.closeAt &&
    (rules.eventStartsAt === null ? null : BigInt(rules.eventStartsAt)) ===
      chain.eventStartsAt &&
    BigInt(rules.outcomeDeadlineAt) === chain.outcomeDeadlineAt &&
    BigInt(rules.resolutionDeadlineAt) === chain.resolutionDeadlineAt
  );
}

/** Canonical commitment used by createMarket.rulesHash; clients retain/publish the exact JSON. */
export function encodeMarketRules(input: MarketRules): {
  canonicalJson: string;
  rulesHash: Hex;
} {
  const rules = marketRulesSchema.parse(input);
  if (
    new Set(rules.outcomes.map((outcome) => outcome.toLocaleLowerCase("en-US")))
      .size !== rules.outcomes.length
  ) {
    throw new RangeError("outcome labels must be unique");
  }
  const canonicalJson = JSON.stringify({
    version: rules.version,
    question: rules.question,
    outcomes: rules.outcomes,
    closeAt: rules.closeAt,
    eventStartsAt: rules.eventStartsAt,
    outcomeDeadlineAt: rules.outcomeDeadlineAt,
    resolutionDeadlineAt: rules.resolutionDeadlineAt,
    resolutionSource: rules.resolutionSource,
    resolutionCriteria: rules.resolutionCriteria,
    cancellationPolicy: rules.cancellationPolicy,
  });
  return { canonicalJson, rulesHash: keccak256(toBytes(canonicalJson)) };
}
