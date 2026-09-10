import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  formatUnits,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
} from "viem";
import { z } from "zod";
import {
  AppError,
  address,
  intentSchema,
  type BusinessIntent,
} from "../../../../offchain/app-core/src/contracts.js";
import {
  marketRulesSchema,
  encodeMarketRules,
} from "../../../../offchain/sdk/src/market-rules.js";
import { pnlResponseSchema } from "../../../../offchain/app-core/src/ledger-contracts.js";
import { useSession } from "../wallets.js";
import { AccountGate, useOperation } from "../operations.js";
import {
  useMarket,
  useMarketLive,
  useMarkets,
  useRules,
  marketStatusCopy,
  dateText,
} from "../data.js";
import {
  AddressText,
  Amount,
  Button,
  DataTable,
  ErrorNotice,
  Field,
  Loading,
  Notice,
  PageTitle,
} from "../ui.js";
import { parseAssetAmount } from "../amounts.js";
import { publishRules } from "../metadata.js";
const factoryAbi = parseAbi([
  "function config() view returns(address)",
  "function resolutionWindow() view returns(uint64)",
]);
const configAbi = parseAbi([
  "function creationFee() view returns(uint128)",
  "function maxFullMarketCap() view returns(uint128)",
  "function maxCloneMarketCap() view returns(uint128)",
  "function maxPerUserPrimaryCap() view returns(uint128)",
  "function maxCreatorRakeBps() view returns(uint16)",
  "function maxCreatorC2CFeeBps() view returns(uint16)",
]);
function useCreationConfig() {
  const { api } = useSession();
  return useQuery({
    queryKey: [api.key, "creation-config"],
    queryFn: async () => {
      const c = api.publicClient(),
        block = await c.getBlock(),
        blockNumber = block.number;
      const [config, resolutionWindow] = await Promise.all([
        c.readContract({
          address: api.environment.deployment.factory,
          abi: factoryAbi,
          functionName: "config",
          blockNumber,
        }),
        c.readContract({
          address: api.environment.deployment.factory,
          abi: factoryAbi,
          functionName: "resolutionWindow",
          blockNumber,
        }),
      ]);
      const [creationFee, fullCap, cloneCap, userCap, rakeMax, c2cMax] =
        await Promise.all([
          c.readContract({
            address: config,
            abi: configAbi,
            functionName: "creationFee",
            blockNumber,
          }),
          c.readContract({
            address: config,
            abi: configAbi,
            functionName: "maxFullMarketCap",
            blockNumber,
          }),
          c.readContract({
            address: config,
            abi: configAbi,
            functionName: "maxCloneMarketCap",
            blockNumber,
          }),
          c.readContract({
            address: config,
            abi: configAbi,
            functionName: "maxPerUserPrimaryCap",
            blockNumber,
          }),
          c.readContract({
            address: config,
            abi: configAbi,
            functionName: "maxCreatorRakeBps",
            blockNumber,
          }),
          c.readContract({
            address: config,
            abi: configAbi,
            functionName: "maxCreatorC2CFeeBps",
            blockNumber,
          }),
        ]);
      return {
        creationFee,
        fullCap,
        cloneCap,
        userCap,
        rakeMax,
        c2cMax,
        resolutionWindow,
        now: block.timestamp,
      };
    },
    staleTime: 15000,
  });
}
export function CreatorPage() {
  const { api, account } = useSession(),
    markets = useMarkets("", "", account?.address),
    pnl = useQuery({
      queryKey: [api.key, "pnl", account?.address],
      enabled: !!account,
      queryFn: ({ signal }) =>
        api.request(`/v2/pnl/${account!.address}`, pnlResponseSchema, {
          service: "indexer",
          signal,
        }),
    });
  return (
    <>
      <PageTitle
        title="创作者中心"
        description="创建者对结果负责。费用产生、记入可领取余额和实际到账分别核算。"
        action={
          <Link
            className="button button-primary"
            to={`/${api.environment.id}/creator/new`}
          >
            创建市场
          </Link>
        }
      />
      <AccountGate />
      {account && (
        <>
          <div className="stats-grid">
            <div className="stat-card">
              <span>费用应计收入</span>
              <strong>
                <Amount
                  value={pnl.data?.pnl.creatorIncome}
                  asset={api.environment.asset}
                />
              </strong>
            </div>
            <div className="stat-card">
              <span>费用实际已领（跨市场）</span>
              <strong>
                <Amount
                  value={pnl.data?.pnl.creatorClaimed}
                  asset={api.environment.asset}
                />
              </strong>
            </div>
            <div className="stat-card">
              <span>押金实际已领（跨市场）</span>
              <strong>
                <Amount
                  value={pnl.data?.pnl.bondClaimed}
                  asset={api.environment.asset}
                />
              </strong>
            </div>
          </div>
          <ErrorNotice error={pnl.error ?? markets.error} />
          <Notice>
            创作者收入与押金不计入交易者收益榜。
            <Link to={`/${api.environment.id}/entitlements`}>
              查看并领取费用、押金及其他权益
            </Link>
          </Notice>
          <h2>我创建的市场</h2>
          {markets.isPending && <Loading />}
          {markets.data && (
            <DataTable headers={["市场", "状态", "押金", "管理"]}>
              {markets.data.pages
                .flatMap((p) => p.items)
                .map((m) => (
                  <tr key={m.market}>
                    <td>
                      <AddressText value={m.market} />
                    </td>
                    <td>{marketStatusCopy(m)}</td>
                    <td>
                      <Amount
                        value={m.creatorBond}
                        asset={api.environment.asset}
                      />
                    </td>
                    <td>
                      <Link to={`/${api.environment.id}/creator/${m.market}`}>
                        查看与结算
                      </Link>
                    </td>
                  </tr>
                ))}
            </DataTable>
          )}
          {markets.hasNextPage && (
            <Button
              variant="secondary"
              onClick={() => void markets.fetchNextPage()}
            >
              更多市场
            </Button>
          )}
        </>
      )}
    </>
  );
}
export function CreateMarketPage() {
  const session = useSession(),
    { api, account } = session,
    request = useOperation(),
    config = useCreationConfig();
  const [question, setQuestion] = useState(""),
    [outcomes, setOutcomes] = useState("是\n否"),
    [source, setSource] = useState(""),
    [criteria, setCriteria] = useState(""),
    [cancellation, setCancellation] = useState(""),
    [close, setClose] = useState(""),
    [start, setStart] = useState(""),
    [deadline, setDeadline] = useState(""),
    [cap, setCap] = useState("20"),
    [userCap, setUserCap] = useState("10"),
    [bond, setBond] = useState("10"),
    [minBuy, setMinBuy] = useState("1"),
    [minSell, setMinSell] = useState("1"),
    [rake, setRake] = useState("200"),
    [c2c, setC2c] = useState("0"),
    [early, setEarly] = useState(true),
    [mode, setMode] = useState<0 | 1>(0),
    [accepted, setAccepted] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [validation, setValidation] = useState("");
  const current = useRef({
    account: account?.id,
    identity: session.identityKey,
    revision: "",
  });
  const revision = JSON.stringify([
    question,
    outcomes,
    source,
    criteria,
    cancellation,
    close,
    start,
    deadline,
    cap,
    userCap,
    bond,
    minBuy,
    minSell,
    rake,
    c2c,
    early,
    mode,
    accepted,
  ]);
  current.current = {
    account: account?.id,
    identity: session.identityKey,
    revision,
  };
  const submit = async () => {
    if (!account || !config.data || busy) return;
    setError(null);
    setValidation("");
    const identity = session.identityKey;
    let signingStarted = false;
    const assertScope = () => {
      if (
        current.current.account !== account.id ||
        current.current.identity !== identity ||
        current.current.revision !== revision
      )
        throw new AppError("operation_preparation_changed");
    };
    try {
      if (!accepted) throw new Error("请确认规则不可修改及创建者结算责任。");
      const latest = (await config.refetch()).data;
      if (!latest) throw new Error("未取得当前创建配置。");
      assertScope();
      const timestamp = (value: string) => {
        const n = Date.parse(`${value}+08:00`) / 1000;
        if (!Number.isSafeInteger(n)) throw new Error("请填写有效的上海时间。");
        return n;
      };
      const closeAt = timestamp(close),
        outcomeDeadlineAt = timestamp(deadline);
      if (
        BigInt(closeAt) < latest.now + 300n ||
        BigInt(closeAt) > latest.now + 90n * 86400n
      )
        throw new Error("封盘时间必须在链上当前时间的 5 分钟至 90 天之间。");
      const rules = marketRulesSchema.parse({
        version: "cpredict-rules-v2",
        question,
        outcomes: outcomes
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
        closeAt,
        eventStartsAt: start ? timestamp(start) : null,
        outcomeDeadlineAt,
        resolutionDeadlineAt:
          outcomeDeadlineAt + Number(latest.resolutionWindow),
        resolutionSource: source,
        resolutionCriteria: criteria,
        cancellationPolicy: cancellation,
      });
      encodeMarketRules(rules);
      const marketCap = parseAssetAmount(cap),
        perUser = parseAssetAmount(userCap),
        creatorBond = parseAssetAmount(bond),
        minimumPrimary = parseAssetAmount(minBuy),
        minimumC2C = parseAssetAmount(minSell);
      const minBond =
        (marketCap * 200n + 9999n) / 10000n > 10_000_000n
          ? (marketCap * 200n + 9999n) / 10000n
          : 10_000_000n;
      if (
        marketCap > (mode === 0 ? latest.fullCap : latest.cloneCap) ||
        perUser > marketCap ||
        perUser > latest.userCap
      )
        throw new Error("市场或用户投入上限超出当前协议限制。");
      if (creatorBond < minBond || creatorBond > 1_000_000_000n)
        throw new Error(
          `押金须为 ${formatUnits(minBond, 6)}–1,000 ${api.environment.asset}。`,
        );
      if (
        minimumPrimary < 10000n ||
        minimumPrimary > 5000000n ||
        minimumPrimary > perUser ||
        minimumC2C < 10000n ||
        minimumC2C > 5000000n ||
        minimumC2C > marketCap
      )
        throw new Error("最小交易份额须为 0.01–5，且不能超出对应上限。");
      if (
        !/^\d+$/.test(rake) ||
        !/^\d+$/.test(c2c) ||
        Number(rake) > latest.rakeMax ||
        Number(c2c) > latest.c2cMax
      )
        throw new Error("费率超过当前协议允许范围。");
      signingStarted = true;
      setBusy(true);
      const publication = await publishRules(
        session,
        account,
        rules,
        assertScope,
      );
      assertScope();
      const intent = intentSchema.parse({
        kind: "create-market",
        params: {
          ...publication,
          outcomeCount: rules.outcomes.length,
          closeAt: String(closeAt),
          eventStartsAt: String(rules.eventStartsAt ?? 0),
          outcomeDeadlineAt: String(outcomeDeadlineAt),
          creatorTreasury: account.address,
          deploymentMode: mode,
          featureFlags: early ? "1" : "0",
          creatorRakeBps: Number(rake),
          creatorC2CFeeBps: Number(c2c),
          perUserPrimaryCap: perUser.toString(),
          marketPrimaryCap: marketCap.toString(),
          minimumPrimaryUnits: minimumPrimary.toString(),
          minimumC2CUnits: minimumC2C.toString(),
          creatorBond: creatorBond.toString(),
        },
        userSalt: keccak256(stringToHex(crypto.randomUUID())),
        maxPayment: (latest.creationFee + creatorBond).toString(),
      });
      request({
        intent,
        summary: [
          { label: "市场问题", value: rules.question },
          { label: "封盘时间（上海）", value: dateText(String(closeAt)) },
          {
            label: "创建费",
            value: `${formatUnits(latest.creationFee, 6)} ${api.environment.asset}`,
          },
          { label: "锁定押金", value: `${bond} ${api.environment.asset}` },
          {
            label: "合计支付上限",
            value: `${formatUnits(latest.creationFee + creatorBond, 6)} ${api.environment.asset}`,
          },
        ],
        feeNote:
          "发布规则签名只授权保存规则。接下来确认链上创建；创建费是协议费用，押金按终局规则结算，网络 Gas 单独申请项目代付。",
      });
    } catch (e) {
      if (e instanceof z.ZodError)
        setValidation(
          "请核对规则、结果名称、时间及来源地址格式。结果名称须唯一，问题和判定规则至少 8 个字符。",
        );
      else if (
        !signingStarted &&
        e instanceof Error &&
        !(e instanceof AppError)
      )
        setValidation(e.message);
      else
        setError(
          e instanceof AppError
            ? e
            : new AppError("rules_publication_failed", 503),
        );
    } finally {
      setBusy(false);
    }
  };
  if (api.environment.deployment.protocolVersion === "legacy-v1")
    return (
      <section className="stack">
        <PageTitle
          title="创建测试市场"
          description="当前 ctUSD 部署使用原有市场规则。"
        />
        <Notice>
          请前往现有测试入口创建市场。创建后的市场会显示在本站，原有资产和结算入口继续保留。
        </Notice>
        <a className="button button-primary" href={api.environment.legacyUrl}>
          前往 ctUSD 测试入口
        </a>
      </section>
    );
  return (
    <>
      <PageTitle
        title="创建测试市场"
        description="规则与关键参数上链后不可修改。时间均以 Asia/Shanghai 填写。"
      />
      <AccountGate />
      <Notice tone="warning">
        创建者可决定终局结果，也承担按时结算责任。超时可导致押金罚没。请提供清楚、可验证的公开结果来源。
      </Notice>
      <ErrorNotice error={error ?? config.error} />
      {validation && (
        <p role="alert" className="notice notice-warning">
          {validation}
        </p>
      )}
      <form
        className="surface stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="市场问题">
          <input
            value={question}
            minLength={8}
            maxLength={512}
            required
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="一个有明确结果的问题"
          />
        </Field>
        <Field label="结果选项" hint="每行一个选项，2–32 个，名称不能重复。">
          <textarea
            value={outcomes}
            onChange={(e) => setOutcomes(e.target.value)}
            required
          />
        </Field>
        <div className="form-grid">
          <Field label="封盘时间（上海）">
            <input
              type="datetime-local"
              value={close}
              onChange={(e) => setClose(e.target.value)}
              required
            />
          </Field>
          <Field label="事件开始时间（可选）">
            <input
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          <Field label="结果判断截止时间（上海）">
            <input
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              required
            />
          </Field>
          <div className="field">
            <span>结算窗口</span>
            <p>
              {config.data
                ? `${config.data.resolutionWindow.toString()} 秒（由当前协议固定）`
                : "等待链上配置"}
            </p>
          </div>
        </div>
        <Field label="公开结果来源（HTTPS）">
          <input
            type="url"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            required
            placeholder="https://"
          />
        </Field>
        <Field label="结果判定规则">
          <textarea
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            required
            minLength={8}
            maxLength={2048}
          />
        </Field>
        <Field label="取消、延期和无法判断时的处理规则">
          <textarea
            value={cancellation}
            onChange={(e) => setCancellation(e.target.value)}
            required
            minLength={8}
            maxLength={2048}
          />
        </Field>
        <div className="form-grid">
          {[
            { label: "市场投入上限", value: cap, set: setCap },
            { label: "每账户一级投入上限", value: userCap, set: setUserCap },
            { label: "创作者押金", value: bond, set: setBond },
            { label: "一级最小份额", value: minBuy, set: setMinBuy },
            { label: "C2C 最小份额", value: minSell, set: setMinSell },
            { label: "终局创作者抽成（基点）", value: rake, set: setRake },
            { label: "C2C 创作者费率（基点）", value: c2c, set: setC2c },
          ].map((f) => (
            <Field key={f.label} label={f.label}>
              <input
                inputMode="decimal"
                value={f.value}
                onChange={(e) => f.set(e.target.value)}
                required
              />
            </Field>
          ))}
          <Field label="市场部署方式">
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value === "0" ? 0 : 1)}
            >
              <option value="0">独立合约</option>
              <option value="1">固定实现克隆</option>
            </select>
          </Field>
        </div>
        <p className="small">
          1 基点 = 0.01%。
          {config.data &&
            `当前创作者终局抽成上限 ${config.data.rakeMax} 基点，C2C 创作者费率上限 ${config.data.c2cMax} 基点。`}
        </p>
        <label className="row">
          <input
            type="checkbox"
            checked={early}
            onChange={(e) => setEarly(e.target.checked)}
          />
          开启早鸟机制
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          我已核对不可变规则、费用和押金，并理解创建者结算责任。
        </label>
        <Button
          type="submit"
          disabled={
            !account ||
            !config.data ||
            busy ||
            !api.environment.features.newExposure
          }
        >
          {busy ? "请完成规则发布签名" : "发布规则并核对创建交易"}
        </Button>
      </form>
    </>
  );
}
export function CreatorMarketPage() {
  const params = useParams(),
    parsed = address.safeParse(params.market);
  return parsed.success ? (
    <CreatorMarket market={parsed.data} />
  ) : (
    <Notice tone="warning">市场地址无效。</Notice>
  );
}
function CreatorMarket({ market }: { market: Address }) {
  const { api, account } = useSession(),
    query = useMarket(market),
    rules = useRules(query.data),
    live = useMarketLive(market),
    request = useOperation(),
    [outcome, setOutcome] = useState("0"),
    [evidence, setEvidence] = useState(""),
    [error, setError] = useState("");
  const act = (kind: "resolve" | "creator-void") => {
    if (evidence.trim().length < 8) {
      setError(
        "请填写至少 8 个字符的证据说明及公开来源，确认时将展示其内容承诺。",
      );
      return;
    }
    setError("");
    const evidenceHash = keccak256(stringToHex(evidence.trim()));
    const intent: BusinessIntent =
      kind === "resolve"
        ? { kind, market, outcomeId: outcome, evidenceHash }
        : { kind, market, evidenceHash };
    request({
      intent,
      summary: [
        { label: "市场", value: rules.data?.question ?? market },
        {
          label: "结果",
          value:
            kind === "resolve"
              ? (rules.data?.outcomes[Number(outcome)] ?? outcome)
              : "创建者作废",
        },
        { label: "证据说明", value: evidence.trim() },
        { label: "证据哈希", value: evidenceHash },
      ],
      feeNote:
        "终局操作不可撤回。合约按现有规则结算收益或退款，网络 Gas 申请项目代付。请自行保存并公开证据原文；链上只保存其哈希。",
    });
  };
  return (
    <>
      <PageTitle
        title="市场结算管理"
        description="仅创建者控制此市场结果。证据说明生成哈希上链，原文请保存并公开。"
      />
      <AccountGate />
      <ErrorNotice error={query.error ?? rules.error ?? live.error} />
      {query.isPending && <Loading />}
      {query.data && (
        <div className="surface stack">
          <h2>{rules.data?.question ?? market}</h2>
          <Link to={`/${api.environment.id}/markets/${market}`}>
            查看用户市场页与规则
          </Link>
          <Notice>
            状态：{marketStatusCopy(query.data)}
            。已终局市场可在持仓与权益中结算和领取押金。
          </Notice>
          {account?.address.toLowerCase() !==
          query.data.creator.toLowerCase() ? (
            <Notice tone="warning">当前应用账户不是此市场创建者。</Notice>
          ) : live.data?.state === 0 ? (
            <>
              <Field label="获胜结果">
                <select
                  value={outcome}
                  onChange={(e) => setOutcome(e.target.value)}
                >
                  {rules.data?.outcomes.map((o, i) => (
                    <option key={i} value={i}>
                      {o}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="证据说明与公开链接">
                <textarea
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  maxLength={2048}
                />
              </Field>
              {error && <p role="alert">{error}</p>}
              <div className="row">
                <Button
                  disabled={
                    !rules.data ||
                    live.data.now <
                      BigInt(query.data.outcomeDeadlineAt ?? "0") ||
                    live.data.now > live.data.resolutionDeadline
                  }
                  onClick={() => act("resolve")}
                >
                  核对结果并结算
                </Button>
                <Button
                  variant="danger"
                  disabled={
                    !live.data || live.data.now > live.data.resolutionDeadline
                  }
                  onClick={() => act("creator-void")}
                >
                  核对规则并作废
                </Button>
              </div>
              <p className="small">
                结算须符合结果判断截止时间与结算窗口；实际执行由合约再次校验。
              </p>
            </>
          ) : (
            <Link to={`/${api.environment.id}/entitlements`}>
              查看押金与费用权益
            </Link>
          )}
        </div>
      )}
    </>
  );
}
