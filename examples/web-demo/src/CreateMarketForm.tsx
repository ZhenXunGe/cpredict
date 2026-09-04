import { useEffect, useMemo, useState, type FormEvent } from "react";
import { parseUnits, type Address } from "viem";
import {
  encodeMarketRules,
  type CpredictClient,
  type CreateMarketInput,
  type CreateMarketResult,
  type MarketRules,
  type TransactionResult,
} from "../../../offchain/sdk/src/index.js";
import {
  buildCreateMarketTimes,
  assertCreationTimingExecutable,
  formatCreatorSettlementWindow,
} from "./create-market-times.js";
import {
  publishMarketMetadata,
  type PublishedMarketMetadata,
} from "./metadata-client.js";
import type { ConnectedWallet } from "./wallet.js";
import { authorizationRequired } from "../../react/src/authorizationFlow.js";

export type ExecuteTransaction = <T extends TransactionResult>(
  label: string,
  operation: () => Promise<T>,
) => Promise<T | null>;

interface CreateMarketFormProps {
  client: CpredictClient;
  factory: Address;
  factoryAllowance: bigint | null;
  paymentToken: Address;
  paymentTokenSymbol: string;
  creator: Address;
  creationFee: bigint;
  maxFullMarketCap: bigint;
  maxCloneMarketCap: bigint;
  maxPerUserPrimaryCap: bigint;
  maxCreatorRakeBps: number;
  maxCreatorC2CFeeBps: number;
  metadataBasePath: string;
  wallet: ConnectedWallet;
  writeReady: boolean;
  busy: boolean;
  execute: ExecuteTransaction;
  onMarketCreated: (result: CreateMarketResult) => Promise<void>;
  resolutionWindowSeconds?: number | null;
}

type FieldName =
  | "question"
  | "outcomes"
  | "source"
  | "criteria"
  | "cancellation"
  | "times"
  | "marketCap"
  | "perUserCap"
  | "bond"
  | "minimumPrimary"
  | "minimumC2C"
  | "rake"
  | "c2cFee";

type FieldErrors = Partial<Record<FieldName, string>>;

const MIN_CONFIGURED_UNITS = 10_000n;
const MAX_CONFIGURED_UNITS = 5_000_000n;
const MAX_CREATOR_BOND = 1_000_000_000n;
const DEFAULT_RESOLUTION_SOURCE = "http://example.com/result";

export function CreateMarketForm(props: CreateMarketFormProps) {
  const [question, setQuestion] = useState(
    "截止时，所引用的公开结果是否为「是」？",
  );
  const [outcomeLabels, setOutcomeLabels] = useState("是\n否");
  const [resolutionSource, setResolutionSource] = useState(
    DEFAULT_RESOLUTION_SOURCE,
  );
  const [resolutionCriteria, setResolutionCriteria] = useState(
    "按结果判断截止时间前所引用公开来源明确公布的结果进行结算。",
  );
  const [cancellationPolicy, setCancellationPolicy] = useState(
    "若事件取消、延期，或引用源在结果判断截止前未给出明确结果，则作废该市场。",
  );
  const [closeAtInput, setCloseAtInput] = useState("");
  const [eventStartsAtInput, setEventStartsAtInput] = useState("");
  const [eventStartUnknown, setEventStartUnknown] = useState(true);
  const [outcomeDeadlineAtInput, setOutcomeDeadlineAtInput] = useState("");
  const [mode, setMode] = useState<"0" | "1">("0");
  const [rakeBps, setRakeBps] = useState("200");
  const [creatorC2CFeeBps, setCreatorC2CFeeBps] = useState("0");
  const [perUserCap, setPerUserCap] = useState("10");
  const [marketCap, setMarketCap] = useState("20");
  const [minimumPrimary, setMinimumPrimary] = useState("1");
  const [minimumC2C, setMinimumC2C] = useState("1");
  const [bond, setBond] = useState("10");
  const [earlyBird, setEarlyBird] = useState(true);
  const [permit2, setPermit2] = useState(true);
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [stage, setStage] = useState<
    "idle" | "checking" | "authorizing" | "publishing"
  >("idle");
  const [factoryAllowance, setFactoryAllowance] = useState(
    props.factoryAllowance,
  );
  const salt = useMemo(() => randomBytes32(), []);
  const draftKey = JSON.stringify([
    props.factory,
    props.creator,
    props.wallet.chainId,
    props.paymentToken,
    props.creationFee.toString(),
    props.resolutionWindowSeconds,
    question,
    outcomeLabels,
    resolutionSource,
    resolutionCriteria,
    cancellationPolicy,
    closeAtInput,
    eventStartsAtInput,
    eventStartUnknown,
    outcomeDeadlineAtInput,
    mode,
    rakeBps,
    creatorC2CFeeBps,
    perUserCap,
    marketCap,
    minimumPrimary,
    minimumC2C,
    bond,
    earlyBird,
    permit2,
  ]);
  const confirmed = confirmedKey === draftKey;

  useEffect(
    () => setFactoryAllowance(props.factoryAllowance),
    [props.factory, props.factoryAllowance, props.creator],
  );

  function marketDraft() {
    const times = buildCreateMarketTimes({
      closeAt: closeAtInput,
      eventStartsAt: eventStartUnknown ? null : eventStartsAtInput,
      outcomeDeadlineAt: outcomeDeadlineAtInput,
      resolutionWindowSeconds: props.resolutionWindowSeconds,
    });
    const outcomes = outcomeLabels
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const rules: MarketRules = {
      version: "cpredict-rules-v2",
      question: question.trim(),
      outcomes,
      closeAt: Number(times.closeAt),
      eventStartsAt:
        times.eventStartsAt === null ? null : Number(times.eventStartsAt),
      outcomeDeadlineAt: Number(times.outcomeDeadlineAt),
      resolutionDeadlineAt: Number(times.resolutionDeadlineAt),
      resolutionSource: validatedUri(resolutionSource, "公开判定来源"),
      resolutionCriteria: resolutionCriteria.trim(),
      cancellationPolicy: cancellationPolicy.trim(),
    };
    return { rules, ...times };
  }

  function marketCapValue(): bigint {
    const cap = parsePositiveUsdc(marketCap, "市场总上限");
    const maximum =
      mode === "0" ? props.maxFullMarketCap : props.maxCloneMarketCap;
    if (cap > maximum)
      throw new RangeError(
        `${mode === "0" ? "Full" : "Clone"} 市场总上限不能超过 ${formatUsdc(maximum)} ${props.paymentTokenSymbol}`,
      );
    return cap;
  }

  function perUserCapValue(cap: bigint): bigint {
    const value = parsePositiveUsdc(perUserCap, "单用户一级上限");
    const maximum =
      props.maxPerUserPrimaryCap < cap ? props.maxPerUserPrimaryCap : cap;
    if (value > maximum)
      throw new RangeError(
        `单用户一级上限不能超过 ${formatUsdc(maximum)} ${props.paymentTokenSymbol}`,
      );
    return value;
  }

  function configuredMinimumValue(
    value: string,
    label: string,
    cap: bigint,
  ): bigint {
    const parsed = parsePositiveUsdc(value, label);
    const maximum = MAX_CONFIGURED_UNITS < cap ? MAX_CONFIGURED_UNITS : cap;
    if (parsed < MIN_CONFIGURED_UNITS || parsed > maximum)
      throw new RangeError(
        `${label}必须在 ${formatUsdc(MIN_CONFIGURED_UNITS)}–${formatUsdc(maximum)} ${props.paymentTokenSymbol}`,
      );
    return parsed;
  }

  function bondValue(cap: bigint): bigint {
    const bondAmount = parsePositiveUsdc(bond, "创建者保证金");
    const minimumRequiredBond =
      (cap * 200n) / 10_000n > 10_000_000n
        ? (cap * 200n + 9_999n) / 10_000n
        : 10_000_000n;
    if (bondAmount < minimumRequiredBond)
      throw new RangeError(
        `创建者保证金低于 max(10 ${props.paymentTokenSymbol}, 市场上限×2%)`,
      );
    if (bondAmount > MAX_CREATOR_BOND)
      throw new RangeError(
        `创建者保证金不能超过 1,000 ${props.paymentTokenSymbol}`,
      );
    return bondAmount;
  }

  function economicValues() {
    const cap = marketCapValue();
    const userCap = perUserCapValue(cap);
    return {
      cap,
      userCap,
      bondAmount: bondValue(cap),
      minimumPrimaryAmount: configuredMinimumValue(
        minimumPrimary,
        "一级最小份额",
        userCap,
      ),
      minimumC2CAmount: configuredMinimumValue(minimumC2C, "C2C 最小份额", cap),
      rake: parseInteger(rakeBps, 0, props.maxCreatorRakeBps, "创建者抽成"),
      c2cFee: parseInteger(
        creatorC2CFeeBps,
        0,
        props.maxCreatorC2CFeeBps,
        "创建者 C2C 费率",
      ),
    };
  }

  function draft(
    publication: PublishedMarketMetadata,
    prepared: ReturnType<typeof marketDraft>,
  ): CreateMarketInput {
    const values = economicValues();
    return {
      factory: props.factory,
      userSalt: salt,
      params: {
        ...publication,
        outcomeCount: prepared.rules.outcomes.length,
        closeAt: prepared.closeAt,
        eventStartsAt: prepared.eventStartsAt ?? 0n,
        outcomeDeadlineAt: prepared.outcomeDeadlineAt,
        creatorTreasury: props.creator,
        deploymentMode: mode === "0" ? 0 : 1,
        featureFlags: (earlyBird ? 1n : 0n) | (permit2 ? 2n : 0n),
        creatorRakeBps: values.rake,
        creatorC2CFeeBps: values.c2cFee,
        perUserPrimaryCap: values.userCap,
        marketPrimaryCap: values.cap,
        minimumPrimaryUnits: values.minimumPrimaryAmount,
        minimumC2CUnits: values.minimumC2CAmount,
        creatorBond: values.bondAmount,
      },
    };
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      if (!validateForm()) throw new Error("请先修正表单中标出的字段");
      if (!confirmed) throw new Error("请先确认不可变参数与创建者单方结算风险");
      const prepared = marketDraft();
      setStage("checking");
      assertCreationTimingExecutable(
        prepared,
        await props.client.readCreationTiming(props.factory),
      );
      const amount = economicValues().bondAmount + props.creationFee;
      if (authorizationRequired(factoryAllowance, amount)) {
        setStage("authorizing");
        if (!(await authorizePayment(amount))) return;
      }
      setStage("publishing");
      const publication = await publishMarketMetadata({
        basePath: props.metadataBasePath,
        chainId: props.wallet.chainId,
        factory: props.factory,
        wallet: props.wallet,
        rules: prepared.rules,
      });
      assertCreationTimingExecutable(
        prepared,
        await props.client.readCreationTiming(props.factory),
      );
      const result = await props.execute("创建市场", () =>
        props.client.createMarket(draft(publication, prepared)),
      );
      if (result !== null) await props.onMarketCreated(result);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "市场草稿无效");
    } finally {
      setStage("idle");
    }
  }

  async function approve() {
    setError("");
    try {
      if (!validateForm()) throw new Error("请先修正表单中标出的字段");
      const amount = economicValues().bondAmount + props.creationFee;
      setStage("authorizing");
      await authorizePayment(amount);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "市场草稿无效");
    } finally {
      setStage("idle");
    }
  }

  async function authorizePayment(amount: bigint): Promise<boolean> {
    const result = await props.execute("授权创建费 + 保证金", () =>
      props.client.approvePaymentToken(
        props.paymentToken,
        props.factory,
        amount,
      ),
    );
    if (result === null) return false;
    setFactoryAllowance(amount);
    return true;
  }

  function validateForm(): boolean {
    const next: FieldErrors = {};
    const trimmedQuestion = question.trim();
    if (trimmedQuestion.length < 8) next.question = "市场问题至少需要 8 个字符";
    else if (trimmedQuestion.length > 512)
      next.question = "市场问题不能超过 512 个字符";
    const outcomes = outcomeLabels
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (outcomes.length < 2 || outcomes.length > 32)
      next.outcomes = "请填写 2–32 个非空结果，每行一个";
    else if (outcomes.some((value) => value.length > 128))
      next.outcomes = "单个结果不能超过 128 个字符";
    else if (
      new Set(outcomes.map((value) => value.toLocaleLowerCase("en-US")))
        .size !== outcomes.length
    )
      next.outcomes = "结果名称不能重复";
    validate(next, "source", () =>
      validatedUri(resolutionSource, "公开判定来源"),
    );
    validateText(next, "criteria", resolutionCriteria, "判定方式", 8, 2_048);
    validateText(
      next,
      "cancellation",
      cancellationPolicy,
      "作废条件",
      8,
      2_048,
    );
    validate(next, "times", marketDraft);
    validate(next, "marketCap", marketCapValue);
    const cap = next.marketCap === undefined ? marketCapValue() : null;
    if (cap !== null) {
      validate(next, "perUserCap", () => perUserCapValue(cap));
      validate(next, "bond", () => bondValue(cap));
      validate(next, "minimumC2C", () =>
        configuredMinimumValue(minimumC2C, "C2C 最小份额", cap),
      );
      if (next.perUserCap === undefined) {
        const userCap = perUserCapValue(cap);
        validate(next, "minimumPrimary", () =>
          configuredMinimumValue(minimumPrimary, "一级最小份额", userCap),
        );
      }
    }
    validate(next, "rake", () =>
      parseInteger(rakeBps, 0, props.maxCreatorRakeBps, "创建者抽成"),
    );
    validate(next, "c2cFee", () =>
      parseInteger(
        creatorC2CFeeBps,
        0,
        props.maxCreatorC2CFeeBps,
        "创建者 C2C 费率",
      ),
    );
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  function clearField(name: FieldName) {
    setFieldErrors((current) => {
      if (current[name] === undefined) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  }

  let previewRules: ReturnType<typeof encodeMarketRules> | null = null;
  let requiredPayment: bigint | null = null;
  let outcomeCount = 0;
  try {
    const prepared = marketDraft();
    previewRules = encodeMarketRules(prepared.rules);
    outcomeCount = prepared.rules.outcomes.length;
    const values = economicValues();
    requiredPayment = values.bondAmount + props.creationFee;
  } catch {
    previewRules = null;
    requiredPayment = null;
  }

  const disabled = !props.writeReady || props.busy || stage !== "idle";
  const advancedError = [
    "perUserCap",
    "bond",
    "minimumPrimary",
    "minimumC2C",
    "rake",
    "c2cFee",
  ].some((name) => fieldErrors[name as FieldName] !== undefined);
  const needsAuthorization =
    requiredPayment !== null &&
    authorizationRequired(factoryAllowance, requiredPayment);

  return (
    <form
      className="market-create-form"
      onSubmit={(event) => void submit(event)}
      noValidate
      onChangeCapture={(event) => {
        if (
          !(event.target instanceof HTMLInputElement) ||
          event.target.name !== "confirm-creation"
        )
          setConfirmedKey(null);
      }}
    >
      <div className="form-grid">
        <label className="span-2">
          <span>市场问题</span>
          <input
            id="market-question"
            value={question}
            onChange={(event) => {
              setQuestion(event.currentTarget.value);
              clearField("question");
            }}
            aria-invalid={fieldErrors.question !== undefined}
            aria-describedby={
              fieldErrors.question === undefined
                ? undefined
                : "market-question-error"
            }
            minLength={8}
            maxLength={512}
            required
          />
          <FieldError
            id="market-question-error"
            message={fieldErrors.question}
          />
        </label>
        <label>
          <span>结果选项（每行一个，2–32 个）</span>
          <textarea
            id="market-outcomes"
            value={outcomeLabels}
            onChange={(event) => {
              setOutcomeLabels(event.currentTarget.value);
              clearField("outcomes");
            }}
            aria-invalid={fieldErrors.outcomes !== undefined}
            aria-describedby={
              fieldErrors.outcomes === undefined
                ? undefined
                : "market-outcomes-error"
            }
            rows={4}
            required
          />
          <FieldError
            id="market-outcomes-error"
            message={fieldErrors.outcomes}
          />
          <small>当前识别 {outcomeCount || "—"} 个结果</small>
        </label>
        <label>
          <span>公开判定来源</span>
          <input
            id="market-source"
            value={resolutionSource}
            onChange={(event) => {
              setResolutionSource(event.currentTarget.value);
              clearField("source");
            }}
            aria-invalid={fieldErrors.source !== undefined}
            aria-describedby={
              fieldErrors.source === undefined
                ? undefined
                : "market-source-error"
            }
            maxLength={512}
            inputMode="url"
            spellCheck={false}
            required
          />
          <FieldError id="market-source-error" message={fieldErrors.source} />
          <small>
            结算时引用的公开网页或 IPFS 地址；平台不会代替该来源作判断。
          </small>
        </label>
        <label className="span-2">
          <span>如何判定结果</span>
          <textarea
            id="market-criteria"
            value={resolutionCriteria}
            onChange={(event) => {
              setResolutionCriteria(event.currentTarget.value);
              clearField("criteria");
            }}
            aria-invalid={fieldErrors.criteria !== undefined}
            aria-describedby={
              fieldErrors.criteria === undefined
                ? undefined
                : "market-criteria-error"
            }
            rows={3}
            minLength={8}
            maxLength={2048}
            required
          />
          <FieldError
            id="market-criteria-error"
            message={fieldErrors.criteria}
          />
        </label>
        <label className="span-2">
          <span>何时作废</span>
          <textarea
            id="market-cancellation"
            value={cancellationPolicy}
            onChange={(event) => {
              setCancellationPolicy(event.currentTarget.value);
              clearField("cancellation");
            }}
            aria-invalid={fieldErrors.cancellation !== undefined}
            aria-describedby={
              fieldErrors.cancellation === undefined
                ? undefined
                : "market-cancellation-error"
            }
            rows={3}
            minLength={8}
            maxLength={2048}
            required
          />
          <FieldError
            id="market-cancellation-error"
            message={fieldErrors.cancellation}
          />
        </label>
        <fieldset className="span-2" disabled={disabled}>
          <legend>时间条款（全部为 UTC 绝对时间）</legend>
          <label>
            <span>封盘时间（UTC）</span>
            <input
              type="datetime-local"
              step="1"
              value={closeAtInput}
              required
              onChange={(event) => {
                setCloseAtInput(event.currentTarget.value);
                clearField("times");
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={eventStartUnknown}
              onChange={(event) => {
                setEventStartUnknown(event.currentTarget.checked);
                clearField("times");
              }}
            />
            事件开始时间未知
          </label>
          {!eventStartUnknown && (
            <label>
              <span>事件开始时间（UTC）</span>
              <input
                type="datetime-local"
                step="1"
                value={eventStartsAtInput}
                required
                onChange={(event) => {
                  setEventStartsAtInput(event.currentTarget.value);
                  clearField("times");
                }}
              />
            </label>
          )}
          {eventStartUnknown && (
            <p role="note">
              事件开始未知：无法验证是否在实际事件开始前封盘，参与者需注意提前获知结果的风险。
            </p>
          )}
          <label>
            <span>结果判断截止时间（UTC）</span>
            <input
              type="datetime-local"
              step="1"
              value={outcomeDeadlineAtInput}
              required
              onChange={(event) => {
                setOutcomeDeadlineAtInput(event.currentTarget.value);
                clearField("times");
              }}
            />
          </label>
          <FieldError message={fieldErrors.times} />
          <p>
            结算超时 = 结果判断截止 +{" "}
            {formatCreatorSettlementWindow(props.resolutionWindowSeconds)}
            ；窗口在创建时冻结。 creator
            可在封盘后提前结算，无须等到结果判断截止。到超时截止后，只能触发作废退款。
          </p>
          <p>
            已确认时间不会随刷新或重试延期；提交时按链上时间验证。填入时间不证明现实事件一定如期发生。
          </p>
        </fieldset>
        <label>
          <span>市场总上限（{props.paymentTokenSymbol}）</span>
          <input
            inputMode="decimal"
            value={marketCap}
            onChange={(event) => {
              setMarketCap(event.currentTarget.value);
              clearField("marketCap");
            }}
            aria-invalid={fieldErrors.marketCap !== undefined}
            required
          />
          <FieldError message={fieldErrors.marketCap} />
        </label>
      </div>

      <details className="advanced-settings" open={advancedError || undefined}>
        <summary>高级经济参数</summary>
        <div className="form-grid">
          <label>
            <span>部署模式</span>
            <select
              value={mode}
              onChange={(event) =>
                setMode(event.currentTarget.value as "0" | "1")
              }
            >
              <option value="0">Full — 推荐</option>
              <option value="1">Clone — 高风险</option>
            </select>
          </label>
          <label>
            <span>单用户一级上限</span>
            <input
              inputMode="decimal"
              value={perUserCap}
              onChange={(event) => {
                setPerUserCap(event.currentTarget.value);
                clearField("perUserCap");
              }}
              aria-invalid={fieldErrors.perUserCap !== undefined}
            />
            <FieldError message={fieldErrors.perUserCap} />
          </label>
          <label>
            <span>创建者保证金（{props.paymentTokenSymbol}）</span>
            <input
              inputMode="decimal"
              value={bond}
              onChange={(event) => {
                setBond(event.currentTarget.value);
                clearField("bond");
              }}
              aria-invalid={fieldErrors.bond !== undefined}
            />
            <FieldError message={fieldErrors.bond} />
          </label>
          <label>
            <span>一级最小份额</span>
            <input
              inputMode="decimal"
              value={minimumPrimary}
              onChange={(event) => {
                setMinimumPrimary(event.currentTarget.value);
                clearField("minimumPrimary");
              }}
              aria-invalid={fieldErrors.minimumPrimary !== undefined}
            />
            <FieldError message={fieldErrors.minimumPrimary} />
          </label>
          <label>
            <span>C2C 最小份额</span>
            <input
              inputMode="decimal"
              value={minimumC2C}
              onChange={(event) => {
                setMinimumC2C(event.currentTarget.value);
                clearField("minimumC2C");
              }}
              aria-invalid={fieldErrors.minimumC2C !== undefined}
            />
            <FieldError message={fieldErrors.minimumC2C} />
          </label>
          <label>
            <span>创建者抽成（bps）</span>
            <input
              inputMode="numeric"
              value={rakeBps}
              onChange={(event) => {
                setRakeBps(event.currentTarget.value);
                clearField("rake");
              }}
              aria-invalid={fieldErrors.rake !== undefined}
            />
            <FieldError message={fieldErrors.rake} />
          </label>
          <label>
            <span>创建者 C2C 费率（bps）</span>
            <input
              inputMode="numeric"
              value={creatorC2CFeeBps}
              onChange={(event) => {
                setCreatorC2CFeeBps(event.currentTarget.value);
                clearField("c2cFee");
              }}
              aria-invalid={fieldErrors.c2cFee !== undefined}
            />
            <FieldError message={fieldErrors.c2cFee} />
          </label>
        </div>
        <div className="feature-row">
          <label>
            <input
              type="checkbox"
              checked={earlyBird}
              onChange={(event) => setEarlyBird(event.currentTarget.checked)}
            />{" "}
            早鸟奖励
          </label>
          <label>
            <input
              type="checkbox"
              checked={permit2}
              onChange={(event) => setPermit2(event.currentTarget.checked)}
            />{" "}
            Permit2
          </label>
        </div>
      </details>

      <dl className="definition-grid four review-grid">
        <div>
          <dt>规则承诺</dt>
          <dd className="mono">{previewRules?.rulesHash ?? "待补全"}</dd>
        </div>
        <div>
          <dt>结果数量</dt>
          <dd>{outcomeCount || "待补全"}</dd>
        </div>
        <div>
          <dt>创建标识</dt>
          <dd className="mono">{salt}</dd>
        </div>
        <div>
          <dt>创建费 + 保证金</dt>
          <dd>
            {requiredPayment === null
              ? "待补全"
              : `${Number(requiredPayment) / 1e6} ${props.paymentTokenSymbol}`}
          </dd>
        </div>
      </dl>
      {previewRules !== null && (
        <p className="callout">
          结算超时（UTC）：
          {new Date(
            marketDraft().rules.resolutionDeadlineAt * 1_000,
          ).toISOString()}
          。 封盘后即可结算；此处不是新的等待期。
        </p>
      )}
      <p className="callout">
        提交时如额度不足会先请求精确授权，再由钱包签名发布不可变规则并单独确认创建交易；平台自动生成
        Metadata URI，无需手工填写。
      </p>
      <label className="confirmation">
        <input
          type="checkbox"
          name="confirm-creation"
          checked={confirmed}
          onChange={(event) =>
            setConfirmedKey(event.currentTarget.checked ? draftKey : null)
          }
        />{" "}
        我已核对问题、结果、判定来源、时间、上限、费用、保证金与 Full/Clone
        风险，并理解创建后经济参数不可改。
      </label>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <button
          type="button"
          className="button"
          disabled={!props.writeReady || props.busy || stage !== "idle"}
          onClick={() => void approve()}
        >
          精确授权创建费 + 保证金
        </button>
        <button className="button primary" disabled={disabled || !confirmed}>
          {stage === "checking"
            ? "核对链上时间…"
            : stage === "authorizing"
              ? "等待精确授权…"
              : stage === "publishing"
                ? "等待规则签名…"
                : needsAuthorization
                  ? "精确授权、签名并创建市场"
                  : "签名规则并创建市场"}
        </button>
      </div>
    </form>
  );
}

function FieldError(props: { id?: string; message: string | undefined }) {
  return props.message === undefined ? null : (
    <small id={props.id} className="field-error">
      {props.message}
    </small>
  );
}

function validate(
  errors: FieldErrors,
  field: FieldName,
  operation: () => unknown,
): void {
  try {
    operation();
  } catch (cause: unknown) {
    errors[field] = cause instanceof Error ? cause.message : "字段无效";
  }
}

function validateText(
  errors: FieldErrors,
  field: FieldName,
  value: string,
  label: string,
  minimum: number,
  maximum: number,
): void {
  const length = value.trim().length;
  if (length < minimum) errors[field] = `${label}至少需要 ${minimum} 个字符`;
  else if (length > maximum)
    errors[field] = `${label}不能超过 ${maximum} 个字符`;
}

export function validatedUri(value: string, label: string): string {
  const normalized = value.trim().normalize("NFC");
  if (new TextEncoder().encode(normalized).byteLength > 512)
    throw new RangeError(`${label} 超过 512 字节`);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new TypeError(`${label} 必须是绝对 URI`);
  }
  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    url.protocol !== "ipfs:"
  ) {
    throw new TypeError(`${label} 只允许 http:、https: 或 ipfs:`);
  }
  if (url.username !== "" || url.password !== "")
    throw new TypeError(`${label} 不允许用户名密码`);
  return url.href;
}

function parsePositiveUsdc(value: string, label: string): bigint {
  const result = parseUnits(value.trim(), 6);
  if (result <= 0n) throw new RangeError(`${label} 必须大于 0`);
  return result;
}

function formatUsdc(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

function parseInteger(
  value: string,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value.trim()))
    throw new TypeError(`${label} 必须是整数`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum)
    throw new RangeError(`${label} 必须在 ${minimum}–${maximum}`);
  return result;
}

function randomBytes32(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
