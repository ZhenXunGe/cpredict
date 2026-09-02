import { Children, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CpredictClient, TransactionResult } from "../../../offchain/sdk/src/index.js";
import type { MarketplaceListingSelection } from "../../react/src/MarketplacePanel.js";
import { MarketplacePage } from "../src/App.js";
import { MarketCatalogSelect, type CatalogEntry } from "../src/MarketCatalog.js";
import { ListingCard } from "../src/WalletIndexerPanels.js";
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
      label: "C2C Market Vault",
      onOpen,
    });
    const html = renderToStaticMarkup(catalog);
    expect(html).toContain("C2C Market Vault");
    expect(html).toContain("这把游戏能胜利吗");

    const select = Children.toArray(catalog.props.children).find(
      (child): child is ReactElement<{ onChange: (event: { currentTarget: { value: string } }) => void }> =>
        isValidElement(child) && child.type === "select",
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
        market={{ address: VAULT } as unknown as MarketSnapshot}
        account={{
          marketplaceAllowance: 0n,
          marketplaceApproved: true,
        } as AccountSnapshot}
        trust={{
          addresses: {
            usdc: "0x0000000000000000000000000000000000004001",
            contracts: { marketplace: MARKETPLACE },
          },
        } as unknown as TrustReport}
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
    expect(html).toContain("当前 runtime 未开放 Indexer，暂时无法从 C2C 页面选择市场。");
    const selectedSection = html.slice(html.indexOf("Selected listing"));
    expect(selectedSection).toContain(LISTING_ID);
    expect(selectedSection).toContain("Fixed price");
    expect(selectedSection).toContain("0.9 ctUSD");
    expect(selectedSection).toContain("Remaining");
    expect(selectedSection).toContain("2 shares");
    expect(selectedSection).toContain("Total: 1.8 ctUSD");
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
});
