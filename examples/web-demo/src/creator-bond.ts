import {
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { assertMarketState } from "../../../offchain/sdk/src/market-state.js";

// Read/event projection of the existing contracts; no new selector or funds path.
export const creatorBondAbi = parseAbi([
  "function bondOf(address market) view returns (address creator, uint128 amount, bool settled)",
  "function creditOf(address creator) view returns (uint256)",
  "function creator() view returns (address)",
  "function bondEscrow() view returns (address)",
  "function creatorBond() view returns (uint128)",
  "function marketState() view returns (uint8)",
  "function voidReason() view returns (uint8)",
  "function totalPrincipal() view returns (uint256)",
  "event BondClaimed(address indexed creator, address indexed caller, uint256 amount)",
  "event BondCredited(address indexed market, address indexed creator, uint256 amount)",
  "event BondFundedToTimeoutMarket(address indexed market, uint256 amount)",
]);

export interface CreatorBondIdentity {
  chainId: number;
  market: Address;
  creator: Address;
  escrow: Address;
  wallet: Address;
}

export interface CreatorBondSnapshot {
  blockNumber: bigint;
  amount: bigint;
  credit: bigint;
  settled: boolean;
  marketState: number;
  voidReason: number;
  totalPrincipal: bigint;
}

export type BondAction = "release" | "claim";
export interface BondSubmission {
  action: BondAction;
  hash: Hex | null;
  afterBlock: string;
}

export async function readCreatorBond(
  client: PublicClient,
  identity: CreatorBondIdentity,
  minimumBlock = 0n,
): Promise<CreatorBondSnapshot> {
  const [chainId, block] = await Promise.all([
    client.getChainId(),
    client.getBlock({ blockTag: "latest" }),
  ]);
  if (chainId !== identity.chainId)
    throw new Error("押金读取网络不匹配，请切回正确网络。");
  if (block.number < minimumBlock)
    throw new Error("RPC 尚未同步到操作所在区块，请稍后刷新；不要重复提交。");
  const { market, creator, escrow } = identity;
  const [
    bond,
    credit,
    vaultCreator,
    vaultEscrow,
    amount,
    marketState,
    voidReason,
    totalPrincipal,
  ] = await client.multicall({
    allowFailure: false,
    blockNumber: block.number,
    contracts: [
      {
        address: escrow,
        abi: creatorBondAbi,
        functionName: "bondOf",
        args: [market],
      },
      {
        address: escrow,
        abi: creatorBondAbi,
        functionName: "creditOf",
        args: [creator],
      },
      { address: market, abi: creatorBondAbi, functionName: "creator" },
      { address: market, abi: creatorBondAbi, functionName: "bondEscrow" },
      { address: market, abi: creatorBondAbi, functionName: "creatorBond" },
      { address: market, abi: creatorBondAbi, functionName: "marketState" },
      { address: market, abi: creatorBondAbi, functionName: "voidReason" },
      { address: market, abi: creatorBondAbi, functionName: "totalPrincipal" },
    ],
  });
  if (
    bond[0].toLowerCase() !== creator.toLowerCase() ||
    vaultCreator.toLowerCase() !== creator.toLowerCase() ||
    vaultEscrow.toLowerCase() !== escrow.toLowerCase() ||
    amount !== bond[1] ||
    amount <= 0n
  ) {
    throw new Error(
      "市场、creator 与押金托管记录不匹配，请核对部署和市场地址。",
    );
  }
  assertMarketState(marketState, voidReason);
  return {
    blockNumber: block.number,
    amount,
    credit,
    settled: bond[2],
    marketState,
    voidReason,
    totalPrincipal,
  };
}

export function bondDisposition(snapshot: CreatorBondSnapshot) {
  if (snapshot.marketState === 0) return "locked";
  if (
    snapshot.marketState === 2 &&
    snapshot.voidReason === 3 &&
    snapshot.totalPrincipal > 0n
  ) {
    return snapshot.settled ? "timeout-funded" : "timeout-pending";
  }
  return snapshot.settled ? "credited" : "return-pending";
}

export async function readBondReceipt(
  client: PublicClient,
  identity: CreatorBondIdentity,
  submission: BondSubmission,
) {
  if (submission.hash === null) throw new Error("请先从钱包取得原交易哈希。");
  if ((await client.getChainId()) !== identity.chainId)
    throw new Error("回执读取网络不匹配。");
  const receipt = await client.getTransactionReceipt({ hash: submission.hash });
  if (receipt.blockNumber < BigInt(submission.afterBlock))
    throw new Error("该回执早于本次操作，请核对原交易哈希。");
  if (receipt.to?.toLowerCase() !== identity.escrow.toLowerCase())
    throw new Error("回执目标不是当前押金托管合约。");
  if (receipt.from.toLowerCase() !== identity.wallet.toLowerCase())
    throw new Error("回执发送者与原操作钱包不匹配。");
  if (receipt.status === "reverted")
    return { status: "reverted", blockNumber: receipt.blockNumber } as const;
  const events = parseEventLogs({
    abi: creatorBondAbi,
    logs: receipt.logs.filter(
      (log) => log.address.toLowerCase() === identity.escrow.toLowerCase(),
    ),
    strict: true,
  });
  if (submission.action === "claim") {
    const event = events.find(
      (event) =>
        event.eventName === "BondClaimed" &&
        event.args.creator.toLowerCase() === identity.creator.toLowerCase() &&
        event.args.caller.toLowerCase() === identity.wallet.toLowerCase(),
    );
    if (event?.eventName !== "BondClaimed" || event.args.amount <= 0n)
      throw new Error("交易成功，但尚未核对到对应的押金领取事件。");
    return {
      status: "claimed",
      amount: event.args.amount,
      blockNumber: receipt.blockNumber,
    } as const;
  }
  const event = events.find(
    (event) =>
      (event.eventName === "BondCredited" ||
        event.eventName === "BondFundedToTimeoutMarket") &&
      event.args.market.toLowerCase() === identity.market.toLowerCase() &&
      (event.eventName !== "BondCredited" ||
        event.args.creator.toLowerCase() === identity.creator.toLowerCase()),
  );
  if (event === undefined || event.eventName === "BondClaimed")
    throw new Error("交易成功，但尚未核对到该市场的押金处理事件。");
  return {
    status: event.eventName === "BondCredited" ? "released" : "funded",
    amount: event.args.amount,
    blockNumber: receipt.blockNumber,
  } as const;
}

export function bondStorageKey(identity: CreatorBondIdentity) {
  return `cpredict:bond-pending:v1:${identity.chainId}:${identity.wallet}:${identity.escrow}:${identity.market}:${identity.creator}`.toLowerCase();
}

export function parseBondSubmission(raw: string | null): BondSubmission | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (
    typeof value !== "object" ||
    value === null ||
    !("action" in value) ||
    !("hash" in value) ||
    Object.keys(value).length !== 3 ||
    (value.action !== "release" && value.action !== "claim") ||
    (value.hash !== null &&
      (typeof value.hash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(value.hash))) ||
    !("afterBlock" in value) ||
    typeof value.afterBlock !== "string" ||
    !/^\d{1,32}$/.test(value.afterBlock)
  ) {
    throw new Error("本页押金操作记录无法读取，请先核对原交易，不要重复提交。");
  }
  return {
    action: value.action,
    hash: value.hash as Hex | null,
    afterBlock: value.afterBlock,
  };
}
