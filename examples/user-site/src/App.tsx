import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import {
  CircleHelp,
  Wallet,
  ChartNoAxesCombined,
  Compass,
  History,
  Layers3,
  PlusSquare,
  Trophy,
  Menu,
} from "lucide-react";
import { z } from "zod";
import {
  siteConfigSchema,
  type Environment,
} from "../../../offchain/app-core/src/contracts.js";
import { snapshotSchema } from "../../../offchain/app-core/src/ledger-contracts.js";
import { WalletProvider, useSession } from "./wallets.js";
import { OperationProvider } from "./operations.js";
import {
  Button,
  Empty,
  ErrorNotice,
  Loading,
  Modal,
  Notice,
  shortAddress,
} from "./ui.js";
import { useState } from "react";
const Markets = lazy(() =>
    import("./pages/Markets.js").then((m) => ({ default: m.MarketsPage })),
  ),
  Market = lazy(() =>
    import("./pages/MarketDetail.js").then((m) => ({
      default: m.MarketDetailPage,
    })),
  ),
  Assets = lazy(() =>
    import("./pages/Assets.js").then((m) => ({ default: m.AssetsPage })),
  ),
  Entitlements = lazy(() =>
    import("./pages/Entitlements.js").then((m) => ({
      default: m.EntitlementsPage,
    })),
  ),
  HistoryPage = lazy(() =>
    import("./pages/History.js").then((m) => ({ default: m.HistoryPage })),
  ),
  Help = lazy(() =>
    import("./pages/Help.js").then((m) => ({ default: m.HelpPage })),
  ),
  Creator = lazy(() =>
    import("./pages/Creator.js").then((m) => ({ default: m.CreatorPage })),
  ),
  Create = lazy(() =>
    import("./pages/Creator.js").then((m) => ({ default: m.CreateMarketPage })),
  ),
  Manage = lazy(() =>
    import("./pages/Creator.js").then((m) => ({
      default: m.CreatorMarketPage,
    })),
  ),
  Leaderboard = lazy(() =>
    import("./pages/Reports.js").then((m) => ({ default: m.LeaderboardPage })),
  ),
  Ops = lazy(() =>
    import("./pages/Reports.js").then((m) => ({ default: m.OpsPage })),
  ),
  Feedback = lazy(() =>
    import("./pages/Reports.js").then((m) => ({ default: m.FeedbackPage })),
  );
export const createSiteQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false, gcTime: 300000 },
      mutations: { retry: false },
    },
  });
export function App() {
  const [cache] = useState(createSiteQueryClient);
  return (
    <Boundary>
      <QueryClientProvider client={cache}>
        <BrowserRouter>
          <Configuration />
        </BrowserRouter>
      </QueryClientProvider>
    </Boundary>
  );
}
function Configuration() {
  const config = useQuery({
    queryKey: ["site-config"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/site-config.json", {
        signal,
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw new Error("config unavailable");
      return siteConfigSchema.parse(await response.json());
    },
    staleTime: Infinity,
    retry: false,
  });
  if (config.isPending) return <Loading label="正在读取环境配置" />;
  if (config.error)
    return (
      <main>
        <Empty
          title="暂时无法读取测试环境"
          action={
            <Button onClick={() => void config.refetch()}>重新读取</Button>
          }
        >
          环境配置验证失败，交易入口保持关闭。
        </Empty>
      </main>
    );
  const c = config.data;
  if (!c.environments.length)
    return (
      <main className="configuration-empty">
        <Link className="brand" to="/">
          <span className="brand-mark">CP</span>Cpredict
        </Link>
        <Empty title="公开测试站尚未开放">
          需要先配置独立的测试部署、钱包服务和代付预算。当前没有可交易的环境。
        </Empty>
        <Notice>
          ctUSD 与测试网 USDC
          均为测试资产。旧测试站及旧资产退出入口应由运营配置后保留。
        </Notice>
        <a href="/third-party/index.html">第三方软件声明与许可</a>
      </main>
    );
  const defaultId = c.defaultEnvironment ?? c.environments[0]!.id;
  return (
    <Routes>
      <Route
        path="/"
        element={<Navigate replace to={`/${defaultId}/markets`} />}
      />
      <Route
        path="/:environment"
        element={<EnvironmentBoundary environments={c.environments} />}
      >
        <Route index element={<Navigate replace to="markets" />} />
        <Route path="markets" element={<Markets />} />
        <Route path="markets/:market" element={<Market />} />
        <Route path="assets" element={<Assets />} />
        <Route path="entitlements" element={<Entitlements />} />
        <Route path="history" element={<HistoryPage />} />
        <Route path="creator" element={<Creator />} />
        <Route path="creator/new" element={<Create />} />
        <Route path="creator/:market" element={<Manage />} />
        <Route path="leaderboard" element={<Leaderboard />} />
        <Route path="ops" element={<Ops />} />
        <Route path="help" element={<Help />} />
        <Route path="feedback" element={<Feedback />} />
        <Route
          path="*"
          element={
            <Empty
              title="页面不存在"
              action={<Link to="../markets">返回市场</Link>}
            />
          }
        />
      </Route>
      <Route
        path="*"
        element={<Navigate replace to={`/${defaultId}/markets`} />}
      />
    </Routes>
  );
}
function EnvironmentBoundary({
  environments,
}: {
  environments: Environment[];
}) {
  const params = useParams(),
    env = environments.find((e) => e.id === params.environment);
  if (!env)
    return (
      <main>
        <Empty title="测试环境不存在" action={<Link to="/">返回入口</Link>}>
          请核对链接中的环境名称。
        </Empty>
      </main>
    );
  return (
    <WalletProvider
      key={`${env.id}:${env.deployment.manifestHash}`}
      environment={env}
    >
      <OperationProvider>
        <SiteLayout environments={environments} />
      </OperationProvider>
    </WalletProvider>
  );
}
export function SiteLayout({ environments }: { environments: Environment[] }) {
  const session = useSession(),
    env = session.api.environment,
    [menu, setMenu] = useState(false),
    location = useLocation(),
    main = useRef<HTMLElement>(null);
  useEffect(() => {
    setMenu(false);
    main.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [location.pathname]);
  useTelemetry();
  const links = [
    { path: "markets", label: "探索市场", icon: Compass },
    { path: "assets", label: "我的资产", icon: Wallet },
    { path: "entitlements", label: "持仓与权益", icon: Layers3 },
    { path: "history", label: "交易历史", icon: History },
    { path: "creator", label: "创作者中心", icon: PlusSquare },
    { path: "leaderboard", label: "测试排行榜", icon: Trophy },
    { path: "help", label: "账户与帮助", icon: CircleHelp },
    ...(session.opsRead
      ? [{ path: "ops", label: "运营报表", icon: ChartNoAxesCombined }]
      : []),
  ];
  const nav = (
    <nav className="nav" aria-label="主要导航">
      {links.map((l) => (
        <NavLink
          key={l.path}
          to={`/${env.id}/${l.path}`}
          onClick={() => setMenu(false)}
        >
          <l.icon size={18} aria-hidden="true" />
          {l.label}
        </NavLink>
      ))}
    </nav>
  );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="sidebar">
        <Link className="brand" to={`/${env.id}/markets`}>
          <span className="brand-mark">CP</span>Cpredict
        </Link>
        {nav}
        <div className="sidebar-footer">
          <p>公开用户测试</p>
          <p>测试资产 · 无奖励</p>
          <Link to={`/${env.id}/feedback`}>反馈问题</Link>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="icon-button mobile-menu-button"
              type="button"
              aria-label="打开导航"
              aria-expanded={menu}
              onClick={() => setMenu(true)}
            >
              <Menu />
            </button>
            <select
              aria-label="当前测试环境"
              value={env.id}
              onChange={(e) => {
                if (e.target.value !== env.id)
                  window.location.assign(`/${e.target.value}/markets`);
              }}
            >
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label} · {e.asset}
                </option>
              ))}
            </select>
            <span className="topbar-note">Arbitrum Sepolia · 测试资产</span>
          </div>
          <div className="topbar-right">
            {session.authenticated ? (
              <Link
                className="button button-secondary"
                to={`/${env.id}/assets`}
              >
                {session.account
                  ? shortAddress(session.account.address)
                  : "完成账户验证"}
              </Link>
            ) : (
              <Button disabled={!session.ready} onClick={session.login}>
                登录 / 连接钱包
              </Button>
            )}
          </div>
        </header>
        <main id="main-content" ref={main} tabIndex={-1}>
          <SyncNotice />
          <Suspense fallback={<Loading label="正在打开页面" />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <Modal
        open={menu}
        onOpenChange={setMenu}
        title="Cpredict 导航"
        description="切换用户页面与账户帮助。"
      >
        {nav}
      </Modal>
    </div>
  );
}
function SyncNotice() {
  const { api } = useSession(),
    query = useQuery({
      queryKey: [api.key, "sync"],
      queryFn: ({ signal }) =>
        api.request(
          "/v2/sync-status",
          z.object({
            chainHead: z.string(),
            applicationConfirmedBlock: z.string(),
            indexedBlock: z.string().nullable(),
            safeBlock: z.string().nullable(),
            finalizedBlock: z.string().nullable(),
            snapshot: snapshotSchema.nullable(),
          }),
          { service: "indexer", signal },
        ),
      refetchInterval: 20000,
      retry: 0,
    });
  if (query.error)
    return (
      <Notice tone="warning">
        同步状态暂不可用，链上操作结果请到历史中查询原记录。
      </Notice>
    );
  const d = query.data;
  if (!d) return null;
  if (
    d.indexedBlock === null ||
    BigInt(d.applicationConfirmedBlock) > BigInt(d.indexedBlock) + 20n
  )
    return (
      <Notice>
        历史索引正在追赶。链头 {d.chainHead}，应用确认高度{" "}
        {d.applicationConfirmedBlock}，已索引 {d.indexedBlock ?? "未知"}
        。已确认交易不会因同步延迟变为失败。
      </Notice>
    );
  return null;
}
function useTelemetry() {
  const { api, identityKey, account } = useSession(),
    sent = useRef(new Set<string>());
  useEffect(() => {
    let sessionId = sessionStorage.getItem(`cpredict-visit:${api.key}`);
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      sessionStorage.setItem(`cpredict-visit:${api.key}`, sessionId);
    }
    for (const event of [
      "visit",
      ...(identityKey ? ["login"] : []),
      ...(account ? ["account-ready"] : []),
    ] as const) {
      const key = `${api.key}:${event}:${event === "visit" ? sessionId : identityKey}:${event === "account-ready" ? account?.id : ""}`;
      if (sent.current.has(key)) continue;
      sent.current.add(key);
      void api
        .request("/v1/telemetry", z.object({ accepted: z.boolean() }), {
          auth: event !== "visit",
          body: {
            id: crypto.randomUUID(),
            event,
            sessionId,
            occurredAt: new Date().toISOString(),
            ...(event === "account-ready" && account
              ? { accountId: account.id }
              : {}),
          },
        })
        .catch(() => {
          /* Telemetry cannot block trading or expose login tokens in error logs. */
        });
    }
  }, [api, identityKey, account?.id]);
}
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <main>
        <Empty
          title="页面暂时无法打开"
          action={
            <Button onClick={() => window.location.reload()}>
              重新打开页面
            </Button>
          }
        >
          已提交的操作保存在服务端。刷新后请查询原操作，避免重复提交。
        </Empty>
      </main>
    ) : (
      this.props.children
    );
  }
}
