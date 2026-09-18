import { formatUnits, parseAbi, type Address, type PublicClient } from "viem";
import { AppError } from "../../../offchain/app-core/src/contracts.js";

const capacityAbi = parseAbi([
  "function perUserPrimaryCap() view returns(uint128)",
  "function marketPrimaryCap() view returns(uint128)",
  "function totalPrincipal() view returns(uint256)",
  "function cumulativePrimaryBought(address) view returns(uint256)",
  "function minimumPrimaryUnits() view returns(uint128)",
]);
export type PrimaryCapacity = {
  perUserCap: bigint;
  marketCap: bigint;
  principal: bigint;
  cumulativeBought: bigint | null;
  minimumPrimary: bigint;
};
export class PrimaryPurchaseError extends AppError {}

export async function readPrimaryCapacity(
  client: PublicClient,
  market: Address,
  buyer?: Address,
  blockNumber?: bigint,
): Promise<PrimaryCapacity> {
  const number = blockNumber ?? (await client.getBlock()).number;
  const base = { address: market, abi: capacityAbi, blockNumber: number };
  const [perUserCap, marketCap, principal, cumulativeBought, minimumPrimary] =
    await Promise.all([
      client.readContract({ ...base, functionName: "perUserPrimaryCap" }),
      client.readContract({ ...base, functionName: "marketPrimaryCap" }),
      client.readContract({ ...base, functionName: "totalPrincipal" }),
      buyer
        ? client.readContract({
            ...base,
            functionName: "cumulativePrimaryBought",
            args: [buyer],
          })
        : Promise.resolve(null),
      client.readContract({ ...base, functionName: "minimumPrimaryUnits" }),
    ]);
  return { perUserCap, marketCap, principal, cumulativeBought, minimumPrimary };
}

const remaining = (cap: bigint, used: bigint) => (cap > used ? cap - used : 0n);
export function primaryAvailability(capacity: PrimaryCapacity) {
  return {
    market: remaining(capacity.marketCap, capacity.principal),
    account:
      capacity.cumulativeBought === null
        ? null
        : remaining(capacity.perUserCap, capacity.cumulativeBought),
  };
}

/** Match the vault's actual fill/minimum rules; a lower explicit minimum permits partial fills. */
export function checkPrimaryPurchase(
  capacity: PrimaryCapacity,
  units: bigint,
  minUnits: bigint,
  asset: string,
): { filled: bigint; error: PrimaryPurchaseError | null } {
  const available = primaryAvailability(capacity);
  const amount = (n: bigint) => `${formatUnits(n, 6)} ${asset}`;
  const failure = (code: string, message: string) => ({
    filled: 0n,
    error: new PrimaryPurchaseError(code, 409, message),
  });
  if (available.market === 0n)
    return failure(
      "primary_market_full",
      `市场投入上限已满（上限 ${amount(capacity.marketCap)}），无法继续一级购买。`,
    );
  if (available.account === 0n)
    return failure(
      "primary_account_full",
      `已达到每账户一级投入上限 ${amount(capacity.perUserCap)}。卖出份额不会恢复一级投入额度。`,
    );
  const required =
    minUnits > capacity.minimumPrimary ? minUnits : capacity.minimumPrimary;
  if (available.account !== null && available.account < required)
    return failure(
      "primary_account_cap",
      `已超出每账户一级投入上限 ${amount(capacity.perUserCap)}；你已累计投入 ${amount(capacity.cumulativeBought!)}，还可投入 ${amount(available.account)}。请调整投入数量或最少获得份额。`,
    );
  if (available.market < required)
    return failure(
      "primary_market_cap",
      `市场剩余投入额度为 ${amount(available.market)}（总上限 ${amount(capacity.marketCap)}），不足本次最低成交要求。请调整投入数量或最少获得份额。`,
    );
  const filled = [units, available.market, available.account ?? units].reduce(
    (a, b) => (a < b ? a : b),
  );
  if (filled < required)
    return failure(
      "primary_minimum_not_met",
      `本次可成交 ${amount(filled)}，未达到最低成交要求 ${amount(required)}。`,
    );
  return { filled, error: null };
}

/** A cheaper primary route is only actionable when known market limits permit a minimum fill. */
export function primaryAlternativeBlockedReason(
  capacity: PrimaryCapacity | null,
  open: boolean,
  verified: boolean,
  newExposure: boolean,
): string | null {
  if (!newExposure) return "当前暂停新增资金操作。";
  if (!verified) return "市场规则尚未核验，暂不能一级购买。";
  if (!capacity) return "一级购买状态暂未核实，请稍后重试。";
  if (!open) return "一级购买已封盘或市场已终局。";
  const available = primaryAvailability(capacity);
  if (available.market === 0n) return "市场一级投入额度已满。";
  if (available.account === 0n)
    return "你的一级投入额度已满，卖出份额不会恢复额度。";
  const minimum = capacity.minimumPrimary > 0n ? capacity.minimumPrimary : 1n;
  if (
    available.market < minimum ||
    (available.account !== null && available.account < minimum)
  )
    return "一级剩余额度不足最低购买份数。";
  return null;
}
