import { z } from "zod";
import { encodeMarketRules, marketRulesSchema } from "./market-rules.js";
import {
  encodeLegacyMarketRules,
  legacyMarketRulesSchema,
} from "./legacy-market-rules.js";

/** The metadata archive is immutable and must keep serving both commitments. */
export const publishedMarketRulesSchema = z.union([
  marketRulesSchema,
  legacyMarketRulesSchema,
]);
export type PublishedMarketRules = z.output<typeof publishedMarketRulesSchema>;
export function encodePublishedMarketRules(rules: PublishedMarketRules) {
  return rules.version === "cpredict-rules-v1"
    ? encodeLegacyMarketRules(rules)
    : encodeMarketRules(rules);
}
