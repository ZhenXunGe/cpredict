import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App, { SandboxTokenPanel } from "../src/App.js";

describe("web demo application shell", () => {
  it("renders the trust-first Chinese console without fabricated runtime state", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("Cpredict");
    expect(html).toContain("合约验证控制台");
    expect(html).toContain("写操作已锁定");
    expect(html).toContain("BLOCKED_NOT_DEPLOYED");
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
});
