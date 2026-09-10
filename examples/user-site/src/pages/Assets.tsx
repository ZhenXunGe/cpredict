import { useState, type FormEvent } from "react";
import {
  address,
  AppError,
} from "../../../../offchain/app-core/src/contracts.js";
import { AccountGate, useOperation } from "../operations.js";
import { useSession } from "../wallets.js";
import { useBalance } from "../data.js";
import {
  AddressText,
  Amount,
  Button,
  ErrorNotice,
  Field,
  Notice,
  PageTitle,
} from "../ui.js";
import { parseAssetAmount } from "../amounts.js";
export function AssetsPage() {
  const session = useSession(),
    balance = useBalance(),
    begin = useOperation(),
    env = session.api.environment;
  const [recipient, setRecipient] = useState(""),
    [amount, setAmount] = useState(""),
    [error, setError] = useState<unknown>(null);
  const transfer = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const target = address.parse(recipient.trim()),
        value = parseAssetAmount(amount);
      if (balance.data === undefined || value > balance.data)
        throw new AppError("insufficient_balance", 400);
      begin({
        intent: {
          kind: "transfer",
          recipient: target,
          amount: value.toString(),
        },
        summary: [
          { label: "转出资产", value: `${amount} ${env.asset}` },
          { label: "接收地址", value: target },
        ],
        feeNote:
          "仅转出当前环境的测试支付资产。项目代付准入通过后承担本次网络 Gas；不会自动扣取 USDC 作为 Gas。",
      });
    } catch (e) {
      setError(e);
    }
  };
  return (
    <>
      <PageTitle
        title="我的资产"
        description="控制钱包用于签名，余额与交易属于当前应用资产账户。"
      />
      <AccountGate />
      {session.account && (
        <div className="grid-two">
          <section className="surface stack">
            <div>
              <p className="small">可用测试资产</p>
              <div className="balance-value">
                <Amount value={balance.data?.toString()} asset={env.asset} />
              </div>
            </div>
            <ErrorNotice
              error={balance.error}
              retry={() => void balance.refetch()}
            />
            <Field label="当前应用账户">
              <select
                value={session.account.id}
                onChange={(e) => session.selectAccount(e.target.value)}
              >
                {session.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.walletKind === "embedded"
                      ? "内嵌钱包控制"
                      : "外部钱包控制"}{" "}
                    · {a.address.slice(0, 8)}…{a.address.slice(-4)}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <h3>充值地址</h3>
              <p className="small">
                仅接收 Arbitrum Sepolia 上本环境支持的 {env.asset}。
              </p>
              <AddressText
                value={session.account.address}
                explorer={env.explorerUrl}
                full
              />
            </div>
            <Notice tone="warning">
              这是应用智能账户的地址，与控制钱包地址不同。请勿转入主网资产或不支持的代币。
            </Notice>
            {env.asset === "ctUSD" && (
              <>
                <Button
                  disabled={!env.features.faucet || !env.features.sponsorship}
                  onClick={() =>
                    begin({
                      intent: { kind: "faucet" },
                      summary: [
                        { label: "领取数量", value: "1,000 ctUSD" },
                        { label: "到账账户", value: session.account!.address },
                      ],
                      feeNote:
                        "每个应用账户每 24 小时可获项目代付领取一次。首次账户部署一并申请赞助；不限制代币合约本身的公开铸造能力。",
                    })
                  }
                >
                  领取 1,000 ctUSD
                </Button>
                <p className="small">
                  每账户每 24 小时一次。测试币与排行榜均无奖励价值。
                </p>
                {(!env.features.faucet || !env.features.sponsorship) && (
                  <Notice>当前暂停项目代付领币，已有资产仍可查看。</Notice>
                )}
              </>
            )}
          </section>
          <section className="surface">
            <h2>转出测试资产</h2>
            <p className="small">请核对接收地址，链上确认后无法撤销。</p>
            <form
              className="stack"
              style={{ marginTop: 22 }}
              onSubmit={transfer}
            >
              <Field label="接收地址">
                <input
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="0x…"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  required
                />
              </Field>
              <Field
                label={`转出数量（${env.asset}）`}
                hint="最多支持 6 位小数。"
              >
                <input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </Field>
              <ErrorNotice error={error} />
              <Button type="submit" disabled={balance.data === undefined}>
                核对转出
              </Button>
              <p className="small">
                网络 Gas
                将单独申请项目代付。代付不可用时，请查看账户与帮助中的独立退出说明。
              </p>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
