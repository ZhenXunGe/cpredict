import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  getAddress,
  isAddress,
  maxUint256,
  parseUnits,
  type Address,
  type PublicClient,
} from "viem";
import {
  buildBuyPermit2TypedData,
  BUY_WITH_PERMIT2_SELECTOR,
  CpredictClient,
  classifyProtocolError,
  createHttpPermit2BuyRelayer,
  type CreateMarketResult,
  type MarketRules,
  type TransactionResult,
} from "../../../offchain/sdk/src/index.js";
import {
  ARBITRUM_SEPOLIA_CHAIN_ID,
  CONTRACT_KEYS,
  loadRuntime,
  type ContractKey,
  type LoadedRuntime,
  type PaymentTokenConfig,
} from "./config.js";
import {
  formatPaymentToken,
  formatShareUnits,
  marketDisplayState,
  readAccount,
  readMarket,
  readPaymentTokenAllowance,
  readPaymentTokenBalance,
  readProtocol,
  type AccountSnapshot,
  type MarketSnapshot,
  type ProtocolSnapshot,
} from "./protocol.js";
import {
  verifyDebugAddresses,
  verifyManifest,
  type DebugAddressInput,
  type TrustCheck,
  type TrustReport,
} from "./trust.js";
import {
  connectWallet,
  createProtocolPublicClient,
  discoverWallets,
  switchToArbitrumSepolia,
  watchWallet,
  type ConnectedWallet,
  type DiscoveredWallet,
} from "./wallet.js";
import { mintSandboxToken } from "./sandbox-token.js";
import { CreateMarketForm, type ExecuteTransaction } from "./CreateMarketForm.js";
import { completeMarketCreation } from "./market-creation-flow.js";
import { MarketCatalog, SettlementMarketCatalog } from "./MarketCatalog.js";
import { fetchMarketRules, type IndexedListing } from "./indexer-client.js";
import {
  ListingsPanel,
  WalletActivityPanel,
  WalletPositionsPanel,
} from "./WalletIndexerPanels.js";
import {
  MarketplacePanel,
  type MarketplaceListingSelection,
} from "../../react/src/MarketplacePanel.js";
import { MarketLifecyclePanel } from "../../react/src/MarketLifecyclePanel.js";
import { transactionDeadline } from "../../react/src/transactionTiming.js";
import { authorizationRequired } from "../../react/src/authorizationFlow.js";
import type { CanonicalEvidenceUploader } from "../../react/src/settlementEvidence.js";

type Route = "overview" | "markets" | "create" | "positions" | "marketplace" | "settlement" | "receipts";
type ActivityLevel = "info" | "success" | "warning" | "error";

export interface DeploymentToast {
  state: "checking" | "success" | "error";
  title: string;
  detail: string;
}

export interface ActivityItem {
  id: number;
  at: Date;
  level: ActivityLevel;
  label: string;
  detail: string;
  hash?: `0x${string}`;
  market?: Address;
}

const NAV_ITEMS: readonly { route: Route; icon: string; label: string }[] = [
  { route: "overview", icon: "⌂", label: "概览" },
  { route: "create", icon: "+", label: "创建市场" },
  { route: "markets", icon: "▤", label: "市场" },
  { route: "positions", icon: "◎", label: "我的持仓" },
  { route: "marketplace", icon: "⇄", label: "C2C 市场" },
  { route: "settlement", icon: "✓", label: "结算与作废" },
  { route: "receipts", icon: "▧", label: "回执与事件" },
];

const DEPLOYMENT_CHECKING_TOAST: DeploymentToast = {
  state: "checking",
  title: "正在验证部署",
  detail: "正在核对 chainId、runtime codehash 与关键 wiring…",
};

const INITIAL_DEBUG: DebugAddressInput = {
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
  usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
};

export default function App() {
  const [route, setRoute, routeMarketAddress] = useHashRoute();
  const [runtime, setRuntime] = useState<LoadedRuntime | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [publicClient, setPublicClient] = useState<PublicClient | null>(null);
  const [trust, setTrust] = useState<TrustReport | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [selectedWallet, setSelectedWallet] = useState("");
  const [debug, setDebug] = useState<DebugAddressInput>(INITIAL_DEBUG);
  const [marketAddress, setMarketAddress] = useState("");
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [selectedMarketplaceListing, setSelectedMarketplaceListing] =
    useState<MarketplaceListingSelection | null>(null);
  const [marketplaceRefreshVersion, setMarketplaceRefreshVersion] = useState(0);
  const [selectedMarketRules, setSelectedMarketRules] = useState<MarketRules | null>(null);
  const [accountSnapshot, setAccountSnapshot] = useState<AccountSnapshot | null>(null);
  const [protocolSnapshot, setProtocolSnapshot] = useState<ProtocolSnapshot | null>(null);
  const [paymentTokenBalance, setPaymentTokenBalance] = useState<bigint | null>(null);
  const [permit2Allowance, setPermit2Allowance] = useState<bigint | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [accountRefreshVersion, setAccountRefreshVersion] = useState(0);
  const [positionSyncTarget, setPositionSyncTarget] = useState<{
    wallet: Address;
    blockNumber: bigint;
  } | null>(null);
  const [openDrawer, setOpenDrawer] = useState<"deployment" | "runtime" | "activity" | null>(null);
  const [deploymentToast, setDeploymentToast] = useState<DeploymentToast | null>({
    state: "checking",
    title: "正在加载部署配置",
    detail: "部署验证将在 runtime config 加载后自动开始…",
  });
  const deploymentVerificationRef = useRef<Promise<void> | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([
    { id: 1, at: new Date(), level: "info", label: "Console initialized", detail: "等待 runtime config 与部署清单" },
  ]);

  const showDeploymentToast = useCallback((nextToast: DeploymentToast | null) => {
    setDeploymentToast(nextToast);
  }, []);

  const runDeploymentVerification = useCallback((client: PublicClient, loaded: LoadedRuntime) => {
    if (deploymentVerificationRef.current !== null) return;
    const verification = refreshTrust(
      client,
      loaded,
      setTrust,
      setTrustBusy,
      setActivity,
      showDeploymentToast,
    );
    deploymentVerificationRef.current = verification;
    void verification.finally(() => {
      if (deploymentVerificationRef.current === verification)
        deploymentVerificationRef.current = null;
    });
  }, [showDeploymentToast]);

  useEffect(() => {
    let active = true;
    void loadRuntime()
      .then((loaded) => {
        if (!active) return;
        const client = createProtocolPublicClient(loaded.config);
        setRuntime(loaded);
        if (loaded.debugAddresses !== null) setDebug(loaded.debugAddresses);
        setPublicClient(client);
        push(setActivity, "info", "Runtime config loaded", loaded.manifest === null ? loaded.manifestError ?? "无部署清单" : `manifest ${loaded.manifest.source.commit.slice(0, 8)}`);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const detail = messageOf(error);
        setRuntimeError(detail);
        showDeploymentToast({ state: "error", title: "部署验证无法开始", detail });
      });
    return () => { active = false; };
  }, [showDeploymentToast]);

  useEffect(() => discoverWallets(setWallets), []);

  useEffect(() => {
    if (wallet === null) return;
    return watchWallet(
      wallet,
      (address) => {
        if (address === null || address.toLowerCase() !== wallet.address.toLowerCase()) {
          setWallet(null);
          setAccountSnapshot(null);
          setPaymentTokenBalance(null);
          setPositionSyncTarget(null);
          push(setActivity, "warning", "Wallet account changed", "为防止角色混淆，已锁定并要求重新连接");
        }
      },
      (chainId) => {
        setWallet((current) => current === null ? null : { ...current, chainId });
        push(setActivity, chainId === ARBITRUM_SEPOLIA_CHAIN_ID ? "success" : "warning", "Wallet chain changed", `chainId ${chainId}`);
      },
    );
  }, [wallet?.provider.info.uuid, wallet?.address]);

  useEffect(() => {
    if (publicClient === null || runtime === null) return;
    runDeploymentVerification(publicClient, runtime);
  }, [publicClient, runDeploymentVerification, runtime]);

  useEffect(() => {
    if (openDrawer !== "deployment" || publicClient === null || runtime === null) return;
    runDeploymentVerification(publicClient, runtime);
  }, [openDrawer, publicClient, runDeploymentVerification, runtime]);

  useEffect(() => {
    if (publicClient === null || trust?.addresses === null || trust?.addresses === undefined) return;
    let active = true;
    void readProtocol(publicClient, trust.addresses.contracts.config, trust.addresses.contracts.paymaster)
      .then((snapshot) => { if (active) setProtocolSnapshot(snapshot); })
      .catch((error: unknown) => { if (active) push(setActivity, "warning", "Protocol snapshot unavailable", messageOf(error)); });
    return () => { active = false; };
  }, [publicClient, trust]);

  useEffect(() => {
    if (publicClient === null || wallet === null || trust?.addresses === null || trust?.addresses === undefined) {
      setPaymentTokenBalance(null);
      return;
    }
    let active = true;
    void readPaymentTokenBalance(publicClient, wallet.address, trust.addresses.usdc)
      .then((balance) => { if (active) setPaymentTokenBalance(balance); })
      .catch((error: unknown) => {
        if (active) push(setActivity, "warning", "Payment token balance unavailable", messageOf(error));
      });
    return () => { active = false; };
  }, [publicClient, trust?.addresses?.usdc, wallet?.address]);

  const client = useMemo(() => {
    if (publicClient === null || wallet === null) return null;
    return new CpredictClient(publicClient as never, wallet.walletClient as never, wallet.account);
  }, [publicClient, wallet]);

  const writeReady = Boolean(
    client !== null &&
      wallet?.chainId === ARBITRUM_SEPOLIA_CHAIN_ID &&
      trust?.writeEnabled,
  );

  async function handleWalletConnect() {
    if (walletBusy) return;
    const candidate = wallets.find((item) => item.info.uuid === selectedWallet) ?? wallets[0];
    if (candidate === undefined) {
      push(setActivity, "error", "Wallet connection failed", "未发现 EIP-6963 或 window.ethereum 钱包");
      return;
    }
    setWalletBusy(true);
    try {
      const connected = await connectWallet(candidate);
      setWallet(connected);
      setSelectedWallet(candidate.info.uuid);
      push(setActivity, "success", "Wallet connected", `${candidate.info.name} · ${short(connected.address)}`);
    } catch (error: unknown) {
      push(setActivity, "error", "Wallet connection failed", messageOf(error));
    } finally {
      setWalletBusy(false);
    }
  }

  async function handleNetworkSwitch() {
    if (wallet === null) return;
    setWalletBusy(true);
    try {
      const chainId = await switchToArbitrumSepolia(wallet.provider.provider);
      setWallet({ ...wallet, chainId });
      push(setActivity, "success", "Network switched", `chainId ${chainId}`);
    } catch (error: unknown) {
      push(setActivity, "error", "Network switch failed", messageOf(error));
    } finally {
      setWalletBusy(false);
    }
  }

  async function handleDebugVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (publicClient === null || runtime?.config.deployment.allowDebugAddresses !== true) return;
    setTrustBusy(true);
    showDeploymentToast(DEPLOYMENT_CHECKING_TOAST);
    try {
      const report = await verifyDebugAddresses(publicClient, debug, runtime.config.paymentToken);
      setTrust(report);
      showDeploymentToast(deploymentToastForReport(report));
      push(setActivity, report.level === "debug" ? "warning" : "error", "Debug address verification", report.level === "debug" ? "调试地址通过最低 code/wiring 检查；仍非正式清单" : "调试地址验证失败");
    } catch (error: unknown) {
      const detail = messageOf(error);
      showDeploymentToast({ state: "error", title: "部署验证失败", detail });
      push(setActivity, "error", "Debug verification failed", detail);
    } finally {
      setTrustBusy(false);
    }
  }

  async function loadMarketAddress(candidate: string) {
    if (publicClient === null || !isAddress(candidate)) {
      push(setActivity, "error", "Market load failed", "请输入有效 Vault 地址");
      return;
    }
    setOperationBusy(true);
    try {
      const nextMarket = await readMarket(publicClient, getAddress(candidate));
      setMarket(nextMarket);
      setSelectedMarketRules(null);
      if (runtime?.config.metadata.enabled === true) {
        try {
          const rules = await fetchMarketRules({
            metadataBasePath: runtime.config.metadata.basePath,
            rulesHash: nextMarket.rulesHash,
          });
          if (BigInt(rules.closesAt) !== nextMarket.closeAt)
            throw new Error("规则中的截止时间与 Vault 不一致");
          setSelectedMarketRules(rules);
        } catch {
          setSelectedMarketRules(null);
        }
      }
      if (trust?.addresses !== null && trust?.addresses !== undefined) {
        setProtocolSnapshot(await readProtocol(publicClient, trust.addresses.contracts.config, trust.addresses.contracts.paymaster));
      }
      push(setActivity, "success", "Market loaded", `${short(nextMarket.address)} · ${marketDisplayState(nextMarket).label}`);
    } catch (error: unknown) {
      push(setActivity, "error", "Market load failed", classifyProtocolError(error).message);
    } finally {
      setOperationBusy(false);
    }
  }

  async function handleMarketLoad(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (isAddress(marketAddress)) setRoute("markets", getAddress(marketAddress));
    await loadMarketAddress(marketAddress);
  }

  async function handleMarketSelect(address: Address, rules: MarketRules | null) {
    setMarketAddress(address);
    setSelectedMarketRules(rules);
    setRoute("markets", address);
    await loadMarketAddress(address);
  }

  async function handleMarketplaceListingSelect(listing: IndexedListing) {
    setSelectedMarketplaceListing(listing);
    setMarketAddress(listing.vault);
    await loadMarketAddress(listing.vault);
  }

  function handleMarketplaceListingChange(
    listing: MarketplaceListingSelection | null,
    result: TransactionResult,
  ) {
    setSelectedMarketplaceListing(listing);
    setMarketplaceRefreshVersion((version) => version + 1);
    setAccountRefreshVersion((version) => version + 1);
    if (wallet !== null)
      setPositionSyncTarget({
        wallet: wallet.address,
        blockNumber: result.blockNumber,
      });
  }

  async function handleSettlementSelect(address: Address, rules: MarketRules | null) {
    setMarketAddress(address);
    setSelectedMarketRules(rules);
    setRoute("settlement", address);
    await loadMarketAddress(address);
  }

  useEffect(() => {
    if (
      routeMarketAddress === null ||
      publicClient === null ||
      marketAddress.toLowerCase() === routeMarketAddress.toLowerCase()
    ) return;
    setMarketAddress(routeMarketAddress);
    void loadMarketAddress(routeMarketAddress);
  }, [routeMarketAddress, publicClient]);

  useEffect(() => {
    if (
      publicClient === null ||
      market === null ||
      market.marketState !== 0 ||
      market.observedAt >= market.closeAt
    ) return;
    const millisecondsUntilClose = Number((market.closeAt - market.observedAt) * 1_000n);
    const timer = window.setTimeout(
      () => void loadMarketAddress(market.address),
      Math.min(millisecondsUntilClose + 1_000, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [publicClient, market?.address, market?.closeAt, market?.marketState, market?.observedAt]);

  useEffect(() => {
    if (
      publicClient === null ||
      wallet === null ||
      market === null ||
      trust?.addresses === null ||
      trust?.addresses === undefined
    ) {
      setAccountSnapshot(null);
      return;
    }
    let active = true;
    void readAccount(
      publicClient,
      wallet.address,
      market,
      trust.addresses.usdc,
      trust.addresses.contracts.factory,
      trust.addresses.contracts.marketplace,
      trust.addresses.permit2,
    ).then((snapshot) => {
      if (active) setAccountSnapshot(snapshot);
    }).catch((cause: unknown) => {
      if (active) {
        setAccountSnapshot(null);
        push(setActivity, "warning", "Account snapshot unavailable", messageOf(cause));
      }
    });
    return () => { active = false; };
  }, [accountRefreshVersion, publicClient, wallet?.address, market, trust?.addresses]);

  useEffect(() => {
    if (
      publicClient === null ||
      wallet === null ||
      trust?.addresses === null ||
      trust?.addresses === undefined
    ) {
      setPermit2Allowance(null);
      return;
    }
    let active = true;
    void readPaymentTokenAllowance(
      publicClient,
      wallet.address,
      trust.addresses.usdc,
      trust.addresses.permit2,
    ).then((allowance) => {
      if (active) setPermit2Allowance(allowance);
    }).catch((cause: unknown) => {
      if (active) {
        setPermit2Allowance(null);
        push(setActivity, "warning", "Permit2 allowance unavailable", messageOf(cause));
      }
    });
    return () => { active = false; };
  }, [accountRefreshVersion, publicClient, wallet?.address, trust?.addresses]);

  async function executeOperation<T extends TransactionResult>(label: string, operation: () => Promise<T>): Promise<T | null> {
    if (operationBusy || !writeReady) return null;
    setOperationBusy(true);
    push(
      setActivity,
      "info",
      `${label}: simulating`,
      "validate → simulate → bound gas/fees → submit once → receipt",
    );
    try {
      const result = await operation();
      push(setActivity, "success", label, `block ${result.blockNumber} · gas ${result.gasUsed}`, result.hash);
      setAccountRefreshVersion((version) => version + 1);
      if (wallet !== null)
        setPositionSyncTarget({ wallet: wallet.address, blockNumber: result.blockNumber });
      if (publicClient !== null && wallet !== null && trust?.addresses !== null && trust?.addresses !== undefined) {
        setPaymentTokenBalance(
          await readPaymentTokenBalance(publicClient, wallet.address, trust.addresses.usdc),
        );
      }
      if (market !== null) await loadMarketAddress(market.address);
      return result;
    } catch (error: unknown) {
      const classified = classifyProtocolError(error);
      push(
        setActivity,
        "error",
        `${label}: ${classified.kind === "gas-safety" ? "blocked before signing" : "failed"}`,
        classified.message,
      );
      return null;
    } finally {
      setOperationBusy(false);
    }
  }

  const permit2Reusable = permit2Allowance === maxUint256;

  async function handlePermit2AuthorizationToggle() {
    if (
      client === null ||
      wallet === null ||
      trust?.addresses === null ||
      trust?.addresses === undefined ||
      permit2Allowance === null
    ) return;
    const nextAllowance = permit2Reusable ? 0n : maxUint256;
    const result = await executeOperation(
      permit2Reusable ? "Revoke reusable Permit2 authorization" : "Enable reusable Permit2 authorization",
      () => client.approvePaymentToken(
        trust.addresses!.usdc,
        trust.addresses!.permit2,
        nextAllowance,
      ),
    );
    if (result !== null) setPermit2Allowance(nextAllowance);
  }

  async function handleMarketCreated(result: CreateMarketResult) {
    await completeMarketCreation(result, {
      selectMarket: setMarketAddress,
      navigateToMarket: () => setRoute("markets", result.market),
      recordMarketVault: (address, hash) => push(
        setActivity,
        "success",
        "Market Vault ready",
        address,
        hash,
        address,
      ),
      loadMarket: loadMarketAddress,
    });
  }

  async function handleSandboxMint() {
    if (
      publicClient === null ||
      wallet === null ||
      trust?.addresses === null ||
      trust?.addresses === undefined ||
      trust.paymentToken.kind !== "sandbox-test-token"
    ) return;
    await executeOperation(
      `领取 ${trust.paymentToken.symbol}`,
      () => mintSandboxToken(
        publicClient,
        wallet,
        trust.addresses!.usdc,
        BigInt(trust.paymentToken.faucetAmount),
      ),
    );
  }

  const currentTitle = NAV_ITEMS.find((item) => item.route === route)?.label ?? "概览";
  const paymentToken = trust?.paymentToken ?? runtime?.config.paymentToken ?? null;
  const paymentTokenSymbol = paymentToken?.symbol ?? "USDC";
  const deploymentState = trustBusy ? "checking" : trust?.level ?? "blocked";
  const deploymentIndicator = deploymentIndicatorState(deploymentState);
  const deploymentDrawerOpen = openDrawer === "deployment";
  const runtimeDrawerOpen = openDrawer === "runtime";
  const activityDrawerOpen = openDrawer === "activity";
  const positionTargetBlock =
    wallet !== null &&
    positionSyncTarget !== null &&
    positionSyncTarget.wallet.toLowerCase() === wallet.address.toLowerCase()
      ? positionSyncTarget.blockNumber
      : null;

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="主导航">
        <Brand />
        <nav>
          {NAV_ITEMS.map((item) => (
            <button key={item.route} className={route === item.route ? "nav-item active" : "nav-item"} onClick={() => setRoute(item.route)}>
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="status-dot warning" />
          <span>Arbitrum Sepolia</span>
          <small>chainId {ARBITRUM_SEPOLIA_CHAIN_ID}</small>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="mobile-brand"><Brand compact /></div>
          <div>
            <p className="eyebrow">CPREDICT / CONTRACT CONSOLE</p>
            <h1>{currentTitle}</h1>
          </div>
          <div className="top-actions">
            <Permit2AuthorizationSwitch
              allowance={permit2Allowance}
              marketEnabled={market?.permit2Enabled ?? null}
              busy={operationBusy}
              disabled={!writeReady || client === null || wallet === null || permit2Allowance === null}
              onToggle={() => void handlePermit2AuthorizationToggle()}
            />
            <button
              type="button"
              className={deploymentDrawerOpen ? "header-utility active" : "header-utility"}
              onClick={() => setOpenDrawer(deploymentDrawerOpen ? null : "deployment")}
              aria-controls="deployment-drawer"
              aria-expanded={deploymentDrawerOpen}
              aria-label={`${deploymentDrawerOpen ? "关闭" : "打开"}部署验证抽屉，${deploymentStatusLabel(deploymentState)}`}
            >
              <span className="status-dot" data-status={deploymentIndicator} />
              <span className="utility-label">部署验证</span>
            </button>
            <button
              type="button"
              className={runtimeDrawerOpen ? "header-utility active" : "header-utility"}
              onClick={() => setOpenDrawer(runtimeDrawerOpen ? null : "runtime")}
              aria-controls="runtime-drawer"
              aria-expanded={runtimeDrawerOpen}
              aria-label={runtimeDrawerOpen ? "关闭运行状态抽屉" : "打开运行状态抽屉"}
            >
              <span className="status-dot" data-status={deploymentIndicator} />
              <span className="utility-label">运行状态</span>
            </button>
            <button
              type="button"
              className={activityDrawerOpen ? "header-utility active" : "header-utility"}
              onClick={() => setOpenDrawer(activityDrawerOpen ? null : "activity")}
              aria-controls="activity-drawer"
              aria-expanded={activityDrawerOpen}
              aria-label={activityDrawerOpen ? "关闭事件与回执抽屉" : "打开事件与回执抽屉"}
            >
              <span className="utility-count" aria-hidden="true">{activity.length}</span>
              <span className="utility-label">事件与回执</span>
            </button>
            {wallet !== null && wallet.chainId !== ARBITRUM_SEPOLIA_CHAIN_ID ? (
              <button className="button warning" onClick={() => void handleNetworkSwitch()} disabled={walletBusy}>切换网络</button>
            ) : null}
            <select aria-label="选择钱包" value={selectedWallet} onChange={(event) => setSelectedWallet(event.currentTarget.value)}>
              <option value="">{wallets.length === 0 ? "未发现钱包" : "选择钱包"}</option>
              {wallets.map((item) => <option key={item.info.uuid} value={item.info.uuid}>{item.info.name}</option>)}
            </select>
            <button className="button primary" onClick={() => void handleWalletConnect()} disabled={walletBusy || wallets.length === 0}>
              {wallet === null ? "连接钱包" : short(wallet.address)}
            </button>
          </div>
        </header>

        <div className="trust-banner" data-level={trust?.level ?? "blocked"}>
          <strong>{paymentToken?.kind === "sandbox-test-token" ? "TEST ONLY：ctUSD 可由任何人任意增发，无真实价值" : trust?.level === "verified" ? "正式清单与链上代码已验证" : trust?.level === "debug" ? "调试地址模式：非正式发布证据" : "写操作已锁定"}</strong>
          <span>{runtimeError ?? runtime?.manifestError ?? trustSummary(trust)}</span>
        </div>

        <main className="page-grid">
          <section className="main-column">
            {route === "overview" ? <Overview runtime={runtime} trust={trust} wallet={wallet} market={market} protocol={protocolSnapshot} paymentToken={paymentToken} paymentTokenBalance={paymentTokenBalance} writeReady={writeReady} busy={operationBusy} onMint={handleSandboxMint} /> : null}
            {route === "markets" ? <MarketPage marketAddress={marketAddress} setMarketAddress={setMarketAddress} market={market} marketRules={selectedMarketRules} account={accountSnapshot} protocol={protocolSnapshot} onLoad={handleMarketLoad} onSelect={handleMarketSelect} indexerEnabled={runtime?.config.indexer.enabled === true} indexerBasePath={runtime?.config.indexer.basePath ?? "/indexer"} metadataBasePath={runtime?.config.metadata.enabled === true ? runtime.config.metadata.basePath : null} permit2RelayBasePath={runtime?.config.permit2Relay.enabled === true ? runtime.config.permit2Relay.basePath : null} chainId={runtime?.config.chain.id ?? ARBITRUM_SEPOLIA_CHAIN_ID} busy={operationBusy} client={client} publicClient={publicClient} wallet={wallet} trust={trust} paymentTokenSymbol={paymentTokenSymbol} permit2Reusable={permit2Reusable} writeReady={writeReady} execute={executeOperation} /> : null}
            {route === "create" ? <CreatePage writeReady={writeReady} trust={trust} client={client} wallet={wallet} account={accountSnapshot} protocol={protocolSnapshot} paymentTokenSymbol={paymentTokenSymbol} metadataBasePath={runtime?.config.metadata.enabled === true ? runtime.config.metadata.basePath : null} busy={operationBusy} execute={executeOperation} onMarketCreated={handleMarketCreated} /> : null}
            {route === "positions" ? <PositionsPage market={market} account={accountSnapshot} wallet={wallet} indexerEnabled={runtime?.config.indexer.enabled === true} indexerBasePath={runtime?.config.indexer.basePath ?? "/indexer"} chainId={runtime?.config.chain.id ?? ARBITRUM_SEPOLIA_CHAIN_ID} targetBlock={positionTargetBlock} onOpenMarket={(address) => void handleMarketSelect(address, null)} /> : null}
            {route === "marketplace" ? <MarketplacePage writeReady={writeReady} market={market} account={accountSnapshot} trust={trust} client={client} paymentTokenSymbol={paymentTokenSymbol} indexerEnabled={runtime?.config.indexer.enabled === true} indexerBasePath={runtime?.config.indexer.basePath ?? "/indexer"} chainId={runtime?.config.chain.id ?? ARBITRUM_SEPOLIA_CHAIN_ID} selectedListing={selectedMarketplaceListing} refreshVersion={marketplaceRefreshVersion} onSelectListing={(listing) => void handleMarketplaceListingSelect(listing)} onListingChange={handleMarketplaceListingChange} /> : null}
            {route === "settlement" ? <SettlementPage writeReady={writeReady} market={market} wallet={wallet} client={client} publicClient={publicClient} execute={executeOperation} evidenceUploader={runtime === null ? undefined : makeEvidenceUploader(runtime)} indexerEnabled={runtime?.config.indexer.enabled === true} indexerBasePath={runtime?.config.indexer.basePath ?? "/indexer"} metadataBasePath={runtime?.config.metadata.enabled === true ? runtime.config.metadata.basePath : null} chainId={runtime?.config.chain.id ?? ARBITRUM_SEPOLIA_CHAIN_ID} onSelectMarket={handleSettlementSelect} /> : null}
            {route === "receipts" ? <ReceiptsPage activity={activity} explorerOrigin={runtime?.config.chain.explorerOrigin ?? "https://sepolia.arbiscan.io"} paymentTokenSymbol={paymentTokenSymbol} wallet={wallet} indexerEnabled={runtime?.config.indexer.enabled === true} indexerBasePath={runtime?.config.indexer.basePath ?? "/indexer"} chainId={runtime?.config.chain.id ?? ARBITRUM_SEPOLIA_CHAIN_ID} onOpenMarket={(address) => void handleMarketSelect(address, null)} /> : null}
          </section>
        </main>
        <DeploymentDrawer
          open={deploymentDrawerOpen}
          onClose={() => setOpenDrawer(null)}
          runtime={runtime}
          trust={trust}
          debug={debug}
          setDebug={setDebug}
          onVerify={handleDebugVerify}
          busy={trustBusy}
        />
        <RuntimeDrawer
          open={runtimeDrawerOpen}
          onClose={() => setOpenDrawer(null)}
          trust={trust}
          runtime={runtime}
          market={market}
          wallet={wallet}
        />
        <ActivityDrawer
          open={activityDrawerOpen}
          onClose={() => setOpenDrawer(null)}
          activity={activity}
          explorerOrigin={runtime?.config.chain.explorerOrigin ?? "https://sepolia.arbiscan.io"}
        />
        <DeploymentVerificationToast
          toast={deploymentToast}
          onClose={() => showDeploymentToast(null)}
        />
      </section>

      <nav className="bottom-nav" aria-label="移动端导航">
        {NAV_ITEMS.map((item) => (
          <button key={item.route} className={route === item.route ? "active" : ""} onClick={() => setRoute(item.route)}>
            <span>{item.icon}</span><small>{item.label.replace("我的", "")}</small>
          </button>
        ))}
      </nav>
    </div>
  );
}

export function deploymentCardCopy(
  runtime: Pick<LoadedRuntime, "manifest" | "debugAddresses"> | null,
): { value: string; hint: string } {
  if (runtime?.manifest !== null && runtime?.manifest !== undefined) {
    return { value: runtime.manifest.status, hint: runtime.manifest.source.tag };
  }
  if (runtime?.debugAddresses !== null && runtime?.debugAddresses !== undefined) {
    return {
      value: "已部署（DEBUG）",
      hint: "调试地址包已加载 · 尚未 FINALIZED_VERIFIED",
    };
  }
  return { value: "BLOCKED_NOT_DEPLOYED", hint: "需加载部署地址包" };
}

export function environmentStatusCardStates(
  trust: Pick<TrustReport, "level"> | null,
  paymentToken: Pick<PaymentTokenConfig, "kind"> | null,
): { deployment: "success" | "warning"; paymentToken: "success" | "warning" } {
  const isDebugEnvironment = trust?.level === "debug";
  return {
    deployment: trust?.level === "verified" || isDebugEnvironment ? "success" : "warning",
    paymentToken: paymentToken?.kind === "sandbox-test-token" && !isDebugEnvironment ? "warning" : "success",
  };
}

function Overview({ runtime, trust, wallet, market, protocol, paymentToken, paymentTokenBalance, writeReady, busy, onMint }: {
  runtime: LoadedRuntime | null;
  trust: TrustReport | null;
  wallet: ConnectedWallet | null;
  market: MarketSnapshot | null;
  protocol: ProtocolSnapshot | null;
  paymentToken: PaymentTokenConfig | null;
  paymentTokenBalance: bigint | null;
  writeReady: boolean;
  busy: boolean;
  onMint: () => Promise<void>;
}) {
  const paymentTokenSymbol = paymentToken?.symbol ?? "USDC";
  const displayState = market === null ? null : marketDisplayState(market);
  const deploymentCard = deploymentCardCopy(runtime);
  const environmentStates = environmentStatusCardStates(trust, paymentToken);
  const cards = [
    { label: "部署状态", ...deploymentCard, state: environmentStates.deployment },
    { label: "钱包网络", value: wallet === null ? "未连接" : wallet.chainId === ARBITRUM_SEPOLIA_CHAIN_ID ? "Arbitrum Sepolia" : `Wrong chain ${wallet.chainId}`, hint: wallet === null ? "EIP-6963 / injected" : short(wallet.address), state: wallet?.chainId === ARBITRUM_SEPOLIA_CHAIN_ID ? "success" : "warning" },
    { label: "支付币", value: paymentToken === null ? "待加载" : paymentTokenSymbol, hint: paymentToken?.kind === "sandbox-test-token" ? "TEST / 任意增发 / 无真实价值" : "Canonical Arbitrum Sepolia USDC", state: environmentStates.paymentToken },
    { label: "当前市场", value: displayState?.label ?? "未选择", hint: market === null ? "从市场页加载 Vault" : formatPaymentToken(market.totalPrincipal, paymentTokenSymbol), state: market === null ? "muted" : displayState?.primaryBuyOpen ? "success" : "warning" },
    { label: "Paymaster", value: protocol === null ? "只读待加载" : formatEtherCompact(protocol.paymasterDeposit), hint: protocol === null ? "本 Demo 不发送 UserOperation" : `policy v${protocol.paymasterPolicyVersion}`, state: protocol === null ? "muted" : "success" },
  ];
  return (
    <>
      <div className="status-grid">
        {cards.map((card) => <StatusCard key={card.label} {...card} />)}
      </div>
      {paymentToken?.kind === "sandbox-test-token" ? (
        <SandboxTokenPanel
          token={paymentToken}
          balance={paymentTokenBalance}
          canMint={writeReady}
          busy={busy}
          onMint={onMint}
        />
      ) : null}
    </>
  );
}

export function SandboxTokenPanel({ token, balance, canMint, busy, onMint }: {
  token: PaymentTokenConfig;
  balance: bigint | null;
  canMint: boolean;
  busy: boolean;
  onMint: () => Promise<void>;
}) {
  return (
    <Panel
      title="Sandbox 测试币"
      subtitle="仅限 Arbitrum Sepolia 演示；任何地址都能任意 mint；不是 USDC，也没有真实价值"
      action={<span className="sandbox-chip">TEST TOKEN</span>}
    >
      <div className="sandbox-token-row">
        <div><small>当前余额</small><strong>{balance === null ? "—" : formatPaymentToken(balance, token.symbol)}</strong></div>
        <div><small>每次领取</small><strong>{formatPaymentToken(BigInt(token.faucetAmount), token.symbol)}</strong></div>
        <button className="button warning" disabled={!canMint || busy} onClick={() => void onMint()}>
          {busy ? "处理中…" : canMint ? `领取 ${token.symbol}` : "连接钱包并通过部署验证"}
        </button>
      </div>
      <p className="callout danger">该币可无限增发，禁止用于主网、真实结算、估值或对外宣称为 USDC。</p>
    </Panel>
  );
}

function DeploymentPage({ runtime, trust, debug, setDebug, onVerify, busy }: {
  runtime: LoadedRuntime | null;
  trust: TrustReport | null;
  debug: DebugAddressInput;
  setDebug: (value: DebugAddressInput) => void;
  onVerify: (event: FormEvent<HTMLFormElement>) => void;
  busy: boolean;
}) {
  const currentEnvironment = deploymentCardCopy(runtime).value;
  const debugPackageLoaded = runtime?.debugAddresses !== null && runtime?.debugAddresses !== undefined;
  const formalRelease = runtime?.manifest?.status ?? (debugPackageLoaded ? "尚未 FINALIZED_VERIFIED" : "BLOCKED_NOT_DEPLOYED");
  const debugNotApplicable = debugPackageLoaded ? "不适用于 DEBUG 地址包" : "—";
  return (
    <>
      <Panel title="部署与正式发布" subtitle="当前运行地址包 + FINALIZED_VERIFIED 发布清单">
        <dl className="definition-grid">
          <div><dt>当前环境</dt><dd>{currentEnvironment}</dd></div>
          <div><dt>正式发布</dt><dd>{formalRelease}</dd></div>
          <div><dt>网络</dt><dd>{runtime?.config.chain.name ?? "—"}</dd></div>
          <div><dt>Commit</dt><dd className="mono">{runtime?.manifest?.source.commit ?? debugNotApplicable}</dd></div>
          <div><dt>Reference block</dt><dd>{runtime?.manifest?.referenceBlock.number ?? debugNotApplicable}</dd></div>
        </dl>
        <div className="check-list">
          {(trust?.checks ?? []).map((check) => <CheckRow key={check.id} check={check} />)}
        </div>
      </Panel>
      {runtime?.config.deployment.allowDebugAddresses ? (
        <Panel title="自定义调试地址" subtitle="只保存在当前页面内存；刷新后清空；永远标记为 DEBUG">
          <form className="form-grid" onSubmit={onVerify}>
            {(Object.keys(debug) as (keyof DebugAddressInput)[]).map((key) => (
              <label key={key}><span>{key}</span><input value={debug[key]} onChange={(event) => setDebug({ ...debug, [key]: event.currentTarget.value })} placeholder="0x…" autoComplete="off" spellCheck={false} /></label>
            ))}
            <button className="button warning" disabled={busy}>{busy ? "验证中…" : "验证调试地址"}</button>
          </form>
        </Panel>
      ) : null}
    </>
  );
}

export function MarketPage(props: {
  marketAddress: string;
  setMarketAddress: (value: string) => void;
  market: MarketSnapshot | null;
  marketRules: MarketRules | null;
  account: AccountSnapshot | null;
  protocol: ProtocolSnapshot | null;
  onLoad: (event: FormEvent<HTMLFormElement>) => void;
  onSelect: (market: Address, rules: MarketRules | null) => Promise<void>;
  indexerEnabled: boolean;
  indexerBasePath: string;
  metadataBasePath: string | null;
  permit2RelayBasePath: string | null;
  chainId: number;
  busy: boolean;
  client: CpredictClient | null;
  publicClient: PublicClient | null;
  wallet: ConnectedWallet | null;
  trust: TrustReport | null;
  paymentTokenSymbol: string;
  permit2Reusable: boolean;
  writeReady: boolean;
  execute: ExecuteTransaction;
}) {
  const displayState = props.market === null ? null : marketDisplayState(props.market);
  return (
    <>
      <Panel title="市场列表" subtitle="直接浏览已创建市场；目录来自只读 Indexer，进入后再读取 Vault 链上状态">
        <MarketCatalog
          enabled={props.indexerEnabled}
          indexerBasePath={props.indexerBasePath}
          metadataBasePath={props.metadataBasePath}
          chainId={props.chainId}
          wallet={props.wallet?.address ?? null}
          paymentTokenSymbol={props.paymentTokenSymbol}
          selectedMarket={props.market?.address ?? null}
          onOpen={(address, rules) => void props.onSelect(address, rules)}
        />
      </Panel>
      <Panel title="加载 Vault" subtitle="也可直接粘贴 Factory 创建的 Market Vault 地址">
        <form className="inline-form" onSubmit={props.onLoad}>
          <input value={props.marketAddress} onChange={(event) => props.setMarketAddress(event.currentTarget.value)} placeholder="0x MarketVault" autoComplete="off" spellCheck={false} />
          <button className="button primary" disabled={props.busy}>{props.busy ? "读取中…" : "读取链上状态"}</button>
        </form>
      </Panel>
      {props.market !== null ? (
        <>
          <div className="market-header">
            <div><p className="eyebrow">MARKET VAULT</p><h2>{props.marketRules?.question ?? short(props.market.address)} <StatusPill value={displayState?.label ?? "UNKNOWN"} /></h2><p className="mono market-vault-address">Vault {props.market.address} <button type="button" className="text-button" onClick={() => void copyText(props.market!.address)}>复制 Vault</button></p><p className="mono">rulesHash {shortHash(props.market.rulesHash)}</p></div>
            <div className="market-stat"><small>Pool</small><strong>{formatPaymentToken(props.market.totalPrincipal, props.paymentTokenSymbol)}</strong></div>
          </div>
          <BuyCard
            market={props.market}
            outcomeLabels={props.marketRules?.outcomes ?? null}
            account={props.account}
            client={props.client}
            publicClient={props.publicClient}
            wallet={props.wallet}
            trust={props.trust}
            paymentTokenSymbol={props.paymentTokenSymbol}
            permit2Mode={props.permit2Reusable && props.market.permit2Enabled}
            permit2RelayBasePath={props.permit2RelayBasePath}
            writeReady={props.writeReady}
            primaryBuyOpen={displayState?.primaryBuyOpen === true}
            busy={props.busy}
            execute={props.execute}
          />
          <Panel title="Market accounting">
            <dl className="definition-grid four">
              <div><dt>Outcomes</dt><dd>{props.market.outcomeCount}</dd></div>
              <div><dt>Close at</dt><dd>{formatTimestamp(props.market.closeAt)}</dd></div>
              <div><dt>Market cap</dt><dd>{formatPaymentToken(props.market.marketPrimaryCap, props.paymentTokenSymbol)}</dd></div>
              <div><dt>Creator bond</dt><dd>{formatPaymentToken(props.market.creatorBond, props.paymentTokenSymbol)}</dd></div>
              <div><dt>Permit2</dt><dd>{props.market.permit2Enabled ? "Enabled" : "Disabled"}</dd></div>
              <div><dt>Early bird</dt><dd>{props.market.earlyBirdEnabled ? "Enabled" : "Disabled"}</dd></div>
              <div><dt>Creator</dt><dd className="mono">{short(props.market.creator)}</dd></div>
              <div><dt>Wallet {props.paymentTokenSymbol}</dt><dd>{props.account === null ? "—" : formatPaymentToken(props.account.usdcBalance, props.paymentTokenSymbol)}</dd></div>
            </dl>
          </Panel>
        </>
      ) : <Empty title="尚未加载市场" detail="当前未伪造示例市场数据；请输入已部署 Vault 地址读取真实链上状态。" />}
    </>
  );
}

export function BuyCard({ market, outcomeLabels, account, client, publicClient, wallet, trust, paymentTokenSymbol, permit2Mode, permit2RelayBasePath, writeReady, primaryBuyOpen, busy, execute }: {
  market: MarketSnapshot;
  outcomeLabels: readonly string[] | null;
  account: AccountSnapshot | null;
  client: CpredictClient | null;
  publicClient: PublicClient | null;
  wallet: ConnectedWallet | null;
  trust: TrustReport | null;
  paymentTokenSymbol: string;
  permit2Mode: boolean;
  permit2RelayBasePath: string | null;
  writeReady: boolean;
  primaryBuyOpen: boolean;
  busy: boolean;
  execute: ExecuteTransaction;
}) {
  const [outcome, setOutcome] = useState("0");
  const [shares, setShares] = useState("1");
  const [slippage, setSlippage] = useState("0");
  const [formError, setFormError] = useState("");
  const [vaultAllowance, setVaultAllowance] = useState(
    account?.vaultAllowance ?? null,
  );
  const primaryWriteReady = writeReady && primaryBuyOpen;

  useEffect(
    () => setVaultAllowance(account?.vaultAllowance ?? null),
    [account?.vaultAllowance, market.address, wallet?.address],
  );

  function paymentAmounts() {
    const units = parsePositive(shares, 6, "份额");
    const slippageBps = BigInt(slippage);
    if (slippageBps < 0n || slippageBps > 1_000n) throw new RangeError("滑点必须在 0–1000 bps");
    return {
      units,
      maximumPayment: (units * (10_000n + slippageBps) + 9_999n) / 10_000n,
    };
  }

  async function approveVault() {
    setFormError("");
    try {
      if (client === null || trust?.addresses === null || trust?.addresses === undefined) {
        throw new Error("协议写入上下文尚未就绪");
      }
      const { maximumPayment } = paymentAmounts();
      const result = await execute(
        `Approve vault ${paymentTokenSymbol}`,
        () => client.approvePaymentToken(trust.addresses!.usdc, market.address, maximumPayment),
      );
      if (result !== null) setVaultAllowance(maximumPayment);
      return result;
    } catch (error: unknown) {
      setFormError(messageOf(error));
      return null;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    try {
      if (!primaryBuyOpen) throw new Error("市场已截止，一级购买已关闭");
      if (client === null || wallet === null || trust?.addresses === null || trust?.addresses === undefined) {
        throw new Error("钱包或协议写入上下文尚未就绪");
      }
      const { units, maximumPayment } = paymentAmounts();
      const outcomeId = BigInt(outcome);
      if (outcomeId < 0n || outcomeId >= BigInt(market.outcomeCount)) throw new RangeError("outcome 越界");
      if (!permit2Mode) {
        const needsAuthorization = authorizationRequired(
          vaultAllowance,
          maximumPayment,
        );
        if (needsAuthorization) {
          const approval = await approveVault();
          if (approval === null) return;
        }
        const deadline = transactionDeadline();
        const result = await execute("Primary buy", () => client.buy({ vault: market.address, outcomeId, desiredUnits: units, minimumUnits: units, maximumPayment, deadline }));
        if (result !== null) {
          setVaultAllowance(
            needsAuthorization
              ? 0n
              : (vaultAllowance ?? maximumPayment) - maximumPayment,
          );
        }
        return;
      }
      const deadline = transactionDeadline();
      const nonce = randomUint256();
      const permit = { permitted: { token: trust.addresses.usdc, amount: maximumPayment }, nonce, deadline };
      const typed = buildBuyPermit2TypedData(trust.addresses.permit2, permit, {
        owner: wallet.address,
        vault: market.address,
        selector: BUY_WITH_PERMIT2_SELECTOR,
        outcomeId,
        desiredUnits: units,
        minUnits: units,
        maxPayment: maximumPayment,
        callDeadline: deadline,
        chainId: BigInt(ARBITRUM_SEPOLIA_CHAIN_ID),
      });
      const signature = await wallet.walletClient.signTypedData({ account: wallet.account, ...typed });
      const relayInput = {
        chainId: BigInt(ARBITRUM_SEPOLIA_CHAIN_ID),
        factory: trust.addresses.contracts.factory,
        permit2: trust.addresses.permit2,
        vault: market.address,
        owner: wallet.address,
        outcomeId,
        desiredUnits: units,
        minimumUnits: units,
        maximumPayment,
        deadline,
        permit,
        signature,
      } as const;
      if (permit2RelayBasePath !== null) {
        if (publicClient === null) throw new Error("relayer 链上确认客户端尚未就绪");
        const relayer = createHttpPermit2BuyRelayer({
          baseUrl: new URL(permit2RelayBasePath, globalThis.location.origin),
        });
        await execute("Permit2 relayed primary buy", async () => {
          const submission = await relayer.relayBuy(relayInput);
          const receipt = await publicClient.waitForTransactionReceipt({
            hash: submission.transactionHash,
            confirmations: 1,
          });
          if (receipt.status !== "success") {
            throw new Error(`relayed transaction reverted: ${submission.transactionHash}`);
          }
          return {
            hash: submission.transactionHash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
          };
        });
      } else {
        await execute("Permit2 primary buy", () => client.buyWithPermit2(relayInput));
      }
    } catch (error: unknown) {
      setFormError(messageOf(error));
    }
  }

  let buyAuthorizationRequired = true;
  try {
    const { maximumPayment } = paymentAmounts();
    buyAuthorizationRequired = authorizationRequired(
      permit2Mode ? maxUint256 : vaultAllowance,
      maximumPayment,
    );
  } catch {
    // Invalid values are surfaced on submit without breaking the form render.
  }

  return (
    <Panel title="一级购买" subtitle={`1 整份 = 1,000,000 units；交易模式由页头 Permit2 开关控制`}>
      {!primaryBuyOpen ? <p className="callout danger">该市场已截止，一级购买已关闭；请前往“结算与作废”。</p> : null}
      <form className="buy-form" onSubmit={(event) => void submit(event)}>
        <label><span>购买结果</span><select value={outcome} onChange={(event) => setOutcome(event.currentTarget.value)}>{Array.from({ length: market.outcomeCount }, (_, index) => <option value={index} key={index}>{outcomeLabels?.[index] ?? `结果 ${index + 1}`}</option>)}</select></label>
        <label><span>Shares</span><input inputMode="decimal" value={shares} onChange={(event) => setShares(event.currentTarget.value)} /></label>
        <label><span>Max slippage (bps)</span><input inputMode="numeric" value={slippage} onChange={(event) => setSlippage(event.currentTarget.value)} /></label>
        <button className="button primary wide" disabled={!primaryWriteReady || busy}>{busy ? "处理中…" : !primaryBuyOpen ? "已截止，待结算" : writeReady ? permit2Mode ? "签名并购买" : buyAuthorizationRequired ? "精确授权并模拟购买" : "模拟并购买" : "写操作已锁定"}</button>
      </form>
      {formError ? <p className="form-error" role="alert">{formError}</p> : null}
      {!permit2Mode ? (
        <PrimaryAllowanceRow
          label="Vault allowance"
          allowance={vaultAllowance}
          paymentTokenSymbol={paymentTokenSymbol}
          actionLabel="精确授权"
          disabled={!primaryWriteReady || busy}
          onApprove={() => void approveVault()}
        />
      ) : (
        <p className="callout">页头已开启可复用 Permit2 授权；每次购买仍会签署绑定 chainId、Vault、outcome、金额、nonce 与 deadline 的一次性 witness，页面不保存签名。{permit2RelayBasePath === null ? " 当前由钱包继续发送链上交易。" : " Relayer 已配置，本次 witness 签名后由服务代发，不再弹出第二次交易签名。"}</p>
      )}
    </Panel>
  );
}

export function Permit2AuthorizationSwitch(props: {
  allowance: bigint | null;
  marketEnabled: boolean | null;
  busy: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const reusable = props.allowance === maxUint256;
  const limited = props.allowance !== null && props.allowance > 0n && !reusable;
  const stateLabel = props.busy
    ? "处理中"
    : reusable
      ? props.marketEnabled === false ? "已授权 · 当前市场不可用" : "可复用"
      : limited ? "有限额" : "关闭";
  const action = reusable
    ? "撤销 Permit2 可复用授权"
    : "开启 Permit2 可复用授权（将支付币 allowance 设置为最大值）";
  return (
    <button
      type="button"
      className="permit2-switch"
      role="switch"
      aria-checked={reusable}
      aria-label={`${action}，当前状态：${stateLabel}`}
      title={limited ? "检测到有限额授权；开启后将改为可复用额度" : action}
      disabled={props.disabled || props.busy}
      onClick={props.onToggle}
    >
      <span className="switch-track" aria-hidden="true"><span /></span>
      <span className="switch-copy"><strong>Permit2</strong><small>{stateLabel}</small></span>
    </button>
  );
}

export function PrimaryAllowanceRow(props: {
  label: string;
  allowance: bigint | null;
  paymentTokenSymbol: string;
  actionLabel: string;
  disabled: boolean;
  onApprove: () => void;
}) {
  return (
    <div className="allowance-row">
      <span>{props.label}</span>
      <strong>{props.allowance === null ? "—" : formatPaymentToken(props.allowance, props.paymentTokenSymbol)}</strong>
      <button className="text-button" disabled={props.disabled} onClick={props.onApprove}>{props.actionLabel}</button>
    </div>
  );
}

function CreatePage({ writeReady, trust, client, wallet, account, protocol, paymentTokenSymbol, metadataBasePath, busy, execute, onMarketCreated }: { writeReady: boolean; trust: TrustReport | null; client: CpredictClient | null; wallet: ConnectedWallet | null; account: AccountSnapshot | null; protocol: ProtocolSnapshot | null; paymentTokenSymbol: string; metadataBasePath: string | null; busy: boolean; execute: ExecuteTransaction; onMarketCreated: (result: CreateMarketResult) => Promise<void> }) {
  const addresses = trust?.addresses;
  return <Panel title="创建市场" subtitle="问题、结果和判定依据会由钱包签名并永久锁定">{client === null || wallet === null || addresses === null || addresses === undefined || protocol === null || metadataBasePath === null ? <Empty title="创建上下文不足" detail="需要通过部署验证、连接钱包，并加载 ProtocolConfig 与 Metadata 服务。" /> : <CreateMarketForm client={client} factory={addresses.contracts.factory} factoryAllowance={account?.factoryAllowance ?? null} paymentToken={addresses.usdc} paymentTokenSymbol={paymentTokenSymbol} creator={wallet.address} creationFee={protocol.creationFee} maxFullMarketCap={protocol.maxFullMarketCap} maxCloneMarketCap={protocol.maxCloneMarketCap} maxPerUserPrimaryCap={protocol.maxPerUserPrimaryCap} maxCreatorRakeBps={protocol.maxCreatorRakeBps} maxCreatorC2CFeeBps={protocol.maxCreatorC2CFeeBps} metadataBasePath={metadataBasePath} wallet={wallet} writeReady={writeReady} busy={busy} execute={execute} onMarketCreated={onMarketCreated} />}<p className="callout">建议试运行仅开放 Full；Clone 需要甲方显式接受 delegatecall 风险和 500 {paymentTokenSymbol} 硬上限。</p></Panel>;
}

export function PositionsPage({ market, account, wallet, indexerEnabled, indexerBasePath, chainId, targetBlock, onOpenMarket }: { market: MarketSnapshot | null; account: AccountSnapshot | null; wallet: ConnectedWallet | null; indexerEnabled: boolean; indexerBasePath: string; chainId: number; targetBlock: bigint | null; onOpenMarket: (market: Address) => void }) {
  const livePositions = market === null || account === null
    ? []
    : account.positions.map(({ balance, outcomeId }) => ({
        vault: market.address,
        outcomeId: BigInt(outcomeId),
        balance,
      }));
  return <><Panel title="全部持仓" subtitle={wallet === null ? "连接钱包后汇总所有市场" : short(wallet.address)}><WalletPositionsPanel enabled={indexerEnabled} indexerBasePath={indexerBasePath} chainId={chainId} wallet={wallet?.address ?? null} livePositions={livePositions} targetBlock={targetBlock} onOpenMarket={onOpenMarket} /></Panel><Panel title="当前市场持仓" subtitle={market === null ? "尚未选择市场" : short(market.address)}>{market === null || account === null ? <Empty title="暂无当前市场快照" detail="从上方持仓或市场列表打开一个市场。" /> : <div className="position-grid">{account.positions.map(({ balance, outcomeId }) => <div key={outcomeId}><small>结果 {outcomeId + 1}</small><strong>{formatShareUnits(balance)}</strong></div>)}</div>}</Panel></>;
}

export function MarketplacePage({ writeReady, market, account, trust, client, paymentTokenSymbol, indexerEnabled, indexerBasePath, chainId, selectedListing, refreshVersion, onSelectListing, onListingChange }: { writeReady: boolean; market: MarketSnapshot | null; account: AccountSnapshot | null; trust: TrustReport | null; client: CpredictClient | null; paymentTokenSymbol: string; indexerEnabled: boolean; indexerBasePath: string; chainId: number; selectedListing: MarketplaceListingSelection | null; refreshVersion: number; onSelectListing: (listing: IndexedListing) => void; onListingChange: (listing: MarketplaceListingSelection | null, result: TransactionResult) => void }) {
  const addresses = trust?.addresses;
  const selectedListingForMarket = market !== null && selectedListing !== null && selectedListing.vault.toLowerCase() === market.address.toLowerCase() ? selectedListing : null;
  return <><Panel title="活跃 C2C 挂单" subtitle="选择挂单后自动加载市场、价格和剩余数量"><ListingsPanel enabled={indexerEnabled} indexerBasePath={indexerBasePath} chainId={chainId} paymentTokenSymbol={paymentTokenSymbol} selectedListingId={selectedListing?.listingId ?? null} refreshVersion={refreshVersion} onSelectListing={onSelectListing} /></Panel><Panel title="固定价 C2C" subtitle={market === null ? "尚未选择市场" : `当前 Vault ${short(market.address)}`}>{market !== null && addresses !== null && addresses !== undefined && client !== null && writeReady ? <div className="embedded-example"><MarketplacePanel client={client} paymentToken={addresses.usdc} paymentTokenSymbol={paymentTokenSymbol} vault={market.address} marketplace={addresses.contracts.marketplace} paymentTokenAllowance={account?.marketplaceAllowance ?? null} shareEscrowApproved={account?.marketplaceApproved ?? null} selectedListing={selectedListingForMarket} onListingChange={onListingChange} /></div> : <Empty title={market === null ? "先选择市场" : "C2C 写操作已锁定"} detail="部署、钱包、网络与 Vault 上下文通过后开放 allowance listing/fill/cancel；Permit2 fill 由 SDK 提供。" />}</Panel><Panel title="安全参数"><dl className="definition-grid"><div><dt>Marketplace</dt><dd className="mono">{addresses ? short(addresses.contracts.marketplace) : "—"}</dd></div><div><dt>Fill protection</dt><dd>onchain listing / exact units / maxGross / deadline</dd></div></dl></Panel></>;
}

function SettlementPage({ writeReady, market, wallet, client, publicClient, execute, evidenceUploader, indexerEnabled, indexerBasePath, metadataBasePath, chainId, onSelectMarket }: { writeReady: boolean; market: MarketSnapshot | null; wallet: ConnectedWallet | null; client: CpredictClient | null; publicClient: PublicClient | null; execute: ExecuteTransaction; evidenceUploader: CanonicalEvidenceUploader | undefined; indexerEnabled: boolean; indexerBasePath: string; metadataBasePath: string | null; chainId: number; onSelectMarket: (market: Address, rules: MarketRules | null) => Promise<void> }) {
  const queue = <Panel title="待结算市场" subtitle="Indexer 按截止时间发现候选市场；进入后再次读取 Vault 链上状态"><SettlementMarketCatalog enabled={indexerEnabled} indexerBasePath={indexerBasePath} metadataBasePath={metadataBasePath} chainId={chainId} wallet={wallet?.address ?? null} selectedMarket={market?.address ?? null} publicClient={publicClient} onOpen={(address, rules) => void onSelectMarket(address, rules)} /></Panel>;
  if (market === null) return <>{queue}<Empty title="请选择待结算市场" detail="从上方队列选择市场后显示当前钱包可执行的结算或作废操作。" /></>;
  if (wallet === null || client === null) return <>{queue}<Empty title="连接钱包以继续" detail="市场目录可以只读浏览；连接钱包后才会按角色开放结算操作。" /></>;
  const creator = market.creator.toLowerCase() === wallet.address.toLowerCase();
  return <>{queue}<Panel title="结算证据与终局" subtitle={`当前 Vault ${short(market.address)} · canonical UTF-8 → SHA-256 → deterministic CID`}><div className="embedded-example">{writeReady ? <MarketLifecyclePanel client={client} vault={market.address} outcomeCount={market.outcomeCount} creatorMode={creator} uploadCanonicalEvidence={evidenceUploader} /> : <Empty title="写操作已锁定" detail="可读市场，但不满足正式部署/钱包/网络门禁。" />}</div></Panel><Panel title="领取、退款与 permissionless 维护" subtitle="claimFor 始终支付固定 owner，调用人不能重定向"><div className="operation-grid"><button disabled={!writeReady} onClick={() => void execute("Timeout void", () => client.voidAfterDeadline(market.address))}>Permissionless timeout void</button><button disabled={!writeReady} onClick={() => void execute("Claim winnings", () => client.claimWinner(market.address, wallet.address))}>Claim winnings</button><button disabled={!writeReady} onClick={() => void execute("Refund principal", () => client.refund(market.address, wallet.address))}>Refund principal</button><button disabled={!writeReady} onClick={() => void execute("Claim early bird", () => client.claimEarlyBird(market.address, wallet.address))}>Claim early bird</button><button disabled={!writeReady} onClick={() => void execute("Claim timeout bonus", () => client.claimTimeoutBonus(market.address, wallet.address))}>Claim timeout bonus</button></div><p className="callout danger">Demo 不暴露管理员调用，也不会替 Creator 自动选择结果。Creator 终局必须人工复核锁定规则。</p></Panel></>;
}

function ReceiptsPage({ activity, explorerOrigin, paymentTokenSymbol, wallet, indexerEnabled, indexerBasePath, chainId, onOpenMarket }: { activity: ActivityItem[]; explorerOrigin: string; paymentTokenSymbol: string; wallet: ConnectedWallet | null; indexerEnabled: boolean; indexerBasePath: string; chainId: number; onOpenMarket: (market: Address) => void }) {
  return <><Panel title="链上活动" subtitle="由 Indexer 重建；刷新或换设备后仍可按当前钱包查看"><WalletActivityPanel enabled={indexerEnabled} indexerBasePath={indexerBasePath} chainId={chainId} wallet={wallet?.address ?? null} explorerOrigin={explorerOrigin} paymentTokenSymbol={paymentTokenSymbol} onOpenMarket={onOpenMarket} /></Panel><Panel title="本会话回执" subtitle="用于显示当前页面的模拟、失败和待确认过程；成功事实以链上事件为准"><div className="receipt-list">{activity.map((item) => <ActivityLine key={item.id} item={item} explorerOrigin={explorerOrigin} />)}</div></Panel></>;
}

export function Inspector({ trust, runtime, market, wallet }: { trust: TrustReport | null; runtime: LoadedRuntime | null; market: MarketSnapshot | null; wallet: ConnectedWallet | null }) {
  const rows: readonly [string, string][] = [
    ["Chain", `${runtime?.config.chain.name ?? "—"} / ${runtime?.config.chain.id ?? "—"}`],
    ["Wallet", wallet === null ? "—" : short(wallet.address)],
    ["Factory", trust?.addresses ? short(trust.addresses.contracts.factory) : "—"],
    ["Marketplace", trust?.addresses ? short(trust.addresses.contracts.marketplace) : "—"],
    [trust?.paymentToken.symbol ?? "Payment token", trust?.addresses ? short(trust.addresses.usdc) : "—"],
    ["Resolution window", formatResolutionWindow(trust?.resolutionWindowSeconds)],
    ["Permit2", trust?.addresses ? short(trust.addresses.permit2) : "—"],
    ["Market", market === null ? "—" : short(market.address)],
  ];
  return <section className="inspector"><div className="panel-heading"><div><p className="eyebrow">LIVE CONTEXT</p><h3>地址检查器</h3></div><span className="status-dot" data-level={trust?.level ?? "blocked"} /></div><div className="inspector-rows">{rows.map(([key, value]) => <div key={key}><span>{key}</span><strong className="mono">{value}</strong><button type="button" aria-label={`复制 ${key}`} onClick={() => void copyText(value)}>▣</button></div>)}</div><div className="inspector-note"><strong>Write gate</strong><p>{trust?.writeEnabled ? trust.level === "debug" ? "DEBUG enabled" : "VERIFIED enabled" : "LOCKED"}</p></div></section>;
}

export function DeploymentDrawer({ open, onClose, runtime, trust, debug, setDebug, onVerify, busy }: {
  open: boolean;
  onClose: () => void;
  runtime: LoadedRuntime | null;
  trust: TrustReport | null;
  debug: DebugAddressInput;
  setDebug: (value: DebugAddressInput) => void;
  onVerify: (event: FormEvent<HTMLFormElement>) => void;
  busy: boolean;
}) {
  if (!open) return null;
  return <div className="runtime-drawer-layer"><button type="button" className="runtime-drawer-backdrop" aria-label="关闭部署验证抽屉" onClick={onClose} /><aside id="deployment-drawer" className="runtime-drawer deployment-drawer" role="dialog" aria-modal="true" aria-label="部署验证"><div className="runtime-drawer-header"><div><p className="eyebrow">DEPLOYMENT</p><h2>部署验证</h2></div><button type="button" className="drawer-close" aria-label="关闭部署验证抽屉" onClick={onClose}>×</button></div><div className="runtime-drawer-content"><DeploymentPage runtime={runtime} trust={trust} debug={debug} setDebug={setDebug} onVerify={onVerify} busy={busy} /></div></aside></div>;
}

export function DeploymentVerificationToast({ toast, onClose }: {
  toast: DeploymentToast | null;
  onClose: () => void;
}) {
  if (toast === null) return null;
  const dismissible = toast.state === "error";
  return (
    <aside
      className={`deployment-toast ${toast.state}`}
      role={dismissible ? "alert" : "status"}
      aria-live={dismissible ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <span className="deployment-toast-indicator" aria-hidden="true" />
      <div><strong>{toast.title}</strong><p>{toast.detail}</p></div>
      {dismissible ? <button type="button" aria-label="关闭部署验证提示" onClick={onClose}>×</button> : null}
    </aside>
  );
}

export function RuntimeDrawer({ open, onClose, trust, runtime, market, wallet }: {
  open: boolean;
  onClose: () => void;
  trust: TrustReport | null;
  runtime: LoadedRuntime | null;
  market: MarketSnapshot | null;
  wallet: ConnectedWallet | null;
}) {
  if (!open) return null;
  return <div className="runtime-drawer-layer"><button type="button" className="runtime-drawer-backdrop" aria-label="关闭运行状态抽屉" onClick={onClose} /><aside id="runtime-drawer" className="runtime-drawer" role="dialog" aria-modal="true" aria-label="运行状态"><div className="runtime-drawer-header"><div><p className="eyebrow">RUNTIME</p><h2>运行状态</h2></div><button type="button" className="drawer-close" aria-label="关闭运行状态抽屉" onClick={onClose}>×</button></div><div className="runtime-drawer-content"><Inspector trust={trust} runtime={runtime} market={market} wallet={wallet} /></div></aside></div>;
}

export function ActivityDrawer({ open, onClose, activity, explorerOrigin }: {
  open: boolean;
  onClose: () => void;
  activity: ActivityItem[];
  explorerOrigin: string;
}) {
  if (!open) return null;
  return <div className="runtime-drawer-layer"><button type="button" className="runtime-drawer-backdrop" aria-label="关闭事件与回执抽屉" onClick={onClose} /><aside id="activity-drawer" className="runtime-drawer activity-drawer" role="dialog" aria-modal="true" aria-label="事件与回执"><div className="runtime-drawer-header"><div><p className="eyebrow">SESSION ACTIVITY</p><h2>事件与回执</h2></div><div className="drawer-header-actions"><span>{activity.length} 条</span><button type="button" className="drawer-close" aria-label="关闭事件与回执抽屉" onClick={onClose}>×</button></div></div><div className="runtime-drawer-content"><section className="activity-log" aria-label="本会话事件列表"><div className="activity-table">{activity.map((item) => <ActivityLine key={item.id} item={item} explorerOrigin={explorerOrigin} compact />)}</div></section></div></aside></div>;
}

export function formatResolutionWindow(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds % 60 === 0) return `${seconds / 60} 分钟 / ${seconds} 秒`;
  return `${seconds} 秒`;
}

export function ActivityLine({ item, explorerOrigin, compact = false }: { item: ActivityItem; explorerOrigin: string; compact?: boolean }) {
  const href = item.hash ? `${explorerOrigin}/tx/${item.hash}` : null;
  return <div className={`activity-line ${item.level}`}><time>{item.at.toLocaleTimeString("zh-CN", { hour12: false })}</time><span className="status-dot" /><div><strong>{item.label}</strong>{compact ? null : <p>{item.detail}</p>}</div><code>{compact ? item.detail : item.hash ? shortHash(item.hash) : "LOCAL"}</code><div className="activity-actions">{item.market === undefined ? null : <button type="button" className="text-button" aria-label="复制 Market Vault" title="复制 Vault" onClick={() => void copyText(item.market!)}>复制</button>}{href === null ? null : <a href={href} target="_blank" rel="noopener noreferrer" aria-label="在区块浏览器查看交易">↗</a>}</div></div>;
}

function Panel({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) {
  return <section className="panel"><div className="panel-heading"><div><h3>{title}</h3>{subtitle ? <p>{subtitle}</p> : null}</div>{action}</div>{children}</section>;
}

function StatusCard({ label, value, hint, state }: { label: string; value: string; hint: string; state: string }) {
  return <div className={`status-card ${state}`}><div><span>{label}</span><i className="status-dot" /></div><strong>{value}</strong><small>{hint}</small></div>;
}

function deploymentStatusLabel(state: "verified" | "debug" | "blocked" | "checking") {
  return state === "verified" ? "验证通过" : state === "debug" ? "调试验证通过" : state === "checking" ? "正在检查" : "写操作已锁定";
}

export function deploymentIndicatorState(state: "verified" | "debug" | "blocked" | "checking"): "running" | "error" | "success" {
  return state === "checking" ? "running" : state === "blocked" ? "error" : "success";
}

function StatusPill({ value }: { value: string }) { return <span className="status-pill">{value}</span>; }

function CheckRow({ check }: { check: TrustCheck }) {
  return <div className="check-row"><span className={`status-dot ${check.state}`} /><strong>{check.label}</strong><code>{check.detail}</code></div>;
}

function Empty({ title, detail }: { title: string; detail: string }) { return <div className="empty"><span>◇</span><strong>{title}</strong><p>{detail}</p></div>; }

function Brand({ compact = false }: { compact?: boolean }) { return <div className={compact ? "brand compact" : "brand"}><span>CP</span><div><strong>Cpredict</strong>{compact ? null : <small>合约验证控制台</small>}</div></div>; }

function useHashRoute(): [Route, (route: Route, market?: Address) => void, Address | null] {
  const [hash, setHash] = useState(globalThis.location?.hash ?? "");
  useEffect(() => {
    const update = () => setHash(globalThis.location.hash);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const setRoute = (next: Route, market?: Address) => {
    const nextHash = market === undefined ? `#/${next}` : `#/${next}/${market}`;
    globalThis.location.hash = nextHash;
    setHash(nextHash);
  };
  return [parseRoute(hash), setRoute, parseMarketRoute(hash)];
}

function parseRoute(hash: string | undefined): Route {
  const value = (hash ?? "").replace(/^#\/?/, "").split("/")[0] as Route;
  return NAV_ITEMS.some((item) => item.route === value) ? value : "overview";
}

function parseMarketRoute(hash: string | undefined): Address | null {
  const [route, candidate] = (hash ?? "").replace(/^#\/?/, "").split("/");
  return (route === "markets" || route === "settlement") && candidate !== undefined && isAddress(candidate)
    ? getAddress(candidate)
    : null;
}

export function deploymentToastForReport(report: TrustReport): DeploymentToast {
  if (report.writeEnabled) {
    return {
      state: "success",
      title: report.level === "debug" ? "部署验证通过（DEBUG）" : "部署验证通过",
      detail: trustSummary(report),
    };
  }
  return { state: "error", title: "部署验证未通过", detail: trustSummary(report) };
}

async function refreshTrust(client: PublicClient, runtime: LoadedRuntime, setTrust: (report: TrustReport) => void, setBusy: (value: boolean) => void, setActivity: React.Dispatch<React.SetStateAction<ActivityItem[]>>, setToast: (toast: DeploymentToast) => void) {
  setBusy(true);
  setToast(DEPLOYMENT_CHECKING_TOAST);
  try {
    const report = runtime.debugAddresses === null
      ? await verifyManifest(client, runtime.manifest, runtime.config.paymentToken)
      : await verifyDebugAddresses(client, runtime.debugAddresses, runtime.config.paymentToken);
    setTrust(report);
    setToast(deploymentToastForReport(report));
    push(setActivity, report.level === "verified" ? "success" : "warning", "Deployment verification", report.level === "verified" ? `${report.checks.length} checks passed` : trustSummary(report));
  } catch (error: unknown) {
    const detail = messageOf(error);
    setToast({ state: "error", title: "部署验证失败", detail });
    push(setActivity, "error", "Deployment verification failed", detail);
  } finally {
    setBusy(false);
  }
}

function trustSummary(report: TrustReport | null): string {
  if (report === null) return "等待部署验证";
  const failed = report.checks.filter((check) => check.state === "fail");
  return failed.length === 0 ? `${report.checks.length} 项检查通过` : `${failed.length} 项检查失败：${failed[0]?.label ?? "unknown"}`;
}

function push(setActivity: React.Dispatch<React.SetStateAction<ActivityItem[]>>, level: ActivityLevel, label: string, detail: string, hash?: `0x${string}`, market?: Address) {
  setActivity((items) => [{ id: items.reduce((max, item) => Math.max(max, item.id), 0) + 1, at: new Date(), level, label, detail, ...(hash === undefined ? {} : { hash }), ...(market === undefined ? {} : { market }) }, ...items].slice(0, 100));
}

function parsePositive(value: string, decimals: number, label: string): bigint {
  const parsed = parseUnits(value.trim(), decimals);
  if (parsed <= 0n) throw new RangeError(`${label}必须大于 0`);
  return parsed;
}

function randomUint256(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return BigInt(`0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`);
}

function short(value: string): string { return value.length <= 14 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`; }
function shortHash(value: string): string { return value.length <= 20 ? value : `${value.slice(0, 12)}…${value.slice(-8)}`; }
function formatTimestamp(value: bigint): string { return new Date(Number(value) * 1000).toLocaleString("zh-CN", { hour12: false }); }
function formatEtherCompact(value: bigint): string { return `${Number(value) / 1e18 < 0.0001 ? "<0.0001" : (Number(value) / 1e18).toFixed(4)} ETH`; }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : "unknown error"; }
async function copyText(value: string): Promise<void> { if (value !== "—") await navigator.clipboard.writeText(value); }

function makeEvidenceUploader(runtime: LoadedRuntime): CanonicalEvidenceUploader | undefined {
  if (!runtime.config.evidence.uploadEnabled) return undefined;
  return async (request) => {
    const body = new Uint8Array(request.canonicalBytes.byteLength);
    body.set(request.canonicalBytes);
    const response = await fetch(runtime.config.evidence.endpointPath, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: {
        "content-type": request.mediaType,
        "x-cpredict-evidence-hash": request.evidenceHash,
        "x-cpredict-expected-uri": request.expectedUri,
      },
      body: body.buffer,
    });
    if (!response.ok) throw new Error(`evidence uploader HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (typeof value !== "object" || value === null || !("uri" in value) || typeof (value as { uri?: unknown }).uri !== "string") {
      throw new Error("evidence uploader returned an invalid response");
    }
    return { uri: (value as { uri: string }).uri };
  };
}
