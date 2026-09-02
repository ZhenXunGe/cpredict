import { useMemo, useState, type FormEvent } from "react";
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
  MAX_MARKET_DURATION_MINUTES,
  MIN_MARKET_DURATION_MINUTES,
} from "./create-market-times.js";
import {
  publishMarketMetadata,
  type PublishedMarketMetadata,
} from "./metadata-client.js";
import type { ConnectedWallet } from "./wallet.js";

export type ExecuteTransaction = <T extends TransactionResult>(
  label: string,
  operation: () => Promise<T>,
) => Promise<T | null>;

interface CreateMarketFormProps {
  client: CpredictClient;
  factory: Address;
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
}

type FieldName =
  | "question"
  | "outcomes"
  | "source"
  | "criteria"
  | "cancellation"
  | "duration"
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

export function CreateMarketForm(props: CreateMarketFormProps) {
  const [question, setQuestion] = useState(
    "Will the cited public result be Yes at market close?",
  );
  const [outcomeLabels, setOutcomeLabels] = useState("Yes\nNo");
  const [resolutionSource, setResolutionSource] = useState("https://");
  const [resolutionCriteria, setResolutionCriteria] = useState(
    "Resolve to the outcome explicitly reported by the cited public source after market close.",
  );
  const [cancellationPolicy, setCancellationPolicy] = useState(
    "Void the market if the cited source is unavailable or does not provide an unambiguous result during the resolution window.",
  );
  const [durationMinutes, setDurationMinutes] = useState("15");
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
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [stage, setStage] = useState<"idle" | "publishing">("idle");
  const salt = useMemo(() => randomBytes32(), []);

  function marketDraft() {
    const now = BigInt(Math.floor(Date.now() / 1_000));
    const minutes = parseInteger(durationMinutes, MIN_MARKET_DURATION_MINUTES, MAX_MARKET_DURATION_MINUTES, "市场期限");
    const { closeAt, earlyBirdStart } = buildCreateMarketTimes(now, minutes);
    const outcomes = outcomeLabels
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const rules: MarketRules = {
      version: "cpredict-rules-v1",
      question: question.trim(),
      outcomes,
      closesAt: Number(closeAt),
      resolutionSource: validatedUri(resolutionSource, "公开判定来源"),
      resolutionCriteria: resolutionCriteria.trim(),
      cancellationPolicy: cancellationPolicy.trim(),
    };
    return { rules, closeAt, earlyBirdStart };
  }

  function marketCapValue(): bigint {
    const cap = parsePositiveUsdc(marketCap, "市场总上限");
    const maximum = mode === "0"
      ? props.maxFullMarketCap
      : props.maxCloneMarketCap;
    if (cap > maximum)
      throw new RangeError(
        `${mode === "0" ? "Full" : "Clone"} 市场总上限不能超过 ${formatUsdc(maximum)} ${props.paymentTokenSymbol}`,
      );
    return cap;
  }

  function perUserCapValue(cap: bigint): bigint {
    const value = parsePositiveUsdc(perUserCap, "单用户一级上限");
    const maximum = props.maxPerUserPrimaryCap < cap
      ? props.maxPerUserPrimaryCap
      : cap;
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
      cap * 200n / 10_000n > 10_000_000n
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
      minimumC2CAmount: configuredMinimumValue(
        minimumC2C,
        "C2C 最小份额",
        cap,
      ),
      rake: parseInteger(
        rakeBps,
        0,
        props.maxCreatorRakeBps,
        "创建者抽成",
      ),
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
        earlyBirdStart: prepared.earlyBirdStart,
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
      if (!confirmed)
        throw new Error("请先确认不可变参数与创建者单方结算风险");
      const prepared = marketDraft();
      economicValues();
      setStage("publishing");
      const publication = await publishMarketMetadata({
        basePath: props.metadataBasePath,
        chainId: props.wallet.chainId,
        factory: props.factory,
        wallet: props.wallet,
        rules: prepared.rules,
      });
      const result = await props.execute("Create market", () =>
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
      await props.execute("Approve creation fee + bond", () =>
        props.client.approvePaymentToken(
          props.paymentToken,
          props.factory,
          amount,
        ),
      );
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "市场草稿无效");
    }
  }

  function validateForm(): boolean {
    const next: FieldErrors = {};
    const trimmedQuestion = question.trim();
    if (trimmedQuestion.length < 8) next.question = "市场问题至少需要 8 个字符";
    else if (trimmedQuestion.length > 512) next.question = "市场问题不能超过 512 个字符";
    const outcomes = outcomeLabels.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (outcomes.length < 2 || outcomes.length > 32) next.outcomes = "请填写 2–32 个非空结果，每行一个";
    else if (outcomes.some((value) => value.length > 128)) next.outcomes = "单个结果不能超过 128 个字符";
    else if (new Set(outcomes.map((value) => value.toLocaleLowerCase("en-US"))).size !== outcomes.length) next.outcomes = "结果名称不能重复";
    validate(next, "source", () => validatedUri(resolutionSource, "公开判定来源"));
    validateText(next, "criteria", resolutionCriteria, "判定方式", 8, 2_048);
    validateText(next, "cancellation", cancellationPolicy, "作废条件", 8, 2_048);
    validate(next, "duration", () => parseInteger(durationMinutes, MIN_MARKET_DURATION_MINUTES, MAX_MARKET_DURATION_MINUTES, "市场期限"));
    validate(next, "marketCap", marketCapValue);
    const cap = next.marketCap === undefined ? marketCapValue() : null;
    if (cap !== null) {
      validate(next, "perUserCap", () => perUserCapValue(cap));
      validate(next, "bond", () => bondValue(cap));
      validate(next, "minimumC2C", () =>
        configuredMinimumValue(minimumC2C, "C2C 最小份额", cap));
      if (next.perUserCap === undefined) {
        const userCap = perUserCapValue(cap);
        validate(next, "minimumPrimary", () =>
          configuredMinimumValue(minimumPrimary, "一级最小份额", userCap));
      }
    }
    validate(next, "rake", () =>
      parseInteger(rakeBps, 0, props.maxCreatorRakeBps, "创建者抽成"));
    validate(next, "c2cFee", () =>
      parseInteger(
        creatorC2CFeeBps,
        0,
        props.maxCreatorC2CFeeBps,
        "创建者 C2C 费率",
      ));
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

  const disabled =
    !props.writeReady ||
    props.busy ||
    stage !== "idle";
  const advancedError = ["perUserCap", "bond", "minimumPrimary", "minimumC2C", "rake", "c2cFee"].some((name) => fieldErrors[name as FieldName] !== undefined);

  return (
    <form
      className="market-create-form"
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <div className="form-grid">
        <label className="span-2">
          <span>市场问题</span>
          <input
            id="market-question"
            value={question}
            onChange={(event) => { setQuestion(event.currentTarget.value); clearField("question"); }}
            aria-invalid={fieldErrors.question !== undefined}
            aria-describedby={fieldErrors.question === undefined ? undefined : "market-question-error"}
            minLength={8}
            maxLength={512}
            required
          />
          <FieldError id="market-question-error" message={fieldErrors.question} />
        </label>
        <label>
          <span>结果选项（每行一个，2–32 个）</span>
          <textarea
            id="market-outcomes"
            value={outcomeLabels}
            onChange={(event) => { setOutcomeLabels(event.currentTarget.value); clearField("outcomes"); }}
            aria-invalid={fieldErrors.outcomes !== undefined}
            aria-describedby={fieldErrors.outcomes === undefined ? undefined : "market-outcomes-error"}
            rows={4}
            required
          />
          <FieldError id="market-outcomes-error" message={fieldErrors.outcomes} />
          <small>当前识别 {outcomeCount || "—"} 个结果</small>
        </label>
        <label>
          <span>公开判定来源</span>
          <input
            id="market-source"
            value={resolutionSource}
            onChange={(event) => { setResolutionSource(event.currentTarget.value); clearField("source"); }}
            aria-invalid={fieldErrors.source !== undefined}
            aria-describedby={fieldErrors.source === undefined ? undefined : "market-source-error"}
            maxLength={512}
            inputMode="url"
            spellCheck={false}
            required
          />
          <FieldError id="market-source-error" message={fieldErrors.source} />
          <small>结算时引用的公开网页或 IPFS 地址；平台不会代替该来源作判断。</small>
        </label>
        <label className="span-2">
          <span>如何判定结果</span>
          <textarea
            id="market-criteria"
            value={resolutionCriteria}
            onChange={(event) => { setResolutionCriteria(event.currentTarget.value); clearField("criteria"); }}
            aria-invalid={fieldErrors.criteria !== undefined}
            aria-describedby={fieldErrors.criteria === undefined ? undefined : "market-criteria-error"}
            rows={3}
            minLength={8}
            maxLength={2048}
            required
          />
          <FieldError id="market-criteria-error" message={fieldErrors.criteria} />
        </label>
        <label className="span-2">
          <span>何时作废</span>
          <textarea
            id="market-cancellation"
            value={cancellationPolicy}
            onChange={(event) => { setCancellationPolicy(event.currentTarget.value); clearField("cancellation"); }}
            aria-invalid={fieldErrors.cancellation !== undefined}
            aria-describedby={fieldErrors.cancellation === undefined ? undefined : "market-cancellation-error"}
            rows={3}
            minLength={8}
            maxLength={2048}
            required
          />
          <FieldError id="market-cancellation-error" message={fieldErrors.cancellation} />
        </label>
        <label>
          <span>市场期限（分钟，11–129600）</span>
          <input
            type="number"
            inputMode="numeric"
            min={MIN_MARKET_DURATION_MINUTES}
            max={MAX_MARKET_DURATION_MINUTES}
            step="1"
            value={durationMinutes}
            onChange={(event) => { setDurationMinutes(event.currentTarget.value); clearField("duration"); }}
            aria-invalid={fieldErrors.duration !== undefined}
            required
          />
          <FieldError message={fieldErrors.duration} />
        </label>
        <label>
          <span>市场总上限（{props.paymentTokenSymbol}）</span>
          <input
            inputMode="decimal"
            value={marketCap}
            onChange={(event) => { setMarketCap(event.currentTarget.value); clearField("marketCap"); }}
            aria-invalid={fieldErrors.marketCap !== undefined}
            required
          />
          <FieldError message={fieldErrors.marketCap} />
        </label>
      </div>

      <details className="advanced-settings" open={advancedError || undefined}>
        <summary>高级经济参数</summary>
        <div className="form-grid">
          <label><span>部署模式</span><select value={mode} onChange={(event) => setMode(event.currentTarget.value as "0" | "1")}><option value="0">Full — 推荐</option><option value="1">Clone — 高风险</option></select></label>
          <label><span>单用户一级上限</span><input inputMode="decimal" value={perUserCap} onChange={(event) => { setPerUserCap(event.currentTarget.value); clearField("perUserCap"); }} aria-invalid={fieldErrors.perUserCap !== undefined} /><FieldError message={fieldErrors.perUserCap} /></label>
          <label><span>创建者保证金（{props.paymentTokenSymbol}）</span><input inputMode="decimal" value={bond} onChange={(event) => { setBond(event.currentTarget.value); clearField("bond"); }} aria-invalid={fieldErrors.bond !== undefined} /><FieldError message={fieldErrors.bond} /></label>
          <label><span>一级最小份额</span><input inputMode="decimal" value={minimumPrimary} onChange={(event) => { setMinimumPrimary(event.currentTarget.value); clearField("minimumPrimary"); }} aria-invalid={fieldErrors.minimumPrimary !== undefined} /><FieldError message={fieldErrors.minimumPrimary} /></label>
          <label><span>C2C 最小份额</span><input inputMode="decimal" value={minimumC2C} onChange={(event) => { setMinimumC2C(event.currentTarget.value); clearField("minimumC2C"); }} aria-invalid={fieldErrors.minimumC2C !== undefined} /><FieldError message={fieldErrors.minimumC2C} /></label>
          <label><span>创建者抽成（bps）</span><input inputMode="numeric" value={rakeBps} onChange={(event) => { setRakeBps(event.currentTarget.value); clearField("rake"); }} aria-invalid={fieldErrors.rake !== undefined} /><FieldError message={fieldErrors.rake} /></label>
          <label><span>创建者 C2C 费率（bps）</span><input inputMode="numeric" value={creatorC2CFeeBps} onChange={(event) => { setCreatorC2CFeeBps(event.currentTarget.value); clearField("c2cFee"); }} aria-invalid={fieldErrors.c2cFee !== undefined} /><FieldError message={fieldErrors.c2cFee} /></label>
        </div>
        <div className="feature-row">
          <label><input type="checkbox" checked={earlyBird} onChange={(event) => setEarlyBird(event.currentTarget.checked)} /> Early-bird</label>
          <label><input type="checkbox" checked={permit2} onChange={(event) => setPermit2(event.currentTarget.checked)} /> Permit2</label>
        </div>
      </details>

      <dl className="definition-grid four review-grid">
        <div><dt>规则承诺</dt><dd className="mono">{previewRules?.rulesHash ?? "待补全"}</dd></div>
        <div><dt>结果数量</dt><dd>{outcomeCount || "待补全"}</dd></div>
        <div><dt>创建标识</dt><dd className="mono">{salt}</dd></div>
        <div><dt>创建费 + 保证金</dt><dd>{requiredPayment === null ? "待补全" : `${Number(requiredPayment) / 1e6} ${props.paymentTokenSymbol}`}</dd></div>
      </dl>
      <p className="callout">提交时先由钱包签名发布不可变规则，再单独确认创建交易；平台自动生成 Metadata URI，无需手工填写。</p>
      <label className="confirmation"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} /> 我已核对问题、结果、判定来源、时间、上限、费用、保证金与 Full/Clone 风险，并理解创建后经济参数不可改。</label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="button" disabled={!props.writeReady || props.busy || stage !== "idle"} onClick={() => void approve()}>精确授权创建费 + 保证金</button>
        <button className="button primary" disabled={disabled || !confirmed}>{stage === "publishing" ? "等待规则签名…" : "签名规则并创建市场"}</button>
      </div>
    </form>
  );
}

function FieldError(props: { id?: string; message: string | undefined }) {
  return props.message === undefined ? null : <small id={props.id} className="field-error">{props.message}</small>;
}

function validate(errors: FieldErrors, field: FieldName, operation: () => unknown): void {
  try {
    operation();
  } catch (cause: unknown) {
    errors[field] = cause instanceof Error ? cause.message : "字段无效";
  }
}

function validateText(errors: FieldErrors, field: FieldName, value: string, label: string, minimum: number, maximum: number): void {
  const length = value.trim().length;
  if (length < minimum) errors[field] = `${label}至少需要 ${minimum} 个字符`;
  else if (length > maximum) errors[field] = `${label}不能超过 ${maximum} 个字符`;
}

function validatedUri(value: string, label: string): string {
  const normalized = value.trim().normalize("NFC");
  if (new TextEncoder().encode(normalized).byteLength > 512)
    throw new RangeError(`${label} 超过 512 UTF-8 bytes`);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new TypeError(`${label} 必须是绝对 URI`);
  }
  if (url.protocol !== "https:" && url.protocol !== "ipfs:")
    throw new TypeError(`${label} 只允许 https: 或 ipfs:`);
  if (url.username !== "" || url.password !== "")
    throw new TypeError(`${label} 不允许 credentials`);
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
