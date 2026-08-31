import { useMemo, useState, type FormEvent } from "react";
import { keccak256, parseUnits, toBytes, type Address } from "viem";
import type { CpredictClient, CreateMarketInput, TransactionResult } from "../../../offchain/sdk/src/index.js";
import { buildCreateMarketTimes } from "./create-market-times.js";

interface CreateMarketFormProps {
  client: CpredictClient;
  factory: Address;
  paymentToken: Address;
  paymentTokenSymbol: string;
  creator: Address;
  creationFee: bigint;
  writeReady: boolean;
  busy: boolean;
  execute: (label: string, operation: () => Promise<TransactionResult>) => Promise<void>;
}

export function CreateMarketForm(props: CreateMarketFormProps) {
  const [rules, setRules] = useState("Result is determined by the cited public source at the stated close time.");
  const [metadataURI, setMetadataURI] = useState("ipfs://");
  const [resolutionSourceURI, setResolutionSourceURI] = useState("https://");
  const [outcomeCount, setOutcomeCount] = useState("2");
  const [durationDays, setDurationDays] = useState("7");
  const [mode, setMode] = useState<"0" | "1">("0");
  const [rakeBps, setRakeBps] = useState("200");
  const [creatorC2CFeeBps, setCreatorC2CFeeBps] = useState("0");
  const [perUserCap, setPerUserCap] = useState("100");
  const [marketCap, setMarketCap] = useState("500");
  const [minimumPrimary, setMinimumPrimary] = useState("1");
  const [minimumC2C, setMinimumC2C] = useState("1");
  const [bond, setBond] = useState("10");
  const [earlyBird, setEarlyBird] = useState(true);
  const [permit2, setPermit2] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const salt = useMemo(() => randomBytes32(), []);

  function draft(): CreateMarketInput {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const days = parseInteger(durationDays, 1, 90, "市场期限");
    const { closeAt, earlyBirdStart } = buildCreateMarketTimes(now, days);
    const outcomes = parseInteger(outcomeCount, 2, 32, "outcomeCount");
    const cap = parsePositiveUsdc(marketCap, "market cap");
    const bondAmount = parsePositiveUsdc(bond, "creator bond");
    const minimumRequiredBond = cap * 200n / 10_000n > 10_000_000n ? (cap * 200n + 9_999n) / 10_000n : 10_000_000n;
    if (bondAmount < minimumRequiredBond) throw new RangeError(`creator bond 低于 max(10 ${props.paymentTokenSymbol}, cap×2%)`);
    if (mode === "0" && cap > 5_000_000_000n) throw new RangeError(`Full market cap 超过 5,000 ${props.paymentTokenSymbol}`);
    if (mode === "1" && cap > 500_000_000n) throw new RangeError(`Clone market cap 超过 500 ${props.paymentTokenSymbol}`);
    const source = validatedUri(resolutionSourceURI, "resolution source URI");
    const metadata = validatedUri(metadataURI, "metadata URI");
    const normalizedRules = rules.trim().normalize("NFC");
    if (normalizedRules.length === 0 || new TextEncoder().encode(normalizedRules).byteLength > 4_096) {
      throw new RangeError("规则文本必须为 1–4096 UTF-8 bytes");
    }
    return {
      factory: props.factory,
      userSalt: salt,
      params: {
        rulesHash: keccak256(toBytes(normalizedRules)),
        metadataURI: metadata,
        resolutionSourceHash: keccak256(toBytes(source)),
        resolutionSourceURI: source,
        outcomeCount: outcomes,
        closeAt,
        earlyBirdStart,
        creatorTreasury: props.creator,
        deploymentMode: mode === "0" ? 0 : 1,
        featureFlags: (earlyBird ? 1n : 0n) | (permit2 ? 2n : 0n),
        creatorRakeBps: parseInteger(rakeBps, 0, 1_000, "creator rake"),
        creatorC2CFeeBps: parseInteger(creatorC2CFeeBps, 0, 200, "creator C2C fee"),
        perUserPrimaryCap: parsePositiveUsdc(perUserCap, "per-user cap"),
        marketPrimaryCap: cap,
        minimumPrimaryUnits: parsePositiveUsdc(minimumPrimary, "minimum primary"),
        minimumC2CUnits: parsePositiveUsdc(minimumC2C, "minimum C2C"),
        creatorBond: bondAmount,
      },
    };
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const value = draft();
      setError("");
      if (!confirmed) throw new Error("请先确认不可变参数与 Creator 单方结算风险");
      void props.execute("Create market", () => props.client.createMarket(value));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "invalid market draft");
    }
  }

  let preview: CreateMarketInput | null = null;
  try { preview = draft(); } catch { preview = null; }
  const requiredPayment = preview === null ? null : preview.params.creatorBond + props.creationFee;

  return (
    <form className="market-create-form" onSubmit={review}>
      <div className="form-grid">
        <label className="span-2"><span>锁定规则原文</span><textarea value={rules} onChange={(event) => setRules(event.currentTarget.value)} rows={4} maxLength={4096} /></label>
        <label><span>Metadata URI</span><input value={metadataURI} onChange={(event) => setMetadataURI(event.currentTarget.value)} maxLength={512} spellCheck={false} /></label>
        <label><span>Resolution source URI</span><input value={resolutionSourceURI} onChange={(event) => setResolutionSourceURI(event.currentTarget.value)} maxLength={512} spellCheck={false} /></label>
        <label><span>Outcomes (2–32)</span><input inputMode="numeric" value={outcomeCount} onChange={(event) => setOutcomeCount(event.currentTarget.value)} /></label>
        <label><span>Duration days (1–90)</span><input inputMode="numeric" value={durationDays} onChange={(event) => setDurationDays(event.currentTarget.value)} /></label>
        <label><span>Deployment mode</span><select value={mode} onChange={(event) => setMode(event.currentTarget.value as "0" | "1")}><option value="0">Full — recommended</option><option value="1">Clone — higher risk</option></select></label>
        <label><span>Market cap ({props.paymentTokenSymbol})</span><input inputMode="decimal" value={marketCap} onChange={(event) => setMarketCap(event.currentTarget.value)} /></label>
        <label><span>Per-user primary cap</span><input inputMode="decimal" value={perUserCap} onChange={(event) => setPerUserCap(event.currentTarget.value)} /></label>
        <label><span>Creator bond ({props.paymentTokenSymbol})</span><input inputMode="decimal" value={bond} onChange={(event) => setBond(event.currentTarget.value)} /></label>
        <label><span>Minimum primary shares</span><input inputMode="decimal" value={minimumPrimary} onChange={(event) => setMinimumPrimary(event.currentTarget.value)} /></label>
        <label><span>Minimum C2C shares</span><input inputMode="decimal" value={minimumC2C} onChange={(event) => setMinimumC2C(event.currentTarget.value)} /></label>
        <label><span>Creator rake (bps)</span><input inputMode="numeric" value={rakeBps} onChange={(event) => setRakeBps(event.currentTarget.value)} /></label>
        <label><span>Creator C2C fee (bps)</span><input inputMode="numeric" value={creatorC2CFeeBps} onChange={(event) => setCreatorC2CFeeBps(event.currentTarget.value)} /></label>
      </div>
      <div className="feature-row">
        <label><input type="checkbox" checked={earlyBird} onChange={(event) => setEarlyBird(event.currentTarget.checked)} /> Early-bird</label>
        <label><input type="checkbox" checked={permit2} onChange={(event) => setPermit2(event.currentTarget.checked)} /> Permit2</label>
      </div>
      <dl className="definition-grid four review-grid">
        <div><dt>rulesHash</dt><dd className="mono">{preview?.params.rulesHash ?? "invalid"}</dd></div>
        <div><dt>sourceHash</dt><dd className="mono">{preview?.params.resolutionSourceHash ?? "invalid"}</dd></div>
        <div><dt>userSalt</dt><dd className="mono">{salt}</dd></div>
        <div><dt>fee + bond</dt><dd>{requiredPayment === null ? "invalid" : `${Number(requiredPayment) / 1e6} ${props.paymentTokenSymbol}`}</dd></div>
      </dl>
      <label className="confirmation"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} /> 我已核对锁定规则、时间、上限、费用、bond、Full/Clone 风险，并理解创建后经济参数不可改。</label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="button" disabled={!props.writeReady || props.busy || requiredPayment === null} onClick={() => requiredPayment === null ? undefined : void props.execute("Approve creation fee + bond", () => props.client.approvePaymentToken(props.paymentToken, props.factory, requiredPayment))}>精确授权 fee + bond</button>
        <button className="button primary" disabled={!props.writeReady || props.busy || !confirmed || preview === null}>创建不可变市场</button>
      </div>
    </form>
  );
}

function validatedUri(value: string, label: string): string {
  const normalized = value.trim().normalize("NFC");
  if (new TextEncoder().encode(normalized).byteLength > 512) throw new RangeError(`${label} 超过 512 UTF-8 bytes`);
  let url: URL;
  try { url = new URL(normalized); } catch { throw new TypeError(`${label} 必须是绝对 URI`); }
  if (url.protocol !== "https:" && url.protocol !== "ipfs:") throw new TypeError(`${label} 只允许 https: 或 ipfs:`);
  if (url.username !== "" || url.password !== "") throw new TypeError(`${label} 不允许 credentials`);
  return url.href;
}

function parsePositiveUsdc(value: string, label: string): bigint {
  const result = parseUnits(value.trim(), 6);
  if (result <= 0n) throw new RangeError(`${label} 必须大于 0`);
  return result;
}

function parseInteger(value: string, minimum: number, maximum: number, label: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value.trim())) throw new TypeError(`${label} 必须是整数`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new RangeError(`${label} 必须在 ${minimum}–${maximum}`);
  return result;
}

function randomBytes32(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
