import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App, { ActivityLine, PrimaryAllowanceRow, SandboxTokenPanel } from "../src/App.js";
import { MarketCatalogCards, type CatalogEntry } from "../src/MarketCatalog.js";

describe("web demo application shell", () => {
  it("renders the trust-first Chinese console without fabricated runtime state", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("Cpredict");
    expect(html).toContain("合约验证控制台");
    expect(html).toContain("写操作已锁定");
    expect(html).toContain("BLOCKED_NOT_DEPLOYED");
    for (const label of [
      "概览",
      "部署验证",
      "市场",
      "创建市场",
      "我的持仓",
      "C2C 市场",
      "结算与作废",
      "回执与事件",
    ]) expect(html).toContain(label);
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("renders an unmistakable sandbox token faucet and balance", () => {
    const html = renderToStaticMarkup(
      <SandboxTokenPanel
        token={{
          kind: "sandbox-test-token",
          name: "Cpredict Test USD",
          symbol: "ctUSD",
          decimals: 6,
          faucetEnabled: true,
          faucetAmount: "10000000000",
        }}
        balance={12_500_000n}
        canMint
        busy={false}
        onMint={async () => {}}
      />,
    );
    expect(html).toContain("TEST TOKEN");
    expect(html).toContain("12.5 ctUSD");
    expect(html).toContain("不是 USDC");
    expect(html).toContain("领取 ctUSD");
  });

  it("renders the exact Permit2 token allowance required before signing", () => {
    const html = renderToStaticMarkup(
      <PrimaryAllowanceRow
        label="Permit2 allowance"
        allowance={0n}
        paymentTokenSymbol="ctUSD"
        actionLabel="精确授权 ctUSD → Permit2"
        disabled={false}
        onApprove={() => {}}
      />,
    );
    expect(html).toContain("Permit2 allowance");
    expect(html).toContain("0 ctUSD");
    expect(html).toContain("精确授权 ctUSD → Permit2");
  });

  it("renders the created Market Vault as a copyable transaction receipt", () => {
    const market = "0xb3c7c04fbbea7873bcfc1ea5b5288601486ec9a3";
    const hash = `0x${"12".repeat(32)}` as `0x${string}`;
    const html = renderToStaticMarkup(
      <ActivityLine
        item={{
          id: 4,
          at: new Date("2026-09-01T00:00:00.000Z"),
          level: "success",
          label: "Market Vault ready",
          detail: market,
          hash,
          market,
        }}
        explorerOrigin="https://sepolia.arbiscan.io"
      />,
    );
    expect(html).toContain("Market Vault ready");
    expect(html).toContain(market);
    expect(html).toContain('aria-label="复制 Market Vault"');
    expect(html).toContain(`https://sepolia.arbiscan.io/tx/${hash}`);
  });

  it("renders a consumer market card with real rule labels and a direct action", () => {
    const entry: CatalogEntry = {
      market: {
        market: "0x0000000000000000000000000000000000001001",
        creator: "0x000000000000000000000000000000000000c001",
        deploymentMode: 0,
        outcomeCount: 2,
        closeAt: 1_900_000_000n,
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
        question: "Will the verified public result be Yes?",
        outcomes: ["Yes", "No"],
        closesAt: 1_900_000_000,
        resolutionSource: "https://example.com/result",
        resolutionCriteria: "Use the final result published by the cited source.",
        cancellationPolicy: "Void if no unambiguous result is published in time.",
      },
    };
    const html = renderToStaticMarkup(<MarketCatalogCards entries={[entry]} paymentTokenSymbol="ctUSD" selectedMarket={null} onOpen={() => {}} />);
    expect(html).toContain("Will the verified public result be Yes?");
    expect(html).toContain("Yes");
    expect(html).toContain("No");
    expect(html).toContain("25.0%");
    expect(html).toContain("查看并交易");
  });
});
