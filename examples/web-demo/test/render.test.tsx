import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { maxUint256 } from "viem";
import App, {
  ActivityDrawer,
  ActivityLine,
  BuyCard,
  DeploymentDrawer,
  DeploymentVerificationToast,
  PERMIT2_REVOKE_CONFIRM,
  SettlementPage,
  deploymentCardCopy,
  deploymentIndicatorState,
  deploymentToastForReport,
  environmentStatusCardStates,
  Inspector,
  MarketPage,
  Permit2AuthorizationSwitch,
  PrimaryAllowanceRow,
  RuntimeDrawer,
  SandboxTokenPanel,
} from "../src/App.js";
import { CreateMarketForm, validatedUri } from "../src/CreateMarketForm.js";
import {
  MarketCatalog,
  MarketCatalogCards,
  SettlementMarketCards,
  settlementCatalogEntries,
  type CatalogEntry,
} from "../src/MarketCatalog.js";
import type { MarketSnapshot } from "../src/protocol.js";
import type { TrustReport } from "../src/trust.js";
import type { LoadedRuntime } from "../src/config.js";
import type { CpredictClient } from "../../../offchain/sdk/src/index.js";
import type { ConnectedWallet } from "../src/wallet.js";

describe("web demo application shell", () => {
  it("maps deployment activity to running, error, and success indicators", () => {
    expect(deploymentIndicatorState("checking")).toBe("running");
    expect(deploymentIndicatorState("blocked")).toBe("error");
    expect(deploymentIndicatorState("debug")).toBe("success");
    expect(deploymentIndicatorState("verified")).toBe("success");
  });

  it("describes a loaded DEBUG address package as deployed but not finalized", () => {
    const copy = deploymentCardCopy({
      manifest: null,
      debugAddresses: {} as NonNullable<LoadedRuntime["debugAddresses"]>,
    });

    expect(copy).toEqual({
      value: "已部署（DEBUG）",
      hint: "调试地址包已加载 · 尚未 FINALIZED_VERIFIED",
    });
  });

  it("treats verified DEBUG deployment and sandbox token as healthy for that environment", () => {
    expect(
      environmentStatusCardStates(
        { level: "debug" },
        { kind: "sandbox-test-token" },
      ),
    ).toEqual({ deployment: "success", paymentToken: "success" });

    expect(
      environmentStatusCardStates(
        { level: "blocked" },
        { kind: "sandbox-test-token" },
      ),
    ).toEqual({ deployment: "warning", paymentToken: "warning" });
  });

  it("renders the trust-first Chinese console without fabricated runtime state", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("Cpredict");
    expect(html).toContain("合约验证控制台");
    expect(html).toContain("写操作已锁定");
    expect(html).toContain("未部署，已锁定");
    for (const label of [
      "概览",
      "部署验证",
      "创建市场",
      "市场",
      "我的持仓",
      "C2C 市场",
      "结算与作废",
      "回执与事件",
    ])
      expect(html).toContain(label);
    expect(html).toContain('aria-controls="deployment-drawer"');
    expect(html).toContain('aria-label="打开部署验证抽屉，写操作已锁定"');
    expect(html).toContain('aria-label="打开运行状态抽屉"');
    expect(html).toContain('aria-controls="activity-drawer"');
    expect(html).toContain('aria-label="打开回执与事件抽屉"');
    expect(html.indexOf("<span>创建市场</span>")).toBeLessThan(
      html.indexOf("<span>市场</span>"),
    );
    expect(html).not.toContain("实时上下文");
    expect(html).not.toContain("本会话事件");
    expect(html).not.toContain("TRUST-FIRST WORKFLOW");
    expect(html).not.toContain("先验证部署，再执行交易");
    expect(html).not.toContain("开始部署验证");
    expect(html).not.toContain("协议操作路径");
    expect(html).not.toContain("打开市场交互");
    expect(html).not.toContain("dangerouslySetInnerHTML");
  });

  it("renders session activity in its own drawer instead of runtime status", () => {
    const runtimeHtml = renderToStaticMarkup(
      <RuntimeDrawer
        open
        onClose={() => {}}
        trust={null}
        runtime={null}
        market={null}
        wallet={null}
      />,
    );
    expect(runtimeHtml).toContain('id="runtime-drawer"');
    expect(runtimeHtml).toContain("实时上下文");
    expect(runtimeHtml).not.toContain("本会话事件");

    const activityHtml = renderToStaticMarkup(
      <ActivityDrawer
        open
        onClose={() => {}}
        activity={[
          {
            id: 1,
            at: new Date("2026-09-02T00:00:00Z"),
            level: "info",
            label: "控制台已初始化",
            detail: "等待运行配置与部署清单",
          },
        ]}
        explorerOrigin="https://sepolia.arbiscan.io"
      />,
    );
    expect(activityHtml).toContain('id="activity-drawer"');
    expect(activityHtml).toContain('role="dialog"');
    expect(activityHtml).toContain("本会话事件");
    expect(activityHtml).toContain("回执与事件");
    expect(activityHtml).toContain("控制台已初始化");
    expect(activityHtml).toContain("等待运行配置与部署清单");
    expect(activityHtml).not.toContain("实时上下文");
  });

  it("keeps deployment status visible until success or a manually dismissed error", () => {
    const checking = renderToStaticMarkup(
      <DeploymentVerificationToast
        toast={{ state: "checking", title: "正在验证部署", detail: "正在检查" }}
        onClose={() => {}}
      />,
    );
    expect(checking).toContain('role="status"');
    expect(checking).toContain("正在验证部署");
    expect(checking).not.toContain("关闭部署验证提示");

    const successToast = deploymentToastForReport({
      level: "verified",
      writeEnabled: true,
      checks: [
        { id: "chain", label: "Chain", state: "pass", detail: "421614" },
      ],
      addresses: null,
      paymentToken: {
        kind: "canonical-usdc",
        name: "USD Coin",
        symbol: "USDC",
        decimals: 6,
        faucetEnabled: false,
        faucetAmount: "0",
      },
      resolutionWindowSeconds: null,
    });
    expect(successToast).toMatchObject({
      state: "success",
      title: "部署验证通过",
    });

    const error = renderToStaticMarkup(
      <DeploymentVerificationToast
        toast={{
          state: "error",
          title: "部署验证未通过",
          detail: "codehash 不匹配",
        }}
        onClose={() => {}}
      />,
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain('aria-label="关闭部署验证提示"');
  });

  it("renders deployment verification in a drawer", () => {
    const address = (digit: string) => `0x${digit.repeat(40)}`;
    const debug = {
      timelock: address("1"),
      config: address("2"),
      emergencyController: address("3"),
      exposureGuard: address("4"),
      feeVault: address("5"),
      bondEscrow: address("6"),
      cloneImplementation: address("7"),
      fullMarketDeployer: address("8"),
      factory: address("9"),
      marketplace: address("a"),
      paymaster: address("b"),
      usdc: address("c"),
      permit2: address("d"),
      entryPoint: address("e"),
    };
    const html = renderToStaticMarkup(
      <DeploymentDrawer
        open
        onClose={() => {}}
        runtime={
          {
            config: {
              chain: { name: "Arbitrum Sepolia" },
              deployment: { allowDebugAddresses: true },
            },
            manifest: null,
            debugAddresses: debug,
            manifestError: null,
          } as LoadedRuntime
        }
        trust={null}
        debug={debug}
        setDebug={() => {}}
        onVerify={() => {}}
        busy={false}
      />,
    );
    expect(html).toContain('id="deployment-drawer"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain("部署与正式发布");
    expect(html).toContain("当前环境");
    expect(html).toContain("已部署（DEBUG）");
    expect(html).toContain("正式发布");
    expect(html).toContain("尚未 FINALIZED_VERIFIED");
    expect(html).toContain("不适用于 DEBUG 地址包");
    expect(html).not.toContain("未部署，已锁定");
    expect(html).toContain("自定义调试地址");
    expect(html).toContain('aria-label="关闭部署验证抽屉"');
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
    expect(html).toContain("测试代币");
    expect(html).toContain("12.5 ctUSD");
    expect(html).toContain("不是 USDC");
    expect(html).toContain("领取 ctUSD");
  });

  it("renders the live Factory resolution window in the address inspector", () => {
    const report: TrustReport = {
      level: "debug",
      writeEnabled: true,
      checks: [],
      addresses: null,
      paymentToken: {
        kind: "sandbox-test-token",
        name: "Cpredict Test USD",
        symbol: "ctUSD",
        decimals: 6,
        faucetEnabled: true,
        faucetAmount: "10000000000",
      },
      resolutionWindowSeconds: 900,
    };
    const html = renderToStaticMarkup(
      <Inspector trust={report} runtime={null} market={null} wallet={null} />,
    );
    expect(html).toContain("结算窗口");
    expect(html).toContain("15 分钟 / 900 秒");
  });

  it("prefills market duration and the accepted HTTP example source", () => {
    const html = renderToStaticMarkup(
      <CreateMarketForm
        client={{} as CpredictClient}
        factory="0x0000000000000000000000000000000000001001"
        factoryAllowance={null}
        paymentToken="0x0000000000000000000000000000000000001002"
        paymentTokenSymbol="ctUSD"
        creator="0x0000000000000000000000000000000000001003"
        creationFee={0n}
        maxFullMarketCap={1_000_000_000n}
        maxCloneMarketCap={1_000_000_000n}
        maxPerUserPrimaryCap={1_000_000_000n}
        maxCreatorRakeBps={1_000}
        maxCreatorC2CFeeBps={1_000}
        metadataBasePath="/metadata"
        wallet={{} as ConnectedWallet}
        writeReady={false}
        busy={false}
        execute={async () => null}
        onMarketCreated={async () => {}}
      />,
    );
    expect(html).toContain("市场期限（分钟，11–129600）");
    expect(html).toContain('value="15"');
    expect(html).toContain('min="11"');
    expect(html).toMatch(
      /id="market-source"[^>]*value="http:\/\/example\.com\/result"/,
    );
    expect(validatedUri("http://example.com/result", "公开判定来源")).toBe(
      "http://example.com/result",
    );
    expect(validatedUri("http://public.example/result", "公开判定来源")).toBe(
      "http://public.example/result",
    );
    expect(() =>
      validatedUri("ftp://public.example/result", "公开判定来源"),
    ).toThrow(/只允许 http:、https: 或 ipfs:/);
  });

  it("renders the exact Permit2 token allowance required before signing", () => {
    const html = renderToStaticMarkup(
      <PrimaryAllowanceRow
        label="Permit2 授权额度"
        allowance={0n}
        paymentTokenSymbol="ctUSD"
        actionLabel="精确授权 ctUSD → Permit2"
        disabled={false}
        onApprove={() => {}}
      />,
    );
    expect(html).toContain("Permit2 授权额度");
    expect(html).toContain("0 ctUSD");
    expect(html).toContain("精确授权 ctUSD → Permit2");
  });

  it("renders reusable Permit2 authorization as an accessible header switch", () => {
    const off = renderToStaticMarkup(
      <Permit2AuthorizationSwitch
        allowance={0n}
        marketEnabled
        busy={false}
        disabled={false}
        onToggle={() => {}}
      />,
    );
    const on = renderToStaticMarkup(
      <Permit2AuthorizationSwitch
        allowance={maxUint256}
        marketEnabled={false}
        busy={false}
        disabled={false}
        onToggle={() => {}}
      />,
    );
    expect(off).toContain('role="switch"');
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain("当前状态：关闭");
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain("已授权 · 当前市场不可用");
    expect(on).toContain("撤销 Permit2 可复用授权");
  });

  it("keeps exact authorization separate and also merges it into primary buy", () => {
    const market: MarketSnapshot = {
      address: "0x0000000000000000000000000000000000001001",
      observedAt: 1_900_000_000n,
      creator: "0x000000000000000000000000000000000000c001",
      creatorTreasury: "0x000000000000000000000000000000000000c002",
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
    const html = renderToStaticMarkup(
      <BuyCard
        market={market}
        outcomeLabels={["Yes", "No"]}
        account={null}
        client={null}
        publicClient={null}
        wallet={null}
        trust={null}
        paymentTokenSymbol="ctUSD"
        permit2Mode={false}
        permit2RelayBasePath={null}
        writeReady
        primaryBuyOpen
        busy={false}
        execute={async () => null}
      />,
    );
    expect(html).toContain("精确授权并模拟购买");
    expect(html).toContain(">精确授权</button>");
  });

  it("uses the header-controlled reusable Permit2 path without another approval", () => {
    const market: MarketSnapshot = {
      address: "0x0000000000000000000000000000000000001001",
      observedAt: 1_900_000_000n,
      creator: "0x000000000000000000000000000000000000c001",
      creatorTreasury: "0x000000000000000000000000000000000000c002",
      rulesHash: `0x${"11".repeat(32)}`,
      outcomeCount: 2,
      createdAt: 1_899_999_000n,
      closeAt: 1_900_001_000n,
      earlyBirdStart: 1_899_999_500n,
      featureFlags: 2n,
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
    const html = renderToStaticMarkup(
      <BuyCard
        market={market}
        outcomeLabels={["Yes", "No"]}
        account={null}
        client={null}
        publicClient={null}
        wallet={null}
        trust={null}
        paymentTokenSymbol="ctUSD"
        permit2Mode
        permit2RelayBasePath="/relay"
        writeReady
        primaryBuyOpen
        busy={false}
        execute={async () => null}
      />,
    );
    expect(html).toContain("签名并购买");
    expect(html).toContain("页头已开启可复用 Permit2 授权");
    expect(html).toContain("中继已配置");
    expect(html).not.toContain("Vault 授权额度");
    expect(html).not.toContain('class="tabs"');
  });

  it("renders an expired unsettled market as closed and disables primary writes", () => {
    const market: MarketSnapshot = {
      address: "0x0000000000000000000000000000000000001001",
      observedAt: 1_900_000_000n,
      creator: "0x000000000000000000000000000000000000c001",
      creatorTreasury: "0x000000000000000000000000000000000000c002",
      rulesHash: `0x${"11".repeat(32)}`,
      outcomeCount: 2,
      createdAt: 1_899_999_000n,
      closeAt: 1_900_000_000n,
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
      resolutionDeadline: 1_900_000_900n,
      permit2Enabled: true,
      earlyBirdEnabled: false,
    };
    const html = renderToStaticMarkup(
      <MarketPage
        marketAddress={market.address}
        setMarketAddress={() => {}}
        market={market}
        marketRules={null}
        account={null}
        protocol={null}
        onLoad={() => {}}
        onSelect={async () => {}}
        indexerEnabled={false}
        indexerBasePath="/indexer"
        metadataBasePath={null}
        permit2RelayBasePath={null}
        chainId={421614}
        busy={false}
        client={null}
        publicClient={null}
        wallet={null}
        trust={null}
        paymentTokenSymbol="ctUSD"
        paymentTokenBalance={null}
        permit2Reusable={false}
        writeReady
        execute={async () => null}
      />,
    );
    expect(html).toContain("已截止，待结算");
    expect(html).toContain("该市场已截止，一级购买已关闭");
    expect(html).toContain('class="button primary wide" disabled=""');
    expect(html).not.toContain(">模拟并购买<");
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
          label: "市场金库就绪",
          detail: market,
          hash,
          market,
        }}
        explorerOrigin="https://sepolia.arbiscan.io"
      />,
    );
    expect(html).toContain("市场金库就绪");
    expect(html).toContain(market);
    expect(html).toContain('aria-label="复制市场金库"');
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
        question: "Will the verified public result be Yes?",
        outcomes: ["Yes", "No"],
        closesAt: 1_900_000_000,
        resolutionSource: "https://example.com/result",
        resolutionCriteria:
          "Use the final result published by the cited source.",
        cancellationPolicy:
          "Void if no unambiguous result is published in time.",
      },
    };
    const html = renderToStaticMarkup(
      <MarketCatalogCards
        entries={[entry]}
        paymentTokenSymbol="ctUSD"
        selectedMarket={null}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("Will the verified public result be Yes?");
    expect(html).toContain("Yes");
    expect(html).toContain("No");
    expect(html).toContain("25.0%");
    expect(html).toContain("查看并交易");
  });

  it("lists only closed unresolved markets and explains who can finalize them", () => {
    const creator = "0x000000000000000000000000000000000000c001";
    const entry: CatalogEntry = {
      market: {
        market: "0x0000000000000000000000000000000000001001",
        creator,
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
        question: "Will the verified result be Yes?",
        outcomes: ["Yes", "No"],
        closesAt: 1_900_000_000,
        resolutionSource: "https://example.com/result",
        resolutionCriteria:
          "Use the final result published by the cited source.",
        cancellationPolicy:
          "Void if no unambiguous result is published in time.",
      },
    };
    expect(settlementCatalogEntries([entry], 1_899_999_999n, creator)).toEqual(
      [],
    );

    const creatorQueue = settlementCatalogEntries(
      [entry],
      1_900_000_001n,
      creator,
    );
    const creatorHtml = renderToStaticMarkup(
      <SettlementMarketCards
        entries={creatorQueue}
        selectedMarket={null}
        onOpen={() => {}}
      />,
    );
    expect(creatorHtml).toContain("可结算或作废");
    expect(creatorHtml).toContain("进入结算");
    expect(creatorHtml).toContain("Will the verified result be Yes?");

    const timeoutQueue = settlementCatalogEntries(
      [entry],
      1_900_000_900n,
      null,
    );
    const timeoutHtml = renderToStaticMarkup(
      <SettlementMarketCards
        entries={timeoutQueue}
        selectedMarket={null}
        onOpen={() => {}}
      />,
    );
    expect(timeoutHtml).toContain("可超时作废");
    expect(timeoutHtml).toContain("任意钱包");
  });

  it("disables settlement writes and shows processing while busy", () => {
    const market: MarketSnapshot = {
      address: "0x0000000000000000000000000000000000001001",
      observedAt: 1_900_000_900n,
      creator: "0x000000000000000000000000000000000000c001",
      creatorTreasury: "0x000000000000000000000000000000000000c002",
      rulesHash: `0x${"11".repeat(32)}`,
      outcomeCount: 2,
      createdAt: 1_899_999_000n,
      closeAt: 1_900_000_000n,
      earlyBirdStart: 1_899_999_500n,
      featureFlags: 0n,
      perUserPrimaryCap: 10_000_000n,
      marketPrimaryCap: 20_000_000n,
      minimumPrimaryUnits: 1_000_000n,
      minimumC2CUnits: 1_000_000n,
      creatorBond: 10_000_000n,
      marketState: 3,
      winningOutcome: 0,
      totalPrincipal: 2_000_000n,
      resolutionDeadline: 1_900_000_900n,
      permit2Enabled: true,
      earlyBirdEnabled: false,
    };
    const html = renderToStaticMarkup(
      <SettlementPage
        writeReady
        busy
        market={market}
        marketAddress={market.address}
        wallet={{ address: market.creator } as ConnectedWallet}
        client={{} as CpredictClient}
        publicClient={null}
        execute={async () => null}
        evidenceUploader={undefined}
        indexerEnabled={false}
        indexerBasePath="/indexer"
        metadataBasePath={null}
        chainId={421614}
        refreshVersion={0}
        onSelectMarket={async () => {}}
      />,
    );
    expect(html).toContain("已终局市场");
    expect(html).toContain("领取与退款从这里进入");
    expect(html).toContain("处理中…");
    expect(html).not.toContain(">领取胜出款<");
    expect(html).toContain("当前 Vault 0x000000…001001");
  });

  it("uses the live payment-token balance on the market page", () => {
    const market: MarketSnapshot = {
      address: "0x0000000000000000000000000000000000001001",
      observedAt: 1_899_999_000n,
      creator: "0x000000000000000000000000000000000000c001",
      creatorTreasury: "0x000000000000000000000000000000000000c002",
      rulesHash: `0x${"11".repeat(32)}`,
      outcomeCount: 2,
      createdAt: 1_899_999_000n,
      closeAt: 1_900_000_000n,
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
      resolutionDeadline: 1_900_000_900n,
      permit2Enabled: true,
      earlyBirdEnabled: false,
    };
    const html = renderToStaticMarkup(
      <MarketPage
        marketAddress={market.address}
        setMarketAddress={() => {}}
        market={market}
        marketRules={null}
        account={{ usdcBalance: 1_000_000n } as never}
        protocol={null}
        onLoad={() => {}}
        onSelect={async () => {}}
        indexerEnabled={false}
        indexerBasePath="/indexer"
        metadataBasePath={null}
        permit2RelayBasePath={null}
        chainId={421614}
        busy={false}
        client={null}
        publicClient={null}
        wallet={null}
        trust={null}
        paymentTokenSymbol="ctUSD"
        paymentTokenBalance={9_000_000n}
        permit2Reusable={false}
        writeReady
        execute={async () => null}
      />,
    );
    expect(html).toContain("9 ctUSD");
    expect(html).not.toContain(">1 ctUSD<");
  });

  it("labels a voided market with the terminal state instead of pending settlement", () => {
    const market: MarketSnapshot = {
      address: "0x0000000000000000000000000000000000001001",
      observedAt: 1_900_000_900n,
      creator: "0x000000000000000000000000000000000000c001",
      creatorTreasury: "0x000000000000000000000000000000000000c002",
      rulesHash: `0x${"11".repeat(32)}`,
      outcomeCount: 2,
      createdAt: 1_899_999_000n,
      closeAt: 1_900_000_000n,
      earlyBirdStart: 1_899_999_500n,
      featureFlags: 0n,
      perUserPrimaryCap: 10_000_000n,
      marketPrimaryCap: 20_000_000n,
      minimumPrimaryUnits: 1_000_000n,
      minimumC2CUnits: 1_000_000n,
      creatorBond: 10_000_000n,
      marketState: 3,
      winningOutcome: 0,
      totalPrincipal: 2_000_000n,
      resolutionDeadline: 1_900_000_900n,
      permit2Enabled: true,
      earlyBirdEnabled: false,
    };
    const html = renderToStaticMarkup(
      <MarketPage
        marketAddress={market.address}
        setMarketAddress={() => {}}
        market={market}
        marketRules={null}
        account={null}
        protocol={null}
        onLoad={() => {}}
        onSelect={async () => {}}
        indexerEnabled={false}
        indexerBasePath="/indexer"
        metadataBasePath={null}
        permit2RelayBasePath={null}
        chainId={421614}
        busy={false}
        client={null}
        publicClient={null}
        wallet={null}
        trust={null}
        paymentTokenSymbol="ctUSD"
        paymentTokenBalance={null}
        permit2Reusable={false}
        writeReady
        execute={async () => null}
      />,
    );
    expect(html).toContain("超时作废");
    expect(html).toContain("链上已终局，目录同步中");
    expect(html).not.toContain("已截止，待结算");
  });

  it("treats deployment checks as pending while verification is running", () => {
    const html = renderToStaticMarkup(
      <DeploymentDrawer
        open
        onClose={() => {}}
        runtime={null}
        trust={{
          level: "blocked",
          writeEnabled: false,
          checks: [
            {
              id: "chain",
              label: "Chain",
              state: "fail",
              detail: "上一轮失败",
            },
          ],
          addresses: null,
          paymentToken: {
            kind: "sandbox-test-token",
            name: "Cpredict Test USD",
            symbol: "ctUSD",
            decimals: 6,
            faucetEnabled: true,
            faucetAmount: "10000000000",
          },
          resolutionWindowSeconds: 900,
        }}
        debug={{
          timelock: "",
          config: "",
          emergencyController: "",
          exposureGuard: "",
          feeVault: "",
          bondEscrow: "",
          cloneImplementation: "",
          fullMarketDeployer: "",
          factory: "",
          marketplace: "",
          paymaster: "",
          usdc: "",
          permit2: "",
          entryPoint: "",
        }}
        setDebug={() => {}}
        onVerify={() => {}}
        busy
      />,
    );
    expect(html).toContain("status-dot pending");
    expect(html).toContain("正在检查…");
    expect(html).not.toContain("上一轮失败");
    expect(html).not.toContain("status-dot fail");
  });

  it("explains that turning off Permit2 sends a revoke transaction", () => {
    expect(PERMIT2_REVOKE_CONFIRM).toContain("撤销 Permit2 授权");
    expect(PERMIT2_REVOKE_CONFIRM).toContain("不是购买");
  });

  it("filters the market catalog by open and terminal states", () => {
    const html = renderToStaticMarkup(
      <MarketCatalog
        enabled
        indexerBasePath="/indexer"
        metadataBasePath={null}
        chainId={421614}
        wallet={null}
        paymentTokenSymbol="ctUSD"
        selectedMarket={null}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("已终局");
    expect(html).toContain("进行中");
    expect(html).toContain("全部");
  });
});
