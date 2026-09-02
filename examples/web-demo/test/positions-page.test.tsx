import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PositionsPage } from "../src/App.js";
import {
  WalletPositionsView,
  indexerCaughtUp,
  type WalletPositionsState,
} from "../src/WalletIndexerPanels.js";
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
    const behind = renderPositions({
      identity: "wallet",
      items: [],
      syncStatus: {
        chainId: 421614,
        indexedBlock: 304_503_617n,
        safeBlock: 304_503_618n,
      },
      error: "",
    }, 304_503_618n);
    expect(behind).toContain("持仓目录同步中");
    expect(behind).not.toContain("暂无非零持仓");

    const caughtUp = renderPositions({
      identity: "wallet",
      items: [],
      syncStatus: {
        chainId: 421614,
        indexedBlock: 304_503_618n,
        safeBlock: 304_503_618n,
      },
      error: "",
    }, 304_503_618n);
    expect(caughtUp).toContain("暂无非零持仓");
    expect(caughtUp).toContain("Indexer 已同步到当前安全区块");
  });

  it("uses the receipt block as an additional synchronization target", () => {
    const status = {
      chainId: 421614,
      indexedBlock: 304_503_618n,
      safeBlock: 304_503_618n,
    };
    expect(indexerCaughtUp(status, 304_503_619n)).toBe(false);
    expect(indexerCaughtUp({ ...status, indexedBlock: 304_503_619n }, 304_503_619n)).toBe(true);
  });
});

function renderPositions(state: WalletPositionsState, targetBlock: bigint): string {
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
    positions,
    cumulativePrimaryBought: 0n,
    earlyBirdScore: 0n,
  };
}

function market(): MarketSnapshot {
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
  };
}
