import { Children, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CpredictClient, TransactionResult } from "../../../offchain/sdk/src/index.js";
import type { MarketplaceListingSelection } from "../../react/src/MarketplacePanel.js";
import { MarketplacePage } from "../src/App.js";
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

describe("C2C listing selection flow", () => {
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
        paymentTokenSymbol="ctUSD"
        indexerEnabled={false}
        indexerBasePath="/indexer"
        chainId={421614}
        selectedListing={listing as MarketplaceListingSelection}
        refreshVersion={0}
        onSelectListing={() => {}}
        onListingChange={(
          _next: MarketplaceListingSelection | null,
          _result: TransactionResult,
        ) => {}}
      />,
    );
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
});
