// Test-only composition of the production pages. No provider or real transaction is used.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Address } from "viem";
import type {
  CpredictClient,
  MarketRules,
  TransactionResult,
} from "../../../../offchain/sdk/src/index.js";
import {
  MarketPage,
  MarketplacePage,
  PositionsPage,
  SettlementPage,
} from "../../src/App.js";
import type { MarketplaceListingSelection } from "../../../react/src/MarketplacePanel.js";
import type { ConnectedWallet } from "../../src/wallet.js";
import type { TrustReport } from "../../src/trust.js";
import { UX_ACCOUNT, UX_LISTING, UX_MARKET, UX_RULES } from "../ux-fixtures.js";
import { BOND_ESCROW, createBondFixture } from "../bond-fixtures.js";
import "../../src/styles.css";

const transaction: TransactionResult = {
  hash: `0x${"12".repeat(32)}`,
  blockNumber: 101n,
  gasUsed: 1n,
};
const marketplace = "0x0000000000000000000000000000000000002001";
const trust = {
  addresses: {
    usdc: "0x0000000000000000000000000000000000004001",
    contracts: { marketplace },
  },
} as unknown as TrustReport;
const scenario =
  new URLSearchParams(location.search).get("scenario") ?? "purchase";
const initialMarket = {
  ...UX_MARKET,
  totalPrincipal: scenario === "purchase" ? 0n : 2_000_000n,
  ...(scenario.startsWith("void") ? { marketState: 2, voidReason: 1 } : {}),
  ...(scenario.startsWith("winner")
    ? { marketState: 1, winningOutcome: 1 }
    : {}),
  ...(scenario === "settlement" || scenario === "closed-c2c"
    ? { observedAt: UX_MARKET.closeAt }
    : {}),
  ...(scenario.startsWith("bond")
    ? {
        marketState:
          scenario === "bond-open" ? 0 : scenario === "bond-resolved" ? 1 : 2,
        voidReason:
          scenario === "bond-open" || scenario === "bond-resolved"
            ? 0
            : scenario === "bond-zero"
              ? 2
              : scenario.includes("timeout")
                ? 3
                : 1,
        totalPrincipal: scenario === "bond-empty-timeout" ? 0n : 2_000_000n,
        observedAt: UX_MARKET.closeAt,
      }
    : {}),
};
const initialRoute = scenario.startsWith("void")
  ? "positions"
  : scenario.includes("c2c")
    ? "marketplace"
    : scenario === "settlement" || scenario.startsWith("bond")
      ? "settlement"
      : "markets";

function Harness() {
  const [market, setMarket] = useState(initialMarket);
  const [rules, setRules] = useState<MarketRules | null>(UX_RULES);
  const [account, setAccount] = useState({
    ...UX_ACCOUNT,
    positions: scenario.startsWith("winner")
      ? [
          { outcomeId: 0, balance: 0n },
          { outcomeId: 1, balance: 2_000_000n },
        ]
      : UX_ACCOUNT.positions,
  });
  const [owner, setOwner] = useState(UX_MARKET.creator);
  const [route, setRoute] = useState(initialRoute);
  const [selection, setSelection] =
    useState<MarketplaceListingSelection | null>(null);
  const [calls, setCalls] = useState<string[]>([]);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [chainId, setChainId] = useState(421614);
  const [fixture] = useState(() => createBondFixture(initialMarket));
  const releaseDelayedRead = useRef<(() => void) | null>(null);
  const freshListingActive = useRef(true);
  const wallet = { address: owner } as unknown as ConnectedWallet;
  const record = async (method: string, ...args: unknown[]) => {
    setCalls((current) => [
      ...current,
      JSON.stringify({ method, args }, (_, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ]);
    return transaction;
  };
  const client = {
    approvePaymentToken: (...args: unknown[]) =>
      record("approvePaymentToken", ...args),
    buy: (...args: unknown[]) => record("buy", ...args),
    readListing: async () => ({
      ...UX_LISTING,
      observedAt: market.observedAt,
      active: freshListingActive.current,
    }),
    fillListing: (...args: unknown[]) => record("fillListing", ...args),
    cancelListing: (...args: unknown[]) => record("cancelListing", ...args),
    resolve: (...args: unknown[]) => {
      fixture.state.market.marketState = 1;
      fixture.state.market.voidReason = 0;
      return record("resolve", ...args);
    },
    creatorVoid: (...args: unknown[]) => {
      fixture.state.market.marketState = 2;
      fixture.state.market.voidReason = 1;
      return record("creatorVoid", ...args);
    },
    settleBond: async (
      escrow: Address,
      vault: Address,
      onSubmitted?: (hash: `0x${string}`) => void,
    ) => {
      await record("settleBond", escrow, vault);
      return fixture.submit("release", owner, onSubmitted);
    },
    claimBondFor: async (
      escrow: Address,
      creator: Address,
      onSubmitted?: (hash: `0x${string}`) => void,
    ) => {
      await record("claimBondFor", escrow, creator);
      return fixture.submit("claim", owner, onSubmitted);
    },
    refund: async (...args: unknown[]) => {
      setAccount((current) => ({
        ...current,
        positions: current.positions.map((p) => ({ ...p, balance: 0n })),
      }));
      return record("refund", ...args);
    },
    claimWinner: (...args: unknown[]) => record("claimWinner", ...args),
    voidAfterDeadline: (...args: unknown[]) =>
      record("voidAfterDeadline", ...args),
  } as unknown as CpredictClient;
  const execute = async <T extends TransactionResult>(
    _label: string,
    operation: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      return await operation();
    } catch {
      return null;
    }
  };
  const navigate = (next: string, vault: Address = market.address) => {
    location.hash = `#/${next}/${vault}`;
  };
  useEffect(() => {
    const update = () => setRoute(location.hash.split("/")[1] ?? initialRoute);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 16 }}>
      <h1>轻量体验交互回归</h1>
      <p>仅测试数据和交易桩；以下复用真实页面组件，不连接钱包或链。</p>
      <nav aria-label="测试控制">
        <button onClick={() => setRules(null)}>规则暂不可用</button>
        <button
          onClick={() =>
            setRules({
              ...UX_RULES,
              resolutionCriteria: "被篡改的判定标准，不应展示为已验证规则。",
            })
          }
        >
          规则哈希不符
        </button>
        <button onClick={() => setRules(UX_RULES)}>恢复规则</button>
        <button
          onClick={() => {
            fixture.state.market = {
              ...fixture.state.market,
              address: "0x0000000000000000000000000000000000001002",
              creatorBond: 7_000_000n,
            };
            fixture.state.delayRead = null;
            setMarket((current) => ({
              ...current,
              address: "0x0000000000000000000000000000000000001002",
            }));
          }}
        >
          切换市场
        </button>
        <button
          onClick={() =>
            setOwner((current) =>
              current === UX_MARKET.creator
                ? UX_MARKET.creatorTreasury
                : UX_MARKET.creator,
            )
          }
        >
          切换账户
        </button>
        <button
          onClick={() => {
            freshListingActive.current = false;
          }}
        >
          链上挂单已失效
        </button>
        <button onClick={() => navigate("positions")}>返回持仓</button>
        {scenario.startsWith("bond") ? (
          <>
            <button
              onClick={() => {
                fixture.state.readError = true;
                setRefreshVersion((v) => v + 1);
              }}
            >
              押金 RPC 故障
            </button>
            <button
              onClick={() => {
                fixture.state.readError = false;
                fixture.state.reject = false;
                setRefreshVersion((v) => v + 1);
              }}
            >
              恢复押金读取
            </button>
            <button
              onClick={() => {
                fixture.state.receiptPending = true;
              }}
            >
              回执暂不可见
            </button>
            <button
              onClick={() => {
                fixture.state.receiptPending = false;
              }}
            >
              原交易已确认
            </button>
            <button
              onClick={() => {
                fixture.state.failRefresh = true;
              }}
            >
              交易成功后刷新失败
            </button>
            <button
              onClick={() => {
                fixture.state.reject = true;
              }}
            >
              拒绝押金签名
            </button>
            <button
              onClick={() => {
                fixture.state.revert = true;
              }}
            >
              押金交易回滚
            </button>
            <button
              onClick={() => {
                fixture.state.submissionUnknown = true;
              }}
            >
              钱包丢失提交哈希
            </button>
            <button
              onClick={() => {
                fixture.state.credit += 3_000_000n;
                setRefreshVersion((v) => v + 1);
              }}
            >
              其他市场释放 3 USDC
            </button>
            <button
              onClick={() => {
                fixture.state.settled = true;
                fixture.state.credit += fixture.state.market.creatorBond;
              }}
            >
              worker 已释放押金
            </button>
            <button
              onClick={() => {
                fixture.state.credit = 0n;
              }}
            >
              余额已被其他交易领走
            </button>
            <button
              onClick={() => {
                fixture.state.amountAddedBeforeClaim = 1n;
              }}
            >
              领取时追加一个原子单位
            </button>
            <button
              onClick={() => {
                fixture.state.chainId = 1;
                setChainId(1);
              }}
            >
              切换测试链
            </button>
            <button
              onClick={() => {
                const wait = new Promise<void>((resolve) => {
                  releaseDelayedRead.current = resolve;
                });
                fixture.state.delayRead = () => wait;
                setRefreshVersion((v) => v + 1);
              }}
            >
              延迟押金读取
            </button>
            <button
              onClick={() => {
                fixture.state.delayRead = null;
                releaseDelayedRead.current?.();
              }}
            >
              返回旧读取
            </button>
          </>
        ) : null}
      </nav>
      {route === "markets" ? (
        <MarketPage
          marketAddress={market.address}
          setMarketAddress={() => {}}
          market={market}
          marketRules={rules}
          account={scenario === "winner-public" ? null : account}
          protocol={null}
          onLoad={(event) => event.preventDefault()}
          onSelect={async () => {}}
          indexerEnabled={false}
          indexerBasePath="/indexer"
          metadataBasePath={null}
          permit2RelayBasePath={null}
          chainId={421614}
          busy={false}
          client={client}
          publicClient={null}
          wallet={scenario === "winner-public" ? null : wallet}
          trust={trust}
          paymentTokenSymbol="USDC"
          paymentTokenBalance={account.usdcBalance}
          permit2Reusable={false}
          writeReady
          execute={execute}
        />
      ) : null}
      {route === "marketplace" ? (
        <MarketplacePage
          writeReady
          market={market}
          marketRules={rules}
          selectedMarketAddress={market.address}
          marketBusy={false}
          marketLoadError={null}
          account={account}
          trust={trust}
          client={client}
          wallet={owner}
          paymentTokenSymbol="USDC"
          indexerEnabled
          indexerBasePath="/indexer"
          metadataBasePath={null}
          chainId={421614}
          selectedListing={selection}
          refreshVersion={refreshVersion}
          targetBlock={100n}
          onSelectMarket={() => {}}
          onSelectListing={setSelection}
          onListingChange={(next) => {
            setSelection(next);
            setRefreshVersion((value) => value + 1);
          }}
        />
      ) : null}
      {route === "positions" ? (
        <PositionsPage
          market={scenario === "void-indexed" ? null : market}
          account={scenario === "void-indexed" ? null : account}
          wallet={wallet}
          indexerEnabled={scenario !== "void-no-indexer"}
          indexerBasePath="/indexer"
          chainId={421614}
          targetBlock={100n}
          onOpenMarket={(vault) => navigate("markets", vault)}
        />
      ) : null}
      {route === "settlement" ? (
        <SettlementPage
          writeReady
          busy={false}
          market={market}
          marketAddress={market.address}
          wallet={wallet}
          client={client}
          publicClient={scenario.startsWith("bond") ? fixture.rpc : null}
          execute={execute}
          bondEscrow={scenario.startsWith("bond") ? BOND_ESCROW : null}
          evidenceUploader={undefined}
          indexerEnabled={false}
          indexerBasePath="/indexer"
          metadataBasePath={null}
          chainId={chainId}
          refreshVersion={refreshVersion}
          marketRules={rules}
          onSelectMarket={async () => {}}
        />
      ) : null}
      <pre
        data-testid="transaction-calls"
        aria-label="测试交易调用"
        style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
      >
        {calls.join("\n")}
      </pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
