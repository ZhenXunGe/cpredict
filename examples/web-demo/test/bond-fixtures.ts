import {
  encodeAbiParameters,
  encodeEventTopics,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import {
  BondSubmissionUnknownError,
  type TransactionResult,
} from "../../../offchain/sdk/src/client.js";
import { creatorBondAbi, type BondAction } from "../src/creator-bond.js";
import type { MarketSnapshot } from "../src/protocol.js";

export const BOND_ESCROW = "0x000000000000000000000000000000000000e001";

interface BondFixtureState {
  market: MarketSnapshot;
  chainId: number;
  settled: boolean;
  credit: bigint;
  block: bigint;
  readError: boolean;
  receiptPending: boolean;
  reject: boolean;
  revert: boolean;
  failRefresh: boolean;
  submissionUnknown: boolean;
  amountAddedBeforeClaim: bigint;
  delayRead: (() => Promise<void>) | null;
}
interface BondFixture {
  state: BondFixtureState;
  rpc: PublicClient;
  receipts: Map<Hex, TransactionReceipt>;
  submit: (
    action: BondAction,
    caller: Hex,
    onSubmitted?: (hash: Hex) => void,
  ) => Promise<TransactionResult>;
}

/** Controlled RPC/receipt facts, never a real provider. Shared by unit and rendered-page tests. */
export function createBondFixture(market: MarketSnapshot): BondFixture {
  const state: BondFixtureState = {
    market: { ...market },
    chainId: 421614,
    settled: false,
    credit: 0n,
    block: 100n,
    readError: false,
    receiptPending: false,
    reject: false,
    revert: false,
    failRefresh: false,
    submissionUnknown: false,
    amountAddedBeforeClaim: 0n,
    delayRead: null as (() => Promise<void>) | null,
  };
  let sequence = 0;
  const receipts = new Map<Hex, TransactionReceipt>();
  const fields = () => ({
    bondOf: [state.market.creator, state.market.creatorBond, state.settled],
    creditOf: state.credit,
    creator: state.market.creator,
    bondEscrow: BOND_ESCROW,
    creatorBond: state.market.creatorBond,
    marketState: state.market.marketState,
    voidReason: state.market.voidReason,
    totalPrincipal: state.market.totalPrincipal,
  });
  const rpc = {
    getChainId: async () => state.chainId,
    getBlock: async () => ({
      number: state.block,
      timestamp: state.market.observedAt,
    }),
    multicall: async ({
      contracts,
    }: {
      contracts: Array<{ functionName: keyof ReturnType<typeof fields> }>;
    }) => {
      const captured = fields();
      await state.delayRead?.();
      if (state.readError) throw new Error("测试 RPC 暂不可用");
      return contracts.map(({ functionName }) => captured[functionName]);
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (state.receiptPending || !receipts.has(hash))
        throw new Error("transaction receipt not found");
      return receipts.get(hash)!;
    },
  } as unknown as PublicClient;

  async function submit(
    action: BondAction,
    caller: Hex,
    onSubmitted?: (hash: Hex) => void,
  ): Promise<TransactionResult> {
    if (state.reject)
      throw Object.assign(new Error("用户拒绝签名"), { code: 4001 });
    const hash = `0x${(++sequence).toString(16).padStart(64, "0")}` as Hex;
    if (!state.submissionUnknown) onSubmitted?.(hash);
    state.block += 1n;
    let amount = 0n;
    const timeout =
      state.market.marketState === 2 &&
      state.market.voidReason === 3 &&
      state.market.totalPrincipal > 0n;
    if (!state.revert) {
      if (action === "release") {
        amount = state.market.creatorBond;
        state.settled = true;
        if (!timeout) state.credit += amount;
      } else {
        amount = state.credit + state.amountAddedBeforeClaim;
        state.credit = 0n;
      }
    }
    const topics =
      action === "claim"
        ? encodeEventTopics({
            abi: creatorBondAbi,
            eventName: "BondClaimed",
            args: { creator: state.market.creator, caller },
          })
        : timeout
          ? encodeEventTopics({
              abi: creatorBondAbi,
              eventName: "BondFundedToTimeoutMarket",
              args: { market: state.market.address },
            })
          : encodeEventTopics({
              abi: creatorBondAbi,
              eventName: "BondCredited",
              args: {
                market: state.market.address,
                creator: state.market.creator,
              },
            });
    const receipt = {
      to: BOND_ESCROW,
      from: caller,
      status: state.revert ? "reverted" : "success",
      blockNumber: state.block,
      logs: state.revert
        ? []
        : [
            {
              address: BOND_ESCROW,
              topics,
              data: encodeAbiParameters([{ type: "uint256" }], [amount]),
            },
          ],
    } as unknown as TransactionReceipt;
    receipts.set(hash, receipt);
    if (state.failRefresh) state.readError = true;
    if (state.submissionUnknown)
      throw new BondSubmissionUnknownError(new Error("wallet response lost"));
    if (state.receiptPending) throw new Error("receipt pending");
    if (state.revert) throw new Error("transaction reverted");
    return { hash, blockNumber: state.block, gasUsed: 1n };
  }
  return { state, rpc, submit, receipts };
}
