import { useState } from "react";
import { Link } from "react-router-dom";
import { AccountGate } from "../operations.js";
import { useSession } from "../wallets.js";
import {
  AddressText,
  Button,
  ErrorNotice,
  Notice,
  PageTitle,
  shortAddress,
} from "../ui.js";
export function HelpPage() {
  const session = useSession(),
    env = session.api.environment,
    [error, setError] = useState<unknown>(null);
  return (
    <>
      <PageTitle
        title="账户与帮助"
        description="了解资产归属、钱包恢复与测试站的边界。"
      />
      <div className="stack">
        <a href="/third-party/index.html">第三方软件声明与许可</a>
        <section className="surface">
          <AccountGate />
          {session.account && (
            <>
              <h2>当前账户</h2>
              <dl className="data-list">
                <dt>应用资产地址</dt>
                <dd>
                  <AddressText
                    value={session.account.address}
                    explorer={env.explorerUrl}
                    full
                  />
                </dd>
                <dt>控制钱包</dt>
                <dd>
                  <AddressText value={session.account.controller} full />
                </dd>
                <dt>账户版本</dt>
                <dd>Kernel 3.1 · EntryPoint 0.7</dd>
                <dt>当前环境</dt>
                <dd>{env.label}</dd>
              </dl>
              <div className="row">
                {session.account.walletKind === "embedded" && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setError(null);
                      void session.exportController().catch(setError);
                    }}
                  >
                    通过 Privy 导出控制钱包
                  </Button>
                )}
                <Button
                  variant="secondary"
                  onClick={() => {
                    if (!session.account) return;
                    const blob = new Blob(
                      [
                        JSON.stringify(
                          {
                            environment: env,
                            controller: session.account.controller,
                            assetAddress: session.account.address,
                          },
                          null,
                          2,
                        ),
                      ],
                      { type: "application/json" },
                    );
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = `cpredict-recovery-${env.id}-${session.account.address}.json`;
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  下载账户恢复配置
                </Button>
                <Button variant="secondary" onClick={session.linkWallet}>
                  验证其他控制钱包
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => void session.logout().catch(setError)}
                >
                  退出登录
                </Button>
              </div>
              <ErrorNotice error={error} />
            </>
          )}
        </section>
        <section className="surface prose">
          <h2>资产归属与账户切换</h2>
          <p>
            控制钱包只负责签名，交易份额、支付资产和待领取权益属于应用智能账户。我们不会根据邮箱、昵称或关联登录方式合并资产。
          </p>
          {session.accounts.length > 1 && (
            <div className="stack" style={{ marginTop: 16 }}>
              {session.accounts.map((a) => (
                <Button
                  key={a.id}
                  variant="secondary"
                  onClick={() => session.selectAccount(a.id)}
                >
                  {a.id === session.account?.id ? "当前账户：" : "切换到："}
                  {shortAddress(a.address)}
                </Button>
              ))}
            </div>
          )}
          <h3>导出与独立恢复</h3>
          <p>
            Privy
            官方导出窗口提供控制钱包的密钥，应用和服务器不会读取密钥。导出后，资产仍在上面的应用智能账户，不能直接当作普通钱包余额使用。
          </p>
          <p>
            使用支持相同 Kernel 版本的 ZeroDev
            SDK，连接恢复后的控制钱包，并使用此环境的固定派生配置，即可核对相同应用地址。独立操作需要可用
            RPC、Bundler 和 Gas
            来源；若项目代付中断，需要自行提供网络费用，并再次确认。
          </p>
          <details>
            <summary>查看账户恢复配置</summary>
            <pre
              className="small"
              style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
            >
              {JSON.stringify(
                {
                  environment: env.id,
                  deployment: env.deployment.id,
                  chainId: env.deployment.chainId,
                  kernelVersion: env.account.kernelVersion,
                  entryPointVersion: env.account.entryPointVersion,
                  index: env.account.index,
                  controller: session.account?.controller ?? null,
                  assetAddress: session.account?.address ?? null,
                },
                null,
                2,
              )}
            </pre>
            <a
              href="https://docs.zerodev.app/onboarding/create-a-smart-account"
              target="_blank"
              rel="noreferrer"
            >
              ZeroDev 官方账户接入说明
            </a>
          </details>
          <p>
            <a href="/recovery.html" target="_blank" rel="noreferrer">
              独立恢复操作说明
            </a>
          </p>
        </section>
        <section className="surface prose">
          <h2>测试规则与常见问题</h2>
          <h3>谁决定市场结果？</h3>
          <p>
            创建者按公布规则决定结果，结果可能依赖创建者判断。请在参与前阅读结算标准、时间和作废条件；封盘后的
            C2C 交易仍有结果与流动性风险。
          </p>
          <h3>为何成交后余额暂未变化？</h3>
          <p>
            链上确认与索引同步是两个阶段。已确认交易保持成功状态，页面同步失败不会把它改为失败。请在
            <Link to={`/${env.id}/history`}>交易历史</Link>
            查询原交易，避免重复提交。
          </p>
          <h3>收益为何显示未知？</h3>
          <p>
            外部转入的份额可能缺少取得成本，历史数据也可能尚未追齐。此时只展示有依据的部分，不会按零成本计算完整净收益，也不会将不完整结果计入排行榜。
          </p>
          <h3>测试排行榜代表什么？</h3>
          <p>
            仅统计公布市场和期间内、成本完整的已实现净收益。ctUSD
            可公开铸造，关联账户也无法被完全识别，因此榜单不能证明投资能力，没有奖励。
          </p>
          <Notice tone="warning">
            请勿向任何反馈渠道提供私钥、助记词、访问令牌或可执行签名。
          </Notice>
          <Link className="button button-secondary" to={`/${env.id}/feedback`}>
            提交测试反馈
          </Link>
        </section>
      </div>
    </>
  );
}
