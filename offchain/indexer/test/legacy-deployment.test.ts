import { persistedTopics } from "../src/postgres-store.js";
import { describe, expect, it } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiParameters,
  type Hex,
} from "viem";
import {
  legacyMarketEvents,
  publicMarketState,
} from "../../sdk/src/legacy-protocol.js";
import { encodeLegacyMarketRules } from "../../sdk/src/legacy-market-rules.js";
import {
  encodePublishedMarketRules,
  publishedMarketRulesSchema,
} from "../../sdk/src/published-market-rules.js";
import { deriveMutations } from "../src/derived.js";
import type { IndexedEvent } from "../src/store.js";

const market = "0x1111111111111111111111111111111111111111" as const;
const creator = "0x2222222222222222222222222222222222222222" as const;
const hash = `0x${"1".repeat(64)}` as Hex;
function event(topics: Hex[], data: Hex): IndexedEvent {
  return {
    chainId: 421614,
    address: market,
    blockNumber: 10n,
    blockHash: hash,
    transactionHash: hash,
    transactionIndex: 0,
    logIndex: 0,
    confirmationStatus: "confirmed",
    topics,
    data,
  };
}

describe("verified legacy deployment", () => {
  it("decodes historical JSON-string topics only for legacy deployments and rejects corruption", () => {
    expect(persistedTopics(JSON.stringify([hash]), "legacy-v1")).toEqual([
      hash,
    ]);
    expect(() => persistedTopics(JSON.stringify([hash]), "time-v2")).toThrow();
    expect(() => persistedTopics('["0x123"]', "legacy-v1")).toThrow();
    expect(() => persistedTopics('{"topic":"wrong"}', "legacy-v1")).toThrow();
  });
  it("keeps legacy timeout state 3 in storage and normalizes only for the public site", () => {
    const log = event(
      encodeEventTopics({
        abi: legacyMarketEvents,
        eventName: "MarketVoided",
        args: { terminalState: 3, caller: creator, evidenceHash: hash },
      }) as Hex[],
      encodeAbiParameters(parseAbiParameters("uint256"), [5n]),
    );
    expect(deriveMutations(log, "legacy-v1")).toMatchObject([
      { state: 3, voidReason: 3, terminalKind: "voided-timeout" },
    ]);
    expect(publicMarketState("legacy-v1", 3, 0)).toEqual({
      state: 2,
      voidReason: 3,
    });
    expect(publicMarketState("legacy-v1", 2, 0)).toEqual({
      state: 2,
      voidReason: 1,
    });
    expect(() => publicMarketState("time-v2", 3, 0)).toThrow();
  });
  it("decodes old initialization without inventing new time commitments", () => {
    const log = event(
      encodeEventTopics({
        abi: legacyMarketEvents,
        eventName: "MarketInitialized",
        args: { market, creator, mode: 0 },
      }) as Hex[],
      encodeAbiParameters(
        parseAbiParameters("uint8,uint64,uint64,uint128,uint128"),
        [2, 1000n, 86400n, 50n, 10n],
      ),
    );
    expect(deriveMutations(log, "legacy-v1")).toMatchObject([
      {
        outcomeCount: 2,
        closeAt: 1000n,
        createdAt: null,
        eventStartsAt: null,
        outcomeDeadlineAt: null,
      },
    ]);
    expect(deriveMutations(log, "time-v2")).toEqual([]);
  });
  it("retains exact v1 metadata bytes and commitment", () => {
    const rules = {
      version: "cpredict-rules-v1" as const,
      question: "Does the test finish?",
      outcomes: ["Yes", "No"],
      closesAt: 1000,
      resolutionSource: "https://example.com",
      resolutionCriteria: "Use the published result.",
      cancellationPolicy: "Cancel when the source is unavailable.",
    };
    expect(
      encodePublishedMarketRules(publishedMarketRulesSchema.parse(rules)),
    ).toEqual(encodeLegacyMarketRules(rules));
  });
});
