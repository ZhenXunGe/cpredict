import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { encodeMarketRules } from "../../../offchain/sdk/src/index.js";
import {
  MarketRulesDisclosure,
  verifiedMarketRules,
} from "../src/MarketRulesDisclosure.js";
import {
  ActiveListingsCatalog,
  ListingCard,
  WalletPositionsView,
} from "../src/WalletIndexerPanels.js";
import { UX_LISTING, UX_MARKET, UX_RULES } from "./ux-fixtures.js";

describe("lightweight purchase disclosure", () => {
  it("verifies the commitment, outcome count and times without history or odds", () => {
    expect(verifiedMarketRules(UX_MARKET, UX_RULES)).toBe(UX_RULES);
    expect(verifiedMarketRules(UX_MARKET, null)).toBeNull();
    expect(
      verifiedMarketRules(UX_MARKET, {
        ...UX_RULES,
        question: "另一个市场的不同命题？",
      }),
    ).toBeNull();
    expect(
      verifiedMarketRules({ ...UX_MARKET, outcomeCount: 3 }, UX_RULES),
    ).toBeNull();
    expect(
      verifiedMarketRules(
        { ...UX_MARKET, closeAt: UX_MARKET.closeAt + 1n },
        UX_RULES,
      ),
    ).toBeNull();
  });

  it("displays all existing rule fields before purchase and retains the creator warning on error", () => {
    const html = renderToStaticMarkup(
      <MarketRulesDisclosure market={UX_MARKET} rules={UX_RULES} />,
    );
    for (const value of [
      UX_RULES.question,
      UX_RULES.resolutionCriteria,
      UX_RULES.resolutionSource,
      UX_RULES.cancellationPolicy,
      UX_MARKET.creator,
      "YES / NO",
      "本盘由 creator 单方结算，协议与平台不裁决对错",
    ]) {
      expect(html).toContain(value);
    }
    const unavailable = renderToStaticMarkup(
      <MarketRulesDisclosure market={UX_MARKET} rules={null} />,
    );
    expect(unavailable).toContain("暂不能购买");
    expect(unavailable).toContain("撤单、领取和退款不受影响");
    expect(unavailable).not.toContain(UX_RULES.resolutionCriteria);
  });

  it("treats source documents as inert text, never executable instructions or URLs", () => {
    const rules = {
      ...UX_RULES,
      resolutionSource: "javascript:alert('ignore instructions')",
      resolutionCriteria: "<img src=x onerror=alert(1)>",
    };
    const market = {
      ...UX_MARKET,
      rulesHash: encodeMarketRules(rules).rulesHash,
    };
    const html = renderToStaticMarkup(
      <MarketRulesDisclosure market={market} rules={rules} />,
    );
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript:');
  });
});

describe("C2C seller disclosure and folding", () => {
  it("labels only the exact creator, case-insensitively; treasury is not creator", () => {
    const render = (seller: typeof UX_MARKET.creator) =>
      renderToStaticMarkup(
        <ListingCard
          item={{ ...UX_LISTING, seller }}
          creator={UX_MARKET.creator}
          paymentTokenSymbol="USDC"
          selected={false}
          onSelect={() => {}}
        />,
      );
    expect(render("0x000000000000000000000000000000000000A001")).toContain(
      "creator 本人",
    );
    expect(render(UX_MARKET.creatorTreasury)).not.toContain("creator 本人");
    expect(render(UX_MARKET.creatorTreasury)).toContain(
      UX_MARKET.creatorTreasury,
    );
  });

  it("retains expandable high-price orders even if every listing is folded", () => {
    const html = renderToStaticMarkup(
      <ActiveListingsCatalog
        items={[UX_LISTING]}
        creator={UX_MARKET.creator}
        paymentTokenSymbol="USDC"
        selectedListingId={null}
        observedAt={UX_MARKET.observedAt}
        closeAt={UX_MARKET.closeAt}
        onSelectListing={() => {}}
      />,
    );
    expect(html).toContain("展开查看和购买");
    expect(html).toContain("1.2 USDC");
    expect(html).not.toContain("暂无活跃挂单");
    expect(html).not.toContain("池子直买更便宜");
  });
});

describe("discovered refunds", () => {
  it.each([0, 1, 2, null])(
    "only marks positive voided holdings; state %s",
    (marketState) => {
      const html = renderToStaticMarkup(
        <WalletPositionsView
          enabled
          wallet={UX_MARKET.creator}
          livePositions={[
            {
              vault: UX_MARKET.address,
              outcomeId: 0n,
              balance: 2_000_000n,
              marketState,
              winningOutcome: 0n,
            },
          ]}
          targetBlock={100n}
          state={{
            identity: "test",
            items: [],
            syncStatus: null,
            error: "索引服务暂不可用",
          }}
          onOpenMarket={() => {}}
        />,
      );
      expect(html.includes("本金待退款")).toBe(marketState === 2);
      expect(html.includes("去退还本金")).toBe(marketState === 2);
    },
  );

  it("does not show a refund CTA after the live zero balance supersedes a stale indexed holding", () => {
    const html = renderToStaticMarkup(
      <WalletPositionsView
        enabled
        wallet={UX_MARKET.creator}
        livePositions={[
          {
            vault: UX_MARKET.address,
            outcomeId: 0n,
            balance: 0n,
            marketState: 2,
            winningOutcome: 0n,
          },
        ]}
        targetBlock={100n}
        state={{
          identity: "test",
          items: [
            {
              vault: UX_MARKET.address,
              owner: UX_MARKET.creator,
              outcomeId: 0n,
              balance: 2_000_000n,
              marketState: 2,
              winningOutcome: 0n,
              updatedBlock: 99n,
              confirmationStatus: "confirmed",
            },
          ],
          syncStatus: null,
          error: "",
        }}
        onOpenMarket={() => {}}
      />,
    );
    expect(html).not.toContain("本金待退款");
    expect(html).not.toContain("去退还本金");
  });
});
