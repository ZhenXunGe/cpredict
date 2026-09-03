import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PositionsPage } from "../src/App.js";
import {
  WalletPositionsView,
  indexerCaughtUp,
  isActiveHolding,
  mergeWalletPositions,
  type WalletPositionsState,
} from "../src/WalletIndexerPanels.js";
import type { IndexedPosition } from "../src/indexer-client.js";
import type { AccountSnapshot, MarketSnapshot } from "../src/protocol.js";
import type { ConnectedWallet } from "../src/wallet.js";

const OWNER = "0x000000000000000000000000000000000000c001";
const MARKET = "0x0000000000000000000000000000000000001001";

describe("positions page synchronization", () => {
  it("shows the current market chain balance in all positions while the indexer catches up", () => {
    const html = renderToStaticMarkup(
      <PositionsPage
        market={market()}
        account={account([2_000_000n, 0n])}
        wallet={{ address: OWNER } as unknown as ConnectedWallet}
        indexerEnabled
        indexerBasePath="/indexer"
        chainId={421614}
        targetBlock={304_503_618n}
        onOpenMarket={() => {}}
      />,
    );
    expect(html).toContain("持仓目录同步中");
    expect(html).toContain("链上已确认 · 目录同步中");
    expect(html).toContain(">2 份<");
    expect(html).not.toContain("暂无非零持仓");
  });

  it("does not convert an empty result into an empty position until sync is proven", () => {
    const behind = renderPositions(
      {
        identity: "wallet",
        items: [],
        syncStatus: {
          chainId: 421614,
          indexedBlock: 304_503_617n,
          safeBlock: 304_503_618n,
        },
        error: "",
      },
      304_503_618n,
    );
    expect(behind).toContain("持仓目录同步中");
    expect(behind).not.toContain("暂无非零持仓");

    const caughtUp = renderPositions(
      {
        identity: "wallet",
        items: [],
        syncStatus: {
          chainId: 421614,
          indexedBlock: 304_503_618n,
          safeBlock: 304_503_618n,
        },
        error: "",
      },
      304_503_618n,
    );
    expect(caughtUp).toContain("暂无非零持仓");
    expect(caughtUp).toContain("索引服务已同步到当前安全区块");
  });

  it("uses the receipt block as an additional synchronization target", () => {
    const status = {
      chainId: 421614,
      indexedBlock: 304_503_618n,
      safeBlock: 304_503_618n,
    };
    expect(indexerCaughtUp(status, 304_503_619n)).toBe(false);
    expect(
      indexerCaughtUp({ ...status, indexedBlock: 304_503_619n }, 304_503_619n),
    ).toBe(true);
  });

  it("hides resolved losing shares from holdings while keeping the unclaimed winner", () => {
    const html = renderToStaticMarkup(
      <PositionsPage
        market={market({ marketState: 1, winningOutcome: 0 })}
        account={account([2_000_000n, 5_000_000n])}
        wallet={{ address: OWNER } as unknown as ConnectedWallet}
        indexerEnabled
        indexerBasePath="/indexer"
        chainId={421614}
        targetBlock={304_503_618n}
        onOpenMarket={() => {}}
      />,
    );
    expect(html).toContain(">2 份<");
    expect(html).not.toContain(">5 份<");
    expect(html).toContain("结果 1");
    expect(html).not.toContain("结果 2");
  });

  it("keeps voided shares visible until they are refunded", () => {
    const html = renderToStaticMarkup(
      <PositionsPage
        market={market({ marketState: 2, winningOutcome: 0 })}
        account={account([2_000_000n, 5_000_000n])}
        wallet={{ address: OWNER } as unknown as ConnectedWallet}
        indexerEnabled
        indexerBasePath="/indexer"
        chainId={421614}
        targetBlock={304_503_618n}
        onOpenMarket={() => {}}
      />,
    );
    expect(html).toContain(">2 份<");
    expect(html).toContain(">5 份<");
    expect(html).toContain("结果 2");
  });
});

describe("active holdings", () => {
  it("treats resolved losing outcomes as inactive once the winner is known", () => {
    expect(
      isActiveHolding({
        balance: 5_000_000n,
        outcomeId: 1,
        marketState: 1,
        winningOutcome: 0,
      }),
    ).toBe(false);
    expect(
      isActiveHolding({
        balance: 2_000_000n,
        outcomeId: 0,
        marketState: 1,
        winningOutcome: 0,
      }),
    ).toBe(true);
    expect(
      isActiveHolding({
        balance: 5_000_000n,
        outcomeId: 1,
        marketState: 2,
        winningOutcome: 0,
      }),
    ).toBe(true);
  });

  it("drops resolved losing indexer balances after overlaying the live market", () => {
    const items = mergeWalletPositions(
      [
        indexedPosition({ outcomeId: 0n, balance: 2_000_000n }),
        indexedPosition({
          outcomeId: 1n,
          balance: 5_000_000n,
          marketState: 1,
          winningOutcome: 0n,
        }),
      ],
      [
        {
          vault: MARKET,
          outcomeId: 0n,
          balance: 2_000_000n,
          marketState: 1,
          winningOutcome: 0n,
        },
        {
          vault: MARKET,
          outcomeId: 1n,
          balance: 5_000_000n,
          marketState: 1,
          winningOutcome: 0n,
        },
      ],
    );
    expect(items).toEqual([
      expect.objectContaining({ outcomeId: 0n, balance: 2_000_000n }),
    ]);
  });

  it("hides resolved losing indexer positions without a live overlay", () => {
    expect(
      mergeWalletPositions(
        [
          indexedPosition({
            outcomeId: 1n,
            balance: 5_000_000n,
            marketState: 1,
            winningOutcome: 0n,
          }),
        ],
        [],
      ),
    ).toEqual([]);
  });
});

function renderPositions(
  state: WalletPositionsState,
  targetBlock: bigint,
): string {
  return renderToStaticMarkup(
    <WalletPositionsView
      enabled
      wallet={OWNER}
      livePositions={[]}
      targetBlock={targetBlock}
      state={state}
      onOpenMarket={() => {}}
    />,
  );
}

function account(positions: bigint[]): AccountSnapshot {
  return {
    usdcBalance: 0n,
    factoryAllowance: 0n,
    vaultAllowance: 0n,
    marketplaceAllowance: 0n,
    permit2Allowance: 0n,
    marketplaceApproved: false,
    positions: positions.map((balance, outcomeId) => ({ outcomeId, balance })),
    cumulativePrimaryBought: 0n,
    earlyBirdScore: 0n,
  };
}

function indexedPosition(
  overrides: Partial<IndexedPosition> = {},
): IndexedPosition {
  return {
    vault: MARKET,
    owner: OWNER,
    outcomeId: 0n,
    balance: 1n,
    updatedBlock: 1n,
    confirmationStatus: "confirmed",
    marketState: 0,
    winningOutcome: null,
    ...overrides,
  };
}

function market(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    address: MARKET,
    observedAt: 1_900_000_000n,
    creator: OWNER,
    creatorTreasury: OWNER,
    rulesHash: `0x${"11".repeat(32)}`,
    outcomeCount: 2,
    createdAt: 1_899_999_000n,
    closeAt: 1_900_001_000n,
    earlyBirdStart: 1_899_999_500n,
    featureFlags: 0n,
    perUserPrimaryCap: 10_000_000n,
    marketPrimaryCap: 20_000_000n,
    minimumPrimaryUnits: 1_000_000n,
    minimumC2CUnits: 1_000_000n,
    creatorBond: 10_000_000n,
    marketState: 0,
    winningOutcome: 0,
    totalPrincipal: 2_000_000n,
    resolutionDeadline: 1_900_001_900n,
    permit2Enabled: true,
    earlyBirdEnabled: false,
    ...overrides,
  };
}
