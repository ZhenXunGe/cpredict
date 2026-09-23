import { OrderbookPanel } from "../Orderbook.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, type Address } from "viem";
import {
  address,
  AppError,
  sameAddress,
} from "../../../../offchain/app-core/src/contracts.js";
import { SHARE_SCALE } from "../../../../offchain/sdk/src/units.js";
import { useSession } from "../wallets.js";
import { useOperation } from "../operations.js";
import {
  dateText,
  marketReadAbi,
  marketStatusCopy,
  marketResolutionDeadline,
  useBalance,
  useListings,
  useMarket,
  useMarketLive,
  useMarketClock,
  useRules,
  type Listing,
  type Market,
} from "../data.js";
import {
  AddressText,
  Amount,
  Button,
  DataTable,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  Notice,
  PaginationControls,
  PageTitle,
  shortAddress,
} from "../ui.js";
import { usePaginatedList } from "../pagination.js";
import { parseAssetAmount } from "../amounts.js";
import {
  checkPrimaryPurchase,
  primaryAvailability,
  primaryAlternativeBlockedReason,
} from "../primary-purchase.js";
type PrimarySelection = {
  market: Address;
  outcome: number;
  units: string;
  revision: number;
};

export function MarketDetailPage() {
  const value = address.safeParse(useParams().market);
  return value.success ? (
    <MarketContent marketAddress={value.data} />
  ) : (
    <Empty title="市场地址无效">请从市场列表重新进入。</Empty>
  );
}
function MarketContent({ marketAddress }: { marketAddress: Address }) {
  const { api, account } = useSession(),
    query = useMarket(marketAddress),
    rules = useRules(query.data),
    live = useMarketLive(marketAddress),
    begin = useOperation();
  const [primarySelection, setPrimarySelection] =
    useState<PrimarySelection | null>(null);
  if (query.isPending) return <Loading />;
  if (!query.data)
    return (
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
    );
  const market = query.data,
    env = api.environment,
    state = live.data?.state ?? market.state,
    terminal = state !== 0,
    status = marketStatusCopy(
      market,
      live.data,
      env.deployment.protocolVersion,
    ),
    timedOut =
      !!live.data &&
      state === 0 &&
      live.data.now >= live.data.resolutionDeadline;
  return (
    <>
      <Link to={`/${env.id}/markets`}>← 返回市场</Link>
      <div style={{ height: 20 }} />
      <PageTitle
        title={
          rules.data?.question?.trim() ||
          market.question?.trim() ||
          `市场 ${shortAddress(marketAddress)}`
        }
        description={`${status} · 所有时间均为北京时间`}
      />
      <div className="detail-grid">
        <div className="stack">
          <section className="surface">
            <div className="row">
              <span
                className={`status status-${state === 1 ? "resolved" : state === 2 ? "voided" : "open"}`}
              >
                {status}
              </span>
              {rules.data && (
                <span className="small muted">规则哈希已核对</span>
              )}
            </div>
            <dl className="data-list">
              <dt>市场合约</dt>
              <dd>
                <AddressText
                  value={marketAddress}
                  explorer={env.explorerUrl}
                  full
                />
              </dd>
              <dt>封盘时间</dt>
              <dd>{dateText(market.closeAt)}</dd>
              <dt>事件开始</dt>
              <dd>{dateText(market.eventStartsAt)}</dd>
              <dt>结果截止</dt>
              <dd>{dateText(market.outcomeDeadlineAt)}</dd>
              <dt>最终结算截止</dt>
              <dd>
                {dateText(
                  live.data?.resolutionDeadline.toString() ??
                    marketResolutionDeadline(
                      market,
                      env.deployment.protocolVersion,
                    ),
                )}
              </dd>
              <dt>创建者</dt>
              <dd>
                <AddressText value={market.creator} />
              </dd>
              <dt>一级投入</dt>
              <dd>
                <Amount
                  value={
                    live.data?.principal.toString() ?? market.primaryPayment
                  }
                  asset={env.asset}
                />
              </dd>
            </dl>
            {(live.data?.principal ?? BigInt(market.primaryPayment)) === 0n && (
              <Notice>市场尚无资金投入，当前不展示赔率或预期收益。</Notice>
            )}
            {(live.data?.state ?? market.state) === 1 && (
              <Notice tone="success">
                终局结果：
                {live.data?.winningOutcome === undefined &&
                market.winningOutcome === null
                  ? "结果编号尚未同步"
                  : (rules.data?.outcomes[
                      live.data?.winningOutcome ?? Number(market.winningOutcome)
                    ] ??
                    `结果 #${live.data?.winningOutcome ?? market.winningOutcome}`)}
              </Notice>
            )}
            {(live.data?.state ?? market.state) === 2 && (
              <Notice tone="warning">
                市场已作废，可退款权益按实际持仓与合约状态计算。
                {(live.data?.voidReason ?? market.voidReason) === 3 &&
                  "超时退款与押金罚没补偿分阶段领取。"}
              </Notice>
            )}
            {timedOut && (
              <Notice tone="warning">
                已达到最终结算截止时间，但市场尚未作废。任何账户都可申请超时作废；链上确认后才能按规则领取退款。
              </Notice>
            )}
            <Notice tone="warning">
              创建者可根据公布规则决定结果。请评估创建者判断与结算风险。
            </Notice>
            <ErrorNotice error={live.error} retry={() => void live.refetch()} />
          </section>
          <section className="surface stack" aria-label="费用说明">
            <h2>费用说明</h2>
            {live.data ? (
              <>
                <dl className="data-list">
                  <dt>终局创作者抽成</dt>
                  <dd>
                    市场本金的 {live.data.economics.creatorRakeBps / 100}%
                  </dd>
                  <dt>终局平台分成</dt>
                  <dd>
                    创作者终局抽成的{" "}
                    {live.data.economics.protocolShareBps / 100}%
                  </dd>
                  <dt>C2C 平台手续费</dt>
                  <dd>
                    成交总额的 {live.data.economics.platformC2CFeeBps / 100}
                    %（由卖家承担）
                  </dd>
                  <dt>C2C 创作者手续费</dt>
                  <dd>
                    成交总额的 {live.data.economics.creatorC2CFeeBps / 100}
                    %（由卖家承担）
                  </dd>
                </dl>
                <p className="small muted">
                  费率来自本市场创建时保存的链上快照。
                  正常结算时，平台分成从创作者终局抽成中分出。 C2C
                  两项费用从卖家成交收入中扣除，买家支付成交总额；挂单、撤单本身不收取成交手续费。网络
                  Gas 另计。
                </p>
                <details>
                  <summary>早鸟奖励如何分配</summary>
                  {live.data.earlyBirdEnabled ? (
                    <>
                      <p>
                        正常结算时，从扣除平台分成后的创作者抽成中提取{" "}
                        {live.data.economics.earlyBirdShareBps / 100}%
                        作为早鸟奖励池，约等于创作者终局总抽成的{" "}
                        {((10000 - live.data.economics.protocolShareBps) *
                          live.data.economics.earlyBirdShareBps) /
                          1000000}
                        %。实际金额以链上整数计算为准。
                      </p>
                      <p>
                        每笔一级买入按实际成交数量 ×
                        时间权重累计积分，越早买入权重越高（3、2、1）。
                        {env.deployment.protocolVersion === "legacy-v1"
                          ? "本市场按设置的早鸟起点到封盘时间分三段，起点之前按 3 倍计分。"
                          : "本市场从创建到封盘分为三段。"}
                        个人奖励按本人积分占全部参与者积分的比例分配，与是否押中结果无关。
                      </p>
                      <p>
                        积分属于原买入账户，不随份额转让；卖出份额仍可领取，二级买入不增加积分。正常结算后到“持仓与权益”领取；作废不发早鸟奖励。
                      </p>
                    </>
                  ) : (
                    <p>本市场未开启早鸟奖励。</p>
                  )}
                  <p className="small muted">
                    早鸟比例来自市场创建时的协议配置，创建者可选择是否开启，不能在此单独调整比例；平台分成若不同，折合总抽成的比例也会不同。
                  </p>
                </details>
              </>
            ) : live.isPending ? (
              <Loading label="正在读取链上费率" />
            ) : (
              <Notice tone="warning">
                费率暂不可用，请在上方重试链上数据读取。
              </Notice>
            )}
          </section>
          <section className="surface prose">
            <h2>市场规则</h2>
            {rules.data ? (
              <>
                <h3>结果选项</h3>
                <ol>
                  {rules.data.outcomes.map((value, index) => (
                    <li key={index}>{value}</li>
                  ))}
                </ol>
                <h3>结算标准</h3>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  {rules.data.resolutionCriteria}
                </p>
                <h3>信息来源</h3>
                <p>{rules.data.resolutionSource}</p>
                <h3>作废条件</h3>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  {rules.data.cancellationPolicy}
                </p>
                <details>
                  <summary>验证信息</summary>
                  <dl className="data-list">
                    <dt>规则哈希</dt>
                    <dd>
                      <code>{market.rulesHash}</code>
                    </dd>
                    <dt>终局证据哈希</dt>
                    <dd>
                      <code>{market.evidenceHash ?? "尚未发布"}</code>
                    </dd>
                  </dl>
                </details>
              </>
            ) : rules.isPending ? (
              <Loading label="正在读取规则" />
            ) : (
              <Notice tone="warning">
                规则暂不可验证，新增购买与挂单已暂停。已有资产的领取、撤单和终局份额取回仍可使用。
              </Notice>
            )}
          </section>
          {api.environment.deployment.marketplaceVersion === "orderbook-v2" ? (
            <OrderbookPanel
              market={market.market}
              labels={rules.data?.outcomes ?? []}
              verified={!!rules.data}
              terminal={terminal}
              question={rules.data?.question ?? market.market}
            />
          ) : (
            <Listings
              market={market}
              verified={!!rules.data}
              labels={rules.data?.outcomes ?? []}
              terminal={terminal}
              onPrimaryPurchase={(outcome, units) =>
                setPrimarySelection((previous) => ({
                  market: market.market,
                  outcome,
                  units,
                  revision: (previous?.revision ?? 0) + 1,
                }))
              }
            />
          )}
        </div>
        <aside className="stack">
          {terminal ? (
            <section className="surface stack">
              <h2>领取与退出</h2>
              <p>
                查看持仓、早鸟、退款和托管份额等全部权益，逐项核对可领取金额。
              </p>
              <Link
                className="button button-primary"
                to={`/${env.id}/entitlements?market=${market.market}`}
              >
                查看我的权益
              </Link>
            </section>
          ) : (
            <TradePanel
              primarySelection={primarySelection}
              market={market}
              verified={!!rules.data}
              labels={rules.data?.outcomes ?? []}
            />
          )}
          <section className="surface stack">
            <h3>创作者与市场操作</h3>
            {account && sameAddress(account.address, market.creator) && (
              <Link
                className="button button-secondary"
                to={`/${env.id}/creator/${market.market}`}
              >
                进入创作者中心
              </Link>
            )}
            {timedOut && (
              <Button
                variant="secondary"
                onClick={() =>
                  begin({
                    intent: { kind: "void-timeout", market: market.market },
                    summary: [
                      {
                        label: "市场",
                        value:
                          rules.data?.question?.trim() ||
                          market.question?.trim() ||
                          market.market,
                      },
                      {
                        label: "操作",
                        value: "已达到结算截止时间，申请超时作废",
                      },
                    ],
                    feeNote:
                      "超时作废激活本金退款。押金罚没进入补偿池与领取补偿是后续独立步骤。",
                  })
                }
              >
                申请超时作废
              </Button>
            )}
            <p className="small">
              创建费、押金和协议费用由测试资产支付。网络 Gas
              可在确认页选择项目代付或自行支付 ETH。
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
function TradePanel({
  primarySelection,
  market,
  verified,
  labels,
}: {
  market: Market;
  verified: boolean;
  labels: string[];
  primarySelection: PrimarySelection | null;
}) {
  const session = useSession(),
    env = session.api.environment,
    live = useMarketLive(market.market),
    paymentBalance = useBalance(),
    begin = useOperation();
  const [mode, setMode] = useState<"buy" | "sell">("buy"),
    [outcome, setOutcome] = useState(0),
    [amount, setAmount] = useState(""),
    [minimum, setMinimum] = useState(""),
    [price, setPrice] = useState("1"),
    [expiry, setExpiry] = useState("24"),
    [checkingBalance, setCheckingBalance] = useState(false),
    [error, setError] = useState<unknown>(null);
  const amountInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (
      !primarySelection ||
      !sameAddress(primarySelection.market, market.market)
    )
      return;
    setMode("buy");
    setOutcome(primarySelection.outcome);
    setAmount(primarySelection.units);
    setMinimum("");
    setError(null);
    amountInput.current?.focus({ preventScroll: true });
    amountInput.current?.scrollIntoView({ block: "center" });
  }, [primarySelection, market.market]);
  const balance = useQuery({
    queryKey: [
      session.api.key,
      "share-balance",
      session.account?.address,
      market.market,
      outcome,
    ],
    enabled: !!session.account,
    queryFn: () =>
      session.api.publicClient().readContract({
        address: market.market,
        abi: marketReadAbi,
        functionName: "balanceOf",
        args: [session.account!.address, BigInt(outcome)],
      }),
    refetchInterval: 15000,
  });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      if (!live.data || !verified) throw new AppError("rules_unverified", 409);
      const units = parseAssetAmount(amount),
        minUnits = minimum ? parseAssetAmount(minimum) : units;
      if (minUnits > units) throw new AppError("minimum_exceeds_amount", 400);
      if (mode === "buy") {
        const checked = checkPrimaryPurchase(
          live.data.capacity,
          units,
          minUnits,
          env.asset,
        );
        if (checked.error) throw checked.error;
        if (session.account) {
          setCheckingBalance(true);
          const currentBalance = await paymentBalance.refetch();
          if (currentBalance.error || currentBalance.data === undefined)
            throw new AppError("chain_query_unavailable", 503);
          if (units > currentBalance.data)
            throw new AppError("insufficient_balance", 400);
        }
        begin({
          intent: {
            kind: "buy",
            market: market.market,
            outcomeId: String(outcome),
            units: units.toString(),
            minUnits: minUnits.toString(),
            maxPayment: units.toString(),
            deadline: (live.data.now + 600n).toString(),
          },
          summary: [
            { label: "结果", value: labels[outcome] ?? `结果 #${outcome}` },
            { label: "最多支付", value: `${amount} ${env.asset}` },
            { label: "最少获得份额", value: formatUnits(minUnits, 6) },
            {
              label: "终局创作者抽成",
              value: `市场本金的 ${live.data.economics.creatorRakeBps / 100}%`,
            },
            {
              label: "终局平台分成",
              value: `创作者终局抽成的 ${live.data.economics.protocolShareBps / 100}%`,
            },
          ],
          feeNote: `一级投入按 1 ${env.asset} 对应 1 份本金记账。结算时创作者抽成 ${live.data.economics.creatorRakeBps / 100}%，平台从该抽成中收取 ${live.data.economics.protocolShareBps / 100}%。网络 Gas 按确认页选择的方式支付。`,
        });
      } else {
        if (!session.account) {
          session.login();
          return;
        }
        if (balance.data === undefined || units > balance.data)
          throw new AppError("insufficient_shares", 400);
        const unitPrice = parseAssetAmount(price);
        begin({
          intent: {
            kind: "create-listing",
            market: market.market,
            outcomeId: String(outcome),
            units: units.toString(),
            unitPrice: unitPrice.toString(),
            expiresAt: (live.data.now + BigInt(expiry) * 3600n).toString(),
          },
          summary: [
            { label: "卖出结果", value: labels[outcome] ?? `结果 #${outcome}` },
            { label: "挂单份额", value: amount },
            { label: "每份价格", value: `${price} ${env.asset}` },
            { label: "有效期", value: `${expiry} 小时` },
            {
              label: "C2C 平台手续费",
              value: `成交总额的 ${live.data.economics.platformC2CFeeBps / 100}%（成交时由卖家承担）`,
            },
            {
              label: "C2C 创作者手续费",
              value: `成交总额的 ${live.data.economics.creatorC2CFeeBps / 100}%（成交时由卖家承担）`,
            },
          ],
          feeNote: `份额进入市场托管，未成交部分仍属于你。成交时扣平台费 ${live.data.economics.platformC2CFeeBps / 100}% 和创作者费 ${live.data.economics.creatorC2CFeeBps / 100}%；挂单与撤单本身不实现收益。`,
        });
      }
    } catch (e) {
      setError(e);
    } finally {
      setCheckingBalance(false);
    }
  };
  const closed = !!live.data && live.data.now >= live.data.closeAt;
  const available = live.data ? primaryAvailability(live.data.capacity) : null;
  const buyCheck = (() => {
    if (mode !== "buy" || !live.data) return null;
    if (available?.market === 0n || available?.account === 0n)
      return checkPrimaryPurchase(live.data.capacity, 1n, 1n, env.asset);
    try {
      const units = parseAssetAmount(amount);
      return checkPrimaryPurchase(
        live.data.capacity,
        units,
        minimum ? parseAssetAmount(minimum) : units,
        env.asset,
      );
    } catch {
      return null;
    } // Keep incomplete decimal input editable; validate syntax on submit.
  })();
  let requestedPayment: bigint | null = null;
  try {
    requestedPayment = amount ? parseAssetAmount(amount) : null;
  } catch {
    // Submit owns malformed input; keep incomplete values editable.
  }
  const insufficientPayment =
    mode === "buy" &&
    requestedPayment !== null &&
    paymentBalance.data !== undefined &&
    requestedPayment > paymentBalance.data;
  return (
    <section className="surface">
      <div className="row">
        <Button
          variant={mode === "buy" ? "primary" : "quiet"}
          aria-pressed={mode === "buy"}
          onClick={() => setMode("buy")}
        >
          一级购买
        </Button>
        {env.deployment.marketplaceVersion !== "orderbook-v2" && (
          <Button
            variant={mode === "sell" ? "primary" : "quiet"}
            aria-pressed={mode === "sell"}
            onClick={() => setMode("sell")}
          >
            挂单卖出
          </Button>
        )}
      </div>
      <form className="stack" style={{ marginTop: 22 }} onSubmit={submit}>
        <Field label="结果选项">
          <select
            value={outcome}
            onChange={(e) => setOutcome(Number(e.target.value))}
          >
            {labels.map((label, i) => (
              <option key={i} value={i}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        {mode === "buy" && live.data && available && (
          <div className="small muted" aria-label="一级投入额度">
            <p>
              每账户上限 {formatUnits(live.data.capacity.perUserCap, 6)}{" "}
              {env.asset}；
              {available.account === null
                ? "登录后查看你的剩余额度"
                : `你还可投入 ${formatUnits(available.account, 6)} ${env.asset}`}
              。
            </p>
            <p>
              市场上限 {formatUnits(live.data.capacity.marketCap, 6)}{" "}
              {env.asset}；剩余 {formatUnits(available.market, 6)} {env.asset}。
            </p>
          </div>
        )}
        {mode === "buy" && session.account && (
          <p className="small">
            可用余额：
            {paymentBalance.data === undefined
              ? "正在核对…"
              : `${formatUnits(paymentBalance.data, 6)} ${env.asset}`}
          </p>
        )}
        <Field label={mode === "buy" ? `投入数量（${env.asset}）` : "挂单份额"}>
          <input
            inputMode="decimal"
            ref={amountInput}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              setError(null);
            }}
            required
            placeholder="0.00"
          />
        </Field>
        {mode === "buy" ? (
          <Field
            label="最少获得份额"
            hint="留空表示必须全部成交；填写更低数值才允许部分成交。"
          >
            <input
              inputMode="decimal"
              value={minimum}
              onChange={(e) => {
                setMinimum(e.target.value);
                setError(null);
              }}
              placeholder={amount || "与投入数量相同"}
            />
          </Field>
        ) : (
          <>
            <Field label={`每份卖价（${env.asset}）`}>
              <input
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                required
              />
            </Field>
            <Field label="挂单有效期">
              <select
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
              >
                <option value="24">24 小时</option>
                <option value="48">48 小时</option>
                <option value="168">7 天</option>
              </select>
            </Field>
            <p className="small">
              可用份额：
              <Amount value={balance.data?.toString()} />
            </p>
          </>
        )}
        {closed && (
          <Notice tone="warning">
            一级购买已封盘。市场终局前 C2C
            仍可能交易，请留意创建者结算与流动性风险。
          </Notice>
        )}
        <ErrorNotice
          error={
            buyCheck?.error ??
            error ??
            (mode === "buy" ? paymentBalance.error : null)
          }
        />
        {insufficientPayment && (
          <Notice tone="warning">
            {`余额不足：当前可用 ${formatUnits(paymentBalance.data!, 6)} ${env.asset}，本次最多需支付 ${formatUnits(requestedPayment!, 6)} ${env.asset}。`}
          </Notice>
        )}
        {mode === "buy" &&
          buyCheck &&
          !buyCheck.error &&
          buyCheck.filled > 0n &&
          minimum && (
            <p className="small">
              按当前额度可成交 {formatUnits(buyCheck.filled, 6)}{" "}
              份；提交前会再次核对，实际成交以链上结果为准。
            </p>
          )}
        <Button
          type="submit"
          disabled={
            !verified ||
            !env.features.newExposure ||
            !live.data ||
            checkingBalance ||
            (mode === "buy" &&
              (closed ||
                !!buyCheck?.error ||
                (!!session.account &&
                  (paymentBalance.data === undefined ||
                    !!paymentBalance.error ||
                    insufficientPayment))))
          }
        >
          核对{mode === "buy" ? "购买" : "挂单"}
        </Button>
        {!env.features.newExposure && (
          <p className="small">当前暂停新增资金操作。</p>
        )}
      </form>
    </section>
  );
}
function Listings({
  market,
  verified,
  labels,
  terminal,
  onPrimaryPurchase,
}: {
  market: Market;
  verified: boolean;
  labels: string[];
  terminal: boolean;
  onPrimaryPurchase: (outcome: number, units: string) => void;
}) {
  const session = useSession(),
    query = useListings(market.market),
    begin = useOperation(),
    live = useMarketLive(market.market),
    paymentBalance = useBalance(),
    now = useMarketClock(),
    env = session.api.environment;
  const [selected, setSelected] = useState<Listing | null>(null),
    [units, setUnits] = useState(""),
    [checkingBalance, setCheckingBalance] = useState(false),
    [error, setError] = useState<unknown>(null);
  const fill = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      if (!selected || !live.data)
        throw new AppError("listing_unavailable", 409);
      const amount = parseAssetAmount(units);
      if (amount > BigInt(selected.remainingUnits))
        throw new AppError("listing_quantity_changed", 409);
      const gross = (amount * BigInt(selected.unitPrice)) / SHARE_SCALE;
      if (session.account) {
        setCheckingBalance(true);
        const currentBalance = await paymentBalance.refetch();
        if (currentBalance.error || currentBalance.data === undefined)
          throw new AppError("chain_query_unavailable", 503);
        if (gross > currentBalance.data)
          throw new AppError("insufficient_balance", 400);
      }
      begin({
        intent: {
          kind: "fill-listing",
          listingId: selected.listingId,
          units: amount.toString(),
          minUnits: amount.toString(),
          maxPayment: gross.toString(),
          deadline: (live.data.now + 600n).toString(),
        },
        summary: [
          {
            label: "购买结果",
            value:
              labels[Number(selected.outcomeId)] ??
              `结果 #${selected.outcomeId}`,
          },
          { label: "份额", value: units },
          { label: "最多支付", value: `${formatUnits(gross, 6)} ${env.asset}` },
          { label: "卖家", value: selected.seller },
          {
            label: "C2C 平台手续费",
            value: `成交总额的 ${live.data.economics.platformC2CFeeBps / 100}%（由卖家承担）`,
          },
          {
            label: "C2C 创作者手续费",
            value: `成交总额的 ${live.data.economics.creatorC2CFeeBps / 100}%（由卖家承担）`,
          },
        ],
        feeNote: `本次使用全额成交下限；成交数量变化时重新确认。卖家净收入为成交总额扣除平台费 ${live.data.economics.platformC2CFeeBps / 100}% 和创作者费 ${live.data.economics.creatorC2CFeeBps / 100}%，不会向买家重复扣这两项费用。`,
      });
    } catch (e) {
      setError(e);
    } finally {
      setCheckingBalance(false);
    }
  };
  const primaryOpen =
    !terminal &&
    !!live.data &&
    live.data.state === 0 &&
    live.data.now < live.data.closeAt &&
    now < live.data.closeAt;
  const primaryBlocked = primaryAlternativeBlockedReason(
    live.isError ? null : (live.data?.capacity ?? null),
    primaryOpen,
    verified,
    env.features.newExposure,
  );
  const rows =
    query.data?.pages
      .flatMap((p) => p.items)
      .filter((l) => BigInt(l.remainingUnits) > 0n) ?? [];
  const pagination = usePaginatedList({
    pages:
      query.data?.pages.map((page) =>
        page.items.filter((listing) => BigInt(listing.remainingUnits) > 0n),
      ) ?? [],
    pageSize: 10,
    scope: `${env.id}:${market.market}`,
    hasMore: !!query.hasNextPage,
    isLoadingMore: query.isFetchingNextPage,
    loadMore: query.fetchNextPage,
  });
  return (
    <section className="stack">
      <h2>C2C 挂单</h2>
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      {query.isPending ? (
        <Loading />
      ) : rows.length ? (
        <DataTable
          headers={["结果 / 卖家", "剩余份额", "每份价格", "到期时间", "操作"]}
        >
          {pagination.items.map((l) => (
            <tr key={l.listingId}>
              <td>
                {labels[Number(l.outcomeId)] ?? `结果 #${l.outcomeId}`}
                <p className="small">{shortAddress(l.seller)}</p>
              </td>
              <td>
                <Amount value={l.remainingUnits} />
              </td>
              <td>
                <Amount value={l.unitPrice} asset={env.asset} />
                {primaryOpen && BigInt(l.unitPrice) > SHARE_SCALE && (
                  <div className="small muted">高于一级价格</div>
                )}
              </td>
              <td>{dateText(l.expiresAt)}</td>
              <td>
                {session.account &&
                sameAddress(session.account.address, l.seller) ? (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      begin({
                        intent: {
                          kind: terminal ? "return-listing" : "cancel-listing",
                          listingId: l.listingId,
                        },
                        summary: [
                          {
                            label: "取回份额",
                            value: formatUnits(BigInt(l.remainingUnits), 6),
                          },
                          {
                            label: "结果",
                            value: labels[Number(l.outcomeId)] ?? l.outcomeId,
                          },
                        ],
                        feeNote:
                          "仅取回未成交的托管份额，保留原成本。终局后可继续按规则领取对应权益。",
                      })
                    }
                  >
                    {terminal ? "取回份额" : "撤单"}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={
                      terminal ||
                      !verified ||
                      !env.features.newExposure ||
                      !l.active ||
                      BigInt(l.expiresAt) <=
                        BigInt(Math.floor(Date.now() / 1000))
                    }
                    onClick={() => {
                      setSelected(l);
                      setUnits(formatUnits(BigInt(l.remainingUnits), 6));
                    }}
                  >
                    购买
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </DataTable>
      ) : (
        !query.error && (
          <Empty title="暂无可用挂单">
            未成交的挂单份额会保留在卖家的托管权益中。
          </Empty>
        )
      )}
      <PaginationControls
        ariaLabel="C2C 挂单分页"
        page={pagination.page}
        hasPrevious={pagination.hasPrevious}
        hasNext={pagination.hasNext}
        busy={pagination.isLoading}
        onPrevious={pagination.previous}
        onNext={() => void pagination.next()}
      />
      {selected && !terminal && (
        <form className="surface stack" onSubmit={fill}>
          <h3>核对挂单购买</h3>
          <p>
            {labels[Number(selected.outcomeId)] ??
              `结果 #${selected.outcomeId}`}{" "}
            · 卖家 {shortAddress(selected.seller)}
          </p>
          {primaryOpen && BigInt(selected.unitPrice) > SHARE_SCALE && (
            <Notice tone="warning">
              <p>
                此挂单每份{" "}
                <Amount value={selected.unitPrice} asset={env.asset} />
                ，高于一级购买每份 1 {env.asset}。
              </p>
              {primaryBlocked ? (
                <p>{primaryBlocked}当前不能切换到一级购买。</p>
              ) : (
                <>
                  <p>
                    可先查看一级购买，以更低单价购买同一结果。数量受市场及账户剩余额度限制，提交前会再次核对；网络
                    Gas 另计。
                  </p>
                  {!session.account && <p>登录后才能核对你的一级投入额度。</p>}
                  <Button
                    variant="secondary"
                    onClick={() => {
                      onPrimaryPurchase(Number(selected.outcomeId), units);
                      setSelected(null);
                    }}
                  >
                    去一级购买
                  </Button>
                </>
              )}
            </Notice>
          )}
          <Field
            label="购买份额"
            hint="可以购买部分挂单；本笔数量必须全部成交，否则重新确认。"
          >
            <input
              inputMode="decimal"
              value={units}
              onChange={(e) => setUnits(e.target.value)}
              required
            />
          </Field>
          <ErrorNotice error={error ?? paymentBalance.error} />
          <div className="row">
            <Button type="submit" disabled={checkingBalance}>
              {checkingBalance ? "正在核对余额…" : "核对购买"}
            </Button>
            <Button variant="quiet" onClick={() => setSelected(null)}>
              取消选择
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
