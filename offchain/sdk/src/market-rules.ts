import { keccak256, toBytes, type Hex } from "viem";
import { z } from "zod";

export const marketRulesSchema = z.object({
  version: z.literal("cpredict-rules-v1"),
  question: z.string().trim().min(8).max(512),
  outcomes: z.array(z.string().trim().min(1).max(128)).min(2).max(32),
  closesAt: z.number().int().positive(),
  resolutionSource: z.string().trim().min(1).max(512),
  resolutionCriteria: z.string().trim().min(8).max(2_048),
  cancellationPolicy: z.string().trim().min(8).max(2_048),
});

export type MarketRules = z.output<typeof marketRulesSchema>;

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
    closesAt: rules.closesAt,
    resolutionSource: rules.resolutionSource,
    resolutionCriteria: rules.resolutionCriteria,
    cancellationPolicy: rules.cancellationPolicy,
  });
  return { canonicalJson, rulesHash: keccak256(toBytes(canonicalJson)) };
}
