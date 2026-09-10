import {
  encodeMarketRules,
  marketRulesMatchTimes,
  type MarketRules,
} from "../../../offchain/sdk/src/market-rules.js";
import type { MarketSnapshot } from "./protocol.js";

export const RULES_UNAVAILABLE =
  "当前规则正文尚未读取或未通过校验，暂不能购买。请重新读取市场；撤单、领取和退款不受影响。";

/** Never pair a cached rule document with a different Vault snapshot. */
export function verifiedMarketRules(
  market: MarketSnapshot,
  rules: MarketRules | null,
): MarketRules | null {
  if (rules === null) return null;
  try {
    return encodeMarketRules(rules).rulesHash.toLowerCase() ===
      market.rulesHash.toLowerCase() &&
      rules.outcomes.length === market.outcomeCount &&
      marketRulesMatchTimes(rules, {
        ...market,
        resolutionDeadlineAt: market.resolutionDeadline,
      })
      ? rules
      : null;
  } catch {
    return null;
  }
}

export function MarketRulesDisclosure({
  market,
  rules,
}: {
  market: MarketSnapshot;
  rules: MarketRules | null;
}) {
  const verified = verifiedMarketRules(market, rules);
  return (
    <section className="panel market-rules" aria-label="购买前必读规则">
      <h2>购买前必读规则</h2>
      <p className="callout danger">
        本盘由 creator
        单方结算，协议与平台不裁决对错。结算一经链上生效不可撤销。
      </p>
      <dl className="definition-grid">
        <div>
          <dt>creator</dt>
          <dd className="mono">{market.creator}</dd>
        </div>
        <div>
          <dt>市场金库</dt>
          <dd className="mono">{market.address}</dd>
        </div>
      </dl>
      {verified === null ? (
        <p role="alert">{RULES_UNAVAILABLE}</p>
      ) : (
        <dl className="rules-content">
          <div>
            <dt>命题</dt>
            <dd>{verified.question}</dd>
          </div>
          <div>
            <dt>所有结果</dt>
            <dd>{verified.outcomes.join(" / ")}</dd>
          </div>
          <div>
            <dt>判定标准</dt>
            <dd>{verified.resolutionCriteria}</dd>
          </div>
          <div>
            <dt>判定来源</dt>
            <dd>{verified.resolutionSource}</dd>
          </div>
          <div>
            <dt>取消 / 作废条件</dt>
            <dd>{verified.cancellationPolicy}</dd>
          </div>
          <div>
            <dt>封盘时间</dt>
            <dd>{ruleTime(verified.closeAt)}</dd>
          </div>
          <div>
            <dt>事件开始</dt>
            <dd>
              {verified.eventStartsAt === null
                ? "未确定，无法确认是否提前封盘"
                : ruleTime(verified.eventStartsAt)}
            </dd>
          </div>
          <div>
            <dt>结果判断截止</dt>
            <dd>{ruleTime(verified.outcomeDeadlineAt)}</dd>
          </div>
          <div>
            <dt>结算超时截止</dt>
            <dd>{ruleTime(verified.resolutionDeadlineAt)}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}

function ruleTime(seconds: number): string {
  return new Date(seconds * 1_000).toLocaleString("zh-CN", {
    hour12: false,
    timeZoneName: "short",
  });
}
