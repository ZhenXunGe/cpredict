import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { erc20Abi, parseAbi, type Address } from "viem";
import { z } from "zod";
import {
  address,
  hash,
  uint,
  AppError,
} from "../../../offchain/app-core/src/contracts.js";
import {
  marketRulesSchema,
  encodeMarketRules,
  marketRulesMatchTimes,
} from "../../../offchain/sdk/src/market-rules.js";
import { useSession } from "./wallets.js";
import {
  marketSchema,
  listingSchema,
  page,
  type Market,
} from "../../../offchain/app-core/src/catalog-contracts.js";
export {
  marketSchema,
  listingSchema,
  page,
  type Market,
  type Listing,
} from "../../../offchain/app-core/src/catalog-contracts.js";
export function useMarkets(status: string, search: string, owner?: Address) {
  const { api } = useSession();
  return useInfiniteQuery({
    queryKey: [api.key, "markets", status, search, owner ?? null],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const q = new URLSearchParams({ limit: "20" });
      if (status) q.set("status", status);
      if (search) q.set("q", search);
      if (owner) q.set("creator", owner);
      if (pageParam) q.set("cursor", pageParam);
      return api.request(`/v2/markets?${q}`, page(marketSchema), {
        service: "indexer",
        signal,
      });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 10000,
  });
}
export function useMarket(market: Address) {
  const { api } = useSession();
  return useQuery({
    queryKey: [api.key, "market", market],
    queryFn: ({ signal }) =>
      api.request(`/v2/markets/${market}`, marketSchema, {
        service: "indexer",
        signal,
      }),
    staleTime: 10000,
  });
}
export function useRules(market: Market | undefined) {
  const { api } = useSession();
  return useQuery({
    queryKey: [api.key, "rules", market?.rulesHash, market?.updatedBlock],
    enabled: !!market?.rulesHash,
    queryFn: async ({ signal }) => {
      if (!market?.rulesHash) throw new AppError("rules_unverified");
      const rules = await api.request(
        `/v1/markets/${market.rulesHash}/rules.json`,
        marketRulesSchema,
        { service: "metadata", signal },
      );
      const b = (n: string | null) => (n === null ? null : BigInt(n));
      if (
        encodeMarketRules(rules).rulesHash.toLowerCase() !==
          market.rulesHash.toLowerCase() ||
        !marketRulesMatchTimes(rules, {
          closeAt: b(market.closeAt),
          eventStartsAt: b(market.eventStartsAt),
          outcomeDeadlineAt: b(market.outcomeDeadlineAt),
          resolutionDeadlineAt:
            market.outcomeDeadlineAt && market.resolutionWindow
              ? BigInt(market.outcomeDeadlineAt) +
                BigInt(market.resolutionWindow)
              : null,
        })
      )
        throw new AppError("rules_unverified", 409);
      return rules;
    },
    retry: 1,
    staleTime: 60000,
  });
}
export function useListings(market?: Address) {
  const { api } = useSession();
  return useInfiniteQuery({
    queryKey: [api.key, "listings", market ?? null],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => {
      const q = new URLSearchParams({ limit: "30" });
      if (market) q.set("vault", market);
      if (pageParam) q.set("cursor", pageParam);
      return api.request(`/v1/listings?${q}`, page(listingSchema), {
        service: "indexer",
        signal,
      });
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15000,
  });
}
export function useBalance() {
  const { api, account } = useSession();
  return useQuery({
    queryKey: [api.key, "balance", account?.address],
    enabled: !!account,
    queryFn: async () =>
      api.publicClient().readContract({
        address: api.environment.deployment.paymentToken,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account!.address],
      }),
    refetchInterval: 15000,
  });
}
export const marketReadAbi = parseAbi([
  "function economics() view returns ((uint16 creatorRakeBps,uint16 protocolShareBps,uint16 earlyBirdShareBps,uint16 platformC2CFeeBps,uint16 creatorC2CFeeBps,address protocolTreasury))",
  "function marketState() view returns(uint8)",
  "function voidReason() view returns(uint8)",
  "function winningOutcome() view returns(uint8)",
  "function closeAt() view returns(uint64)",
  "function resolutionDeadline() view returns(uint256)",
  "function balanceOf(address,uint256) view returns(uint256)",
  "function minimumPrimaryUnits() view returns(uint128)",
  "function minimumC2CUnits() view returns(uint128)",
  "function perUserPrimaryCap() view returns(uint128)",
  "function marketPrimaryCap() view returns(uint128)",
  "function totalPrincipal() view returns(uint256)",
  "function principalByOutcome(uint256) view returns(uint256)",
]);
export function useMarketLive(market: Address) {
  const { api, account } = useSession();
  return useQuery({
    queryKey: [api.key, "market-live", market, account?.address],
    queryFn: async () => {
      const client = api.publicClient(),
        block = await client.getBlock(),
        base = {
          address: market,
          abi: marketReadAbi,
          blockNumber: block.number,
        };
      const [
        economics,
        state,
        voidReason,
        winningOutcome,
        closeAt,
        resolutionDeadline,
        minimumPrimary,
        minimumC2C,
        principal,
      ] = await Promise.all([
        client.readContract({ ...base, functionName: "economics" }),
        client.readContract({ ...base, functionName: "marketState" }),
        client.readContract({ ...base, functionName: "voidReason" }),
        client.readContract({ ...base, functionName: "winningOutcome" }),
        client.readContract({ ...base, functionName: "closeAt" }),
        client.readContract({ ...base, functionName: "resolutionDeadline" }),
        client.readContract({ ...base, functionName: "minimumPrimaryUnits" }),
        client.readContract({ ...base, functionName: "minimumC2CUnits" }),
        client.readContract({ ...base, functionName: "totalPrincipal" }),
      ]);
      return {
        economics,
        state,
        voidReason,
        winningOutcome,
        closeAt,
        resolutionDeadline,
        minimumPrimary,
        minimumC2C,
        principal,
        now: block.timestamp,
      };
    },
    refetchInterval: 15000,
    staleTime: 5000,
  });
}
export function marketStatusCopy(m: Market) {
  if (m.state === 1) return "已结算";
  if (m.state === 2) return "已作废";
  if (m.closeAt && BigInt(m.closeAt) <= BigInt(Math.floor(Date.now() / 1000)))
    return "已封盘 · 待结算";
  return "进行中";
}
export function dateText(value: string | null | undefined) {
  if (!value) return "未提供";
  const milliseconds = Number(BigInt(value) * 1000n);
  return Number.isSafeInteger(milliseconds)
    ? new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Shanghai",
      }).format(milliseconds)
    : "时间超出显示范围";
}
