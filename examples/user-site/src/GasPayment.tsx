import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatEther, type Hex } from "viem";
import {
  AppError,
  type GasPayment,
} from "../../../offchain/app-core/src/contracts.js";
import { useSession } from "./wallets.js";
import { fundGas, gasBalance } from "./gas-payment.js";
import { AddressText, Button, ErrorNotice, Notice } from "./ui.js";

export function GasPaymentPanel({
  payment,
  onChange,
  disabled,
}: {
  payment: GasPayment;
  onChange: (payment: GasPayment) => void;
  disabled: boolean;
}) {
  const session = useSession(),
    account = session.account;
  const paymentId = useId();
  const [amount, setAmount] = useState("0.005"),
    [funding, setFunding] = useState(false),
    [error, setError] = useState<unknown>(null),
    [fundingHash, setFundingHash] = useState<Hex | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const balance = useQuery({
    queryKey: [session.api.key, "gas-balance", account?.id],
    enabled: !!account && payment === "self-funded",
    queryFn: () => gasBalance(session.api.publicClient(), account!),
    refetchInterval: payment === "self-funded" ? 10000 : false,
    retry: 1,
  });
  const fund = async () => {
    if (!account || funding || disabled) return;
    setFunding(true);
    setError(null);
    setFundingHash(null);
    try {
      const provider = await session.controller(account);
      if (!mounted.current) return;
      const hash = await fundGas(
        provider,
        account,
        amount,
        () => mounted.current,
      );
      if (!mounted.current) return;
      setFundingHash(hash);
      const receipt = await session.api
        .publicClient()
        .waitForTransactionReceipt({ hash, confirmations: 2, timeout: 120000 });
      if (receipt.status !== "success")
        throw new AppError("gas_funding_reverted", 409);
      if (mounted.current) await balance.refetch();
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof AppError
            ? e
            : new AppError("gas_funding_query_required", 503),
        );
    } finally {
      if (mounted.current) setFunding(false);
    }
  };
  return (
    <section className="stack" aria-label="网络费用">
      <label htmlFor={paymentId}>Gas 支付方式</label>
      <select
        id={paymentId}
        value={payment}
        disabled={disabled || funding}
        onChange={(e) => onChange(e.target.value as GasPayment)}
      >
        <option
          value="sponsored"
          disabled={!session.api.environment.features.sponsorship}
        >
          项目代付
        </option>
        <option value="self-funded">自行支付 ETH Gas</option>
      </select>
      {payment === "self-funded" && account && (
        <>
          <Notice>
            网络费用从当前智能账户的 ETH 支付。交易提交前会显示最大 Gas
            费用，并再次征求你的确认。
          </Notice>
          <p className="small">
            可用 Gas 余额：
            {balance.data === undefined
              ? "查询中"
              : `${formatEther(balance.data)} ETH`}
          </p>
          <details>
            <summary>向智能账户补充 ETH</summary>
            <div className="stack">
              <p className="small">网络：Arbitrum Sepolia。接收地址：</p>
              <AddressText value={account.address} full />
              <p className="small">
                控制钱包转出 ETH，并支付这笔转账的 Gas。到账后再确认业务交易。
              </p>
              <label>
                转入金额（ETH）
                <input
                  inputMode="decimal"
                  value={amount}
                  disabled={disabled || funding}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </label>
              <Button
                variant="secondary"
                disabled={disabled || funding}
                onClick={() => void fund()}
              >
                {funding ? "等待钱包或链上确认" : "在钱包中确认转入"}
              </Button>
              <Button
                variant="quiet"
                disabled={funding}
                onClick={() => void balance.refetch()}
              >
                刷新 ETH 余额
              </Button>
              {fundingHash && (
                <a
                  href={`${session.api.environment.explorerUrl}/tx/${fundingHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  查看 ETH 转入交易
                </a>
              )}
            </div>
          </details>
          <ErrorNotice error={error ?? balance.error} />
        </>
      )}
    </section>
  );
}
