import { getAddress, type Address } from "viem";
import type { CreateMarketResult } from "../../../offchain/sdk/src/index.js";

export interface MarketCreationActions {
  selectMarket: (market: Address) => void;
  navigateToMarket: () => void;
  recordMarketVault: (market: Address, hash: `0x${string}`) => void;
  loadMarket: (market: Address) => Promise<void>;
}

export async function completeMarketCreation(
  result: CreateMarketResult,
  actions: MarketCreationActions,
): Promise<Address> {
  const market = getAddress(result.market);
  actions.selectMarket(market);
  actions.navigateToMarket();
  actions.recordMarketVault(market, result.hash);
  await actions.loadMarket(market);
  return market;
}
