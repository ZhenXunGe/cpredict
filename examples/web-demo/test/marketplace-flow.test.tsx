import { Children, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  CpredictClient,
  TransactionResult,
} from "../../../offchain/sdk/src/index.js";
import type { MarketplaceListingSelection } from "../../react/src/MarketplacePanel.js";
import { MarketplacePage } from "../src/App.js";
import {
  MarketCatalogSelect,
  type CatalogEntry,
} from "../src/MarketCatalog.js";
import {
  ActiveListingsCatalog,
  ListingCard,
  ListingsPanel,
} from "../src/WalletIndexerPanels.js";
import type { IndexedListing } from "../src/indexer-client.js";
import type { AccountSnapshot, MarketSnapshot } from "../src/protocol.js";
import type { TrustReport } from "../src/trust.js";

const VAULT = "0x0000000000000000000000000000000000001001";
const MARKETPLACE = "0x0000000000000000000000000000000000002001";
const LISTING_ID = `0x${"ab".repeat(32)}` as const;
const listing: IndexedListing = {
  listingId: LISTING_ID,
  vault: VAULT,
  seller: "0x0000000000000000000000000000000000003001",
  outcomeId: 0n,
  remainingUnits: 2_000_000n,
  unitPrice: 900_000n,
  expiresAt: 1_900_000_000n,
  active: true,
  updatedBlock: 100n,
  confirmationStatus: "confirmed",
};
const catalogEntry: CatalogEntry = {
  market: {
    market: VAULT,
    creator: "0x0000000000000000000000000000000000003001",
    deploymentMode: 0,
    outcomeCount: 2,
    closeAt: 1_900_000_000n,
    resolutionWindow: 900n,
    rulesHash: `0x${"11".repeat(32)}`,
    marketPrimaryCap: 20_000_000n,
    primaryFilledUnits: 5_000_000n,
    creatorBond: 10_000_000n,
    status: "open",
    winningOutcome: null,
    createdBlock: 100n,
    confirmationStatus: "confirmed",
  },
  rules: {
    version: "cpredict-rules-v1",
    question: "这把游戏能胜利吗",
    outcomes: ["Yes", "No"],
    closesAt: 1_900_000_000,
    resolutionSource: "https://example.com/result",
    resolutionCriteria: "Use the final result published by the cited source.",
    cancellationPolicy: "Void if no unambiguous result is published in time.",
  },
};

describe("C2C listing selection flow", () => {
  it("offers a compact market selector and returns the selected Vault", () => {
    const onOpen = vi.fn();
    const catalog = MarketCatalogSelect({
      entries: [catalogEntry],
      selectedMarket: null,
      label: "C2C 市场金库",
      onOpen,
    });
    const html = renderToStaticMarkup(catalog);
    expect(html).toContain("C2C 市场金库");
    expect(html).toContain("这把游戏能胜利吗");

    const select = Children.toArray(catalog.props.children).find(
      (
        child,
      ): child is ReactElement<{
        onChange: (event: { currentTarget: { value: string } }) => void;
      }> => isValidElement(child) && child.type === "select",
    );
    expect(select).toBeDefined();
    select?.props.onChange({ currentTarget: { value: VAULT } });
    expect(onOpen).toHaveBeenCalledWith(VAULT, catalogEntry.rules);
  });

  it("passes the complete indexed listing from the card selection action", () => {
    const onSelect = vi.fn();
    const card = ListingCard({
      item: listing,
      paymentTokenSymbol: "ctUSD",
      selected: false,
      onSelect,
    });
    const button = Children.toArray(card.props.children).find(
      (child): child is ReactElement<{ onClick: () => void }> =>
        isValidElement(child) && child.type === "button",
    );
    expect(button).toBeDefined();
    button?.props.onClick();
    expect(onSelect).toHaveBeenCalledWith(listing);
  });

  it("renders the selected listing through the page owner with no manual ID or price input", () => {
    const html = renderToStaticMarkup(
      <MarketplacePage
        writeReady
        market={
          {
            address: VAULT,
            observedAt: 1_899_999_000n,
            closeAt: 1_900_000_000n,
          } as unknown as MarketSnapshot
        }
        account={
          {
            marketplaceAllowance: 0n,
            marketplaceApproved: true,
          } as AccountSnapshot
        }
        trust={
          {
            addresses: {
              usdc: "0x0000000000000000000000000000000000004001",
              contracts: { marketplace: MARKETPLACE },
            },
          } as unknown as TrustReport
        }
        client={{} as CpredictClient}
        selectedMarketAddress={VAULT}
        marketBusy={false}
        marketLoadError={null}
        wallet="0x0000000000000000000000000000000000005001"
        paymentTokenSymbol="ctUSD"
        indexerEnabled={false}
        indexerBasePath="/indexer"
        metadataBasePath="/metadata"
        chainId={421614}
        selectedListing={listing as MarketplaceListingSelection}
        refreshVersion={0}
        onSelectMarket={() => {}}
        onSelectListing={() => {}}
        onListingChange={(
          _next: MarketplaceListingSelection | null,
          _result: TransactionResult,
        ) => {}}
      />,
    );
    expect(html).toContain("选择 C2C 市场");
    expect(html).toContain(
      "当前运行配置未开放索引服务，暂时无法从 C2C 页面选择市场。",
    );
    const selectedSection = html.slice(html.indexOf("已选挂单"));
    expect(selectedSection).toContain(LISTING_ID);
    expect(selectedSection).toContain("固定价");
    expect(selectedSection).toContain("0.9 ctUSD");
    expect(selectedSection).toContain("剩余");
    expect(selectedSection).toContain("2 份");
    expect(selectedSection).toContain("合计：1.8 ctUSD");
    expect(selectedSection).not.toContain('<input value="0x');
    expect(selectedSection).not.toContain('value="0.9"');
  });

  it("keeps the selected Vault visible while its chain snapshot is loading", () => {
    const html = renderToStaticMarkup(
      <MarketplacePage
        writeReady={false}
        market={null}
        selectedMarketAddress={VAULT}
        marketBusy
        marketLoadError={null}
        account={null}
        trust={null}
        client={null}
        wallet={null}
        paymentTokenSymbol="ctUSD"
        indexerEnabled={false}
        indexerBasePath="/indexer"
        metadataBasePath="/metadata"
        chainId={421614}
        selectedListing={null}
        refreshVersion={0}
        onSelectMarket={() => {}}
        onSelectListing={() => {}}
        onListingChange={() => {}}
      />,
    );
    expect(html).toContain("正在读取 Vault 0x000000…001001");
    expect(html).toContain("正在读取市场");
    expect(html).not.toContain("先从上方选择市场");
  });

  it("asks for a Vault before listing C2C orders, then scopes the request to that Vault", () => {
    const empty = renderToStaticMarkup(
      <ListingsPanel
        enabled
        indexerBasePath="/indexer"
        chainId={421614}
        paymentTokenSymbol="ctUSD"
        selectedListingId={null}
        refreshVersion={0}
        vault={null}
        onSelectListing={() => {}}
      />,
    );
    expect(empty).toContain("先选择 C2C 市场");

    const scoped = renderToStaticMarkup(
      <MarketplacePage
        writeReady={false}
        market={null}
        selectedMarketAddress={VAULT}
        marketBusy
        marketLoadError={null}
        account={null}
        trust={null}
        client={null}
        wallet={null}
        paymentTokenSymbol="ctUSD"
        indexerEnabled
        indexerBasePath="/indexer"
        metadataBasePath="/metadata"
        chainId={421614}
        selectedListing={null}
        refreshVersion={0}
        targetBlock={12n}
        onSelectMarket={() => {}}
        onSelectListing={() => {}}
        onListingChange={() => {}}
      />,
    );
    expect(scoped).toContain("正在读取活跃挂单");
    expect(scoped).not.toContain("先选择 C2C 市场");
  });

  it("folds listings above the primary price before close and restores them at close", () => {
    const expensive = {
      ...listing,
      listingId: `0x${"cd".repeat(32)}` as const,
      unitPrice: 1_200_000n,
    };
    const atPrimaryPrice = {
      ...listing,
      listingId: `0x${"ef".repeat(32)}` as const,
      unitPrice: 1_000_000n,
    };
    const beforeClose = renderToStaticMarkup(
      <ActiveListingsCatalog
        items={[listing, atPrimaryPrice, expensive]}
        paymentTokenSymbol="ctUSD"
        selectedListingId={null}
        observedAt={1_899_999_999n}
        closeAt={1_900_000_000n}
        onSelectListing={() => {}}
      />,
    );
    expect(beforeClose).toContain("1 笔高价挂单已折叠");
    expect(beforeClose).toContain("池子直买更便宜");
    expect(beforeClose).toContain("0.9 ctUSD");
    expect(beforeClose).toContain("1 ctUSD");
    expect(beforeClose).not.toContain("1.2 ctUSD");

    const atClose = renderToStaticMarkup(
      <ActiveListingsCatalog
        items={[listing, atPrimaryPrice, expensive]}
        paymentTokenSymbol="ctUSD"
        selectedListingId={null}
        observedAt={1_900_000_000n}
        closeAt={1_900_000_000n}
        onSelectListing={() => {}}
      />,
    );
    expect(atClose).not.toContain("高价挂单已折叠");
    expect(atClose).toContain("0.9 ctUSD");
    expect(atClose).toContain("1 ctUSD");
    expect(atClose).toContain("1.2 ctUSD");
  });

  it("blocks a stale selected high-price listing from filling before close but keeps cancellation", () => {
    const html = renderToStaticMarkup(
      <MarketplacePage
        writeReady
        market={
          {
            address: VAULT,
            observedAt: 1_899_999_000n,
            closeAt: 1_900_000_000n,
          } as unknown as MarketSnapshot
        }
        account={
          {
            marketplaceAllowance: 0n,
            marketplaceApproved: true,
          } as AccountSnapshot
        }
        trust={
          {
            addresses: {
              usdc: "0x0000000000000000000000000000000000004001",
              contracts: { marketplace: MARKETPLACE },
            },
          } as unknown as TrustReport
        }
        client={{} as CpredictClient}
        selectedMarketAddress={VAULT}
        marketBusy={false}
        marketLoadError={null}
        wallet="0x0000000000000000000000000000000000005001"
        paymentTokenSymbol="ctUSD"
        indexerEnabled={false}
        indexerBasePath="/indexer"
        metadataBasePath="/metadata"
        chainId={421614}
        selectedListing={{ ...listing, unitPrice: 1_200_000n }}
        refreshVersion={0}
        onSelectMarket={() => {}}
        onSelectListing={() => {}}
        onListingChange={() => {}}
      />,
    );
    const selectedSection = html.slice(html.indexOf("已选挂单"));
    expect(selectedSection).toContain("该挂单已按封盘前规则折叠");
    expect(selectedSection).toContain("池子直买更便宜");
    expect(selectedSection).toContain(
      '<button disabled="" type="button">精确授权 ctUSD 用于成交</button>',
    );
    expect(selectedSection).toContain(
      '<button type="button">取消所选挂单</button>',
    );
  });
});
