import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createPublicClient,
  http,
  formatEther,
  formatUnits,
  type EIP1193Provider,
  type Hex,
} from "viem";
import { arbitrumSepolia } from "viem/chains";
import {
  createBundlerClient,
  getUserOperationHash,
  type UserOperation,
  entryPoint07Abi,
} from "viem/account-abstraction";
import { createKernelAccountClient } from "@zerodev/sdk";
import { z } from "zod";
import {
  AppError,
  address,
  environmentSchema,
  hash,
  intentSchema,
  sameAddress,
  secureUrl,
  uint,
  type BusinessIntent,
  type Environment,
} from "../../../offchain/app-core/src/contracts.js";
import {
  createAppKernel,
  assertCurrentController,
  ENTRY_POINT,
} from "../../../offchain/app-core/src/kernel.js";
import { ProtocolAdmissionReader } from "../../../offchain/app-core/src/admission-reader.js";
import { operationEvent } from "../../../offchain/app-core/src/receipt.js";
import { buildBusinessCalls } from "../../../offchain/app-core/src/calls.js";
import { verifyDeployment } from "../../../offchain/app-service/src/chain.js";
import { parseAssetAmount } from "./amounts.js";
import {
  AddressText,
  Button,
  ErrorNotice,
  Field,
  Notice,
  PageTitle,
} from "./ui.js";
import "./site.css";
const recoveryConfigSchema = z.strictObject({
  environment: environmentSchema,
  controller: address,
  assetAddress: address,
});
const journalSchema = z.strictObject({
  environment: z.string(),
  manifestHash: hash,
  account: address,
  nonce: uint,
  userOperationHash: hash,
  createdAt: z.string(),
  intent: intentSchema,
});
type Journal = z.infer<typeof journalSchema>;
type Prepared = {
  environment: Environment;
  account: Awaited<ReturnType<typeof createAppKernel>>;
  unsigned: UserOperation<"0.7">;
  rpcUrl: string;
  bundlerUrl: string;
  cost: bigint;
  balance: bigint;
  intent: BusinessIntent;
  key: string;
  revision: string;
  controller: `0x${string}`;
  provider: EIP1193Provider;
};
function journalKey(config: z.infer<typeof recoveryConfigSchema>) {
  return `cpredict-recovery:${config.environment.id}:${config.environment.deployment.manifestHash}:${config.assetAddress.toLowerCase()}`;
}
async function assertWallet(
  provider: EIP1193Provider,
  controller: `0x${string}`,
) {
  const owners = z
    .array(address)
    .parse(await provider.request({ method: "eth_accounts" }));
  if (!owners[0] || !sameAddress(owners[0], controller))
    throw new AppError("controller_not_linked", 403);
  if ((await provider.request({ method: "eth_chainId" })) !== "0x66eee")
    throw new AppError("environment_mismatch");
}
function Recovery() {
  const [configuration, setConfiguration] = useState(""),
    [rpcUrl, setRpcUrl] = useState(""),
    [bundlerUrl, setBundlerUrl] = useState(""),
    [kind, setKind] = useState("transfer"),
    [market, setMarket] = useState(""),
    [listing, setListing] = useState(""),
    [recipient, setRecipient] = useState(""),
    [amount, setAmount] = useState(""),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [prepared, setPrepared] = useState<Prepared | null>(null),
    [journal, setJournal] = useState<Journal | null>(null),
    [status, setStatus] = useState(""),
    [canContinue, setCanContinue] = useState(false);
  const revision = JSON.stringify([
      configuration,
      rpcUrl,
      bundlerUrl,
      kind,
      market,
      listing,
      recipient,
      amount,
    ]),
    current = useRef(revision);
  current.current = revision;
  const ensureCurrent = () => {
    if (current.current !== revision)
      throw new AppError("operation_preparation_changed");
  };
  const intent = (): BusinessIntent =>
    intentSchema.parse(
      kind === "transfer"
        ? {
            kind,
            recipient: address.parse(recipient),
            amount: parseAssetAmount(amount).toString(),
          }
        : kind === "claim-bond" || kind === "claim-fees"
          ? { kind }
          : kind === "cancel-listing" || kind === "return-listing"
            ? { kind, listingId: hash.parse(listing) }
            : { kind, market: address.parse(market) },
    );
  const prepare = async () => {
    setError(null);
    setStatus("");
    setPrepared(null);
    setCanContinue(false);
    setBusy(true);
    try {
      const config = recoveryConfigSchema.parse(JSON.parse(configuration)),
        chainUrl = secureUrl.parse(rpcUrl),
        bundlerEndpoint = secureUrl.parse(bundlerUrl),
        key = journalKey(config);
      const old = localStorage.getItem(key);
      if (old) {
        setJournal(journalSchema.parse(JSON.parse(old)));
        setStatus("发现原操作记录，请继续查询，避免重复提交。");
        return;
      }
      const injected = (window as Window & { ethereum?: EIP1193Provider })
        .ethereum;
      if (!injected) throw new AppError("external_wallet_required");
      const owners = z
        .array(address)
        .parse(await injected.request({ method: "eth_requestAccounts" }));
      ensureCurrent();
      if (!owners.some((a) => sameAddress(a, config.controller)))
        throw new AppError("controller_not_linked");
      await injected.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x66eee" }],
      });
      ensureCurrent();
      await assertWallet(injected, config.controller);
      const client = createPublicClient({
        chain: arbitrumSepolia,
        transport: http(chainUrl, { retryCount: 0, timeout: 10000 }),
      });
      await verifyDeployment(client, config.environment);
      ensureCurrent();
      const account = await createAppKernel(
        client,
        injected,
        config.environment,
      );
      ensureCurrent();
      if (!sameAddress(account.address, config.assetAddress))
        throw new AppError("account_derivation_mismatch");
      await assertCurrentController(client, account.address, config.controller);
      ensureCurrent();
      const action = intent(),
        block = await client.getBlock(),
        calls = await buildBusinessCalls(
          config.environment,
          account.address,
          action,
          new ProtocolAdmissionReader(client, config.environment, ""),
          block.timestamp,
        );
      ensureCurrent();
      const accountClient = createKernelAccountClient({
        account,
        chain: arbitrumSepolia,
        client,
        bundlerTransport: http(bundlerEndpoint, {
          retryCount: 0,
          timeout: 15000,
        }),
      });
      const unsigned = (await accountClient.prepareUserOperation({
        calls: calls.map((c) => ({ ...c, value: 0n })),
      })) as UserOperation<"0.7">;
      ensureCurrent();
      if (unsigned.paymaster) throw new AppError("unexpected_paymaster");
      const cost =
          (unsigned.callGasLimit +
            unsigned.verificationGasLimit +
            unsigned.preVerificationGas) *
          unsigned.maxFeePerGas,
        balance = await client.getBalance({ address: account.address });
      ensureCurrent();
      setPrepared({
        environment: config.environment,
        account,
        unsigned,
        rpcUrl: chainUrl,
        bundlerUrl: bundlerEndpoint,
        cost,
        balance,
        intent: action,
        key,
        revision,
        controller: config.controller,
        provider: injected,
      });
      setJournal(null);
    } catch (e) {
      setError(
        e instanceof AppError
          ? e
          : new AppError("recovery_preparation_failed", 503),
      );
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!prepared || busy || prepared.revision !== current.current) return;
    setBusy(true);
    setError(null);
    try {
      const p = prepared;
      if (!navigator.locks) throw new AppError("browser_lock_required");
      await navigator.locks.request(
        p.key,
        { ifAvailable: true },
        async (lock) => {
          if (!lock || localStorage.getItem(p.key))
            throw new AppError("operation_query_required", 409);
          await assertWallet(p.provider, p.controller);
          const signature = await p.account.signUserOperation(p.unsigned);
          await assertWallet(p.provider, p.controller);
          if (p.revision !== current.current)
            throw new AppError("operation_preparation_changed");
          const signed = { ...p.unsigned, signature },
            userOperationHash = getUserOperationHash({
              userOperation: signed,
              entryPointAddress: ENTRY_POINT.address,
              entryPointVersion: "0.7",
              chainId: p.environment.deployment.chainId,
            });
          const saved = journalSchema.parse({
            environment: p.environment.id,
            manifestHash: p.environment.deployment.manifestHash,
            account: p.account.address,
            nonce: signed.nonce.toString(),
            userOperationHash,
            createdAt: new Date().toISOString(),
            intent: p.intent,
          });
          // Hash is persisted before the only send. Executable signatures are never stored or logged.
          localStorage.setItem(p.key, JSON.stringify(saved));
          setJournal(saved);
          setPrepared(null);
          setStatus("已保存原操作，正在提交。");
          const bundler = createBundlerClient({
            chain: arbitrumSepolia,
            transport: http(p.bundlerUrl, { retryCount: 0, timeout: 15000 }),
          });
          const accepted = await bundler.sendUserOperation({
            ...signed,
            entryPointAddress: ENTRY_POINT.address,
          });
          if (accepted !== userOperationHash)
            throw new AppError("provider_hash_mismatch");
          setStatus("已提交，请继续查询原操作。");
        },
      );
    } catch (e) {
      setError(
        e instanceof AppError
          ? e
          : new AppError("operation_result_unknown", 503),
      );
      setStatus("请查询原操作，勿重复提交。");
    } finally {
      setBusy(false);
    }
  };
  const query = async (continueAfterConfirmation = false) => {
    if (!journal || busy) return;
    setBusy(true);
    setError(null);
    try {
      const config = recoveryConfigSchema.parse(JSON.parse(configuration));
      if (
        !sameAddress(journal.account, config.assetAddress) ||
        journal.environment !== config.environment.id ||
        journal.manifestHash !== config.environment.deployment.manifestHash
      )
        throw new AppError("environment_mismatch");
      const client = createPublicClient({
          chain: arbitrumSepolia,
          transport: http(secureUrl.parse(rpcUrl), { retryCount: 0 }),
        }),
        bundler = createBundlerClient({
          chain: arbitrumSepolia,
          transport: http(secureUrl.parse(bundlerUrl), { retryCount: 0 }),
        }),
        result = await bundler.getUserOperationReceipt({
          hash: journal.userOperationHash,
        });
      ensureCurrent();
      if (
        result.userOpHash !== journal.userOperationHash ||
        !sameAddress(result.sender, journal.account)
      )
        throw new AppError("receipt_hash_mismatch");
      const [receipt, head] = await Promise.all([
          client.getTransactionReceipt({
            hash: result.receipt.transactionHash,
          }),
          client.getBlockNumber(),
        ]),
        block = await client.getBlock({ blockNumber: receipt.blockNumber });
      ensureCurrent();
      if (block.hash !== receipt.blockHash)
        throw new AppError("receipt_not_canonical");
      const event = operationEvent(receipt, {
        hash: journal.userOperationHash,
        sender: journal.account,
        nonce: BigInt(journal.nonce),
      });
      const enough = head >= receipt.blockNumber + 1n;
      setCanContinue(enough);
      setStatus(
        enough
          ? `${event.success ? "已确认成功" : "链上已回滚"}。交易 ${receipt.transactionHash}`
          : `链上确认中。交易 ${receipt.transactionHash}`,
      );
      if (continueAfterConfirmation && enough) {
        // Revalidate canonical inclusion and consumed nonce before allowing a new, explicitly confirmed operation.
        const nonce = await client.readContract({
          address: ENTRY_POINT.address,
          abi: entryPoint07Abi,
          functionName: "getNonce",
          args: [journal.account, BigInt(journal.nonce) >> 64n],
        });
        ensureCurrent();
        if (nonce <= BigInt(journal.nonce))
          throw new AppError("operation_query_required", 409);
        if (!navigator.locks) throw new AppError("browser_lock_required");
        const key = journalKey(config);
        await navigator.locks.request(key, async () => {
          const saved = journalSchema.parse(
            JSON.parse(localStorage.getItem(key) ?? "null"),
          );
          if (saved.userOperationHash !== journal.userOperationHash)
            throw new AppError("operation_query_required", 409);
          localStorage.setItem(
            `${key}:archive:${journal.userOperationHash}`,
            JSON.stringify({
              ...saved,
              transactionHash: receipt.transactionHash,
              blockHash: receipt.blockHash,
              success: event.success,
              confirmedAt: new Date().toISOString(),
            }),
          );
          localStorage.removeItem(key);
        });
        setJournal(null);
        setCanContinue(false);
        setStatus("已保留确认记录，可以重新核对下一笔退出操作。");
      }
    } catch (e) {
      setCanContinue(false);
      setError(
        e instanceof AppError
          ? e
          : new AppError("operation_query_required", 503),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="recovery-main">
      <a className="brand" href="/">
        <span className="brand-mark">CP</span>Cpredict
      </a>
      <PageTitle
        title="独立账户恢复与退出"
        description="本工具使用固定版本的 ZeroDev SDK，直接连接你的控制钱包、RPC 和 Bundler，不调用应用服务。"
      />
      <Notice tone="warning">
        此处不申请项目代付。费用由应用账户的 ETH
        支付，确认前会显示费用上限。导出的是控制钱包密钥，请先在成熟外部钱包中恢复，不要把密钥输入本页面。
      </Notice>
      <section className="surface stack">
        <Field
          label="账户恢复配置 JSON"
          hint="从原账户与帮助页下载；包含环境、固定版本、控制地址与资产地址，没有私钥。"
        >
          <textarea
            value={configuration}
            onChange={(e) => {
              setConfiguration(e.target.value);
              setPrepared(null);
              setJournal(null);
            }}
          />
        </Field>
        <div className="form-grid">
          <Field label="独立 HTTPS RPC">
            <input
              type="url"
              value={rpcUrl}
              onChange={(e) => setRpcUrl(e.target.value)}
            />
          </Field>
          <Field label="支持 EntryPoint 0.7 的 Bundler URL">
            <input
              type="url"
              value={bundlerUrl}
              onChange={(e) => setBundlerUrl(e.target.value)}
            />
          </Field>
        </div>
        <Field label="退出操作">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="transfer">转出当前环境支付资产</option>
            <option value="claim-winner">领取赢家收益</option>
            <option value="claim-early-bird">领取早鸟返还</option>
            <option value="refund">领取本金退款</option>
            <option value="claim-timeout-bonus">领取超时补偿</option>
            <option value="void-timeout">申请超时作废</option>
            <option value="settle-bond">结算市场押金</option>
            <option value="claim-bond">领取押金汇总余额</option>
            <option value="claim-fees">领取费用汇总余额</option>
            <option value="cancel-listing">撤单取回份额</option>
            <option value="return-listing">取回终局托管份额</option>
          </select>
        </Field>
        {kind === "transfer" ? (
          <div className="form-grid">
            <Field label="接收地址">
              <input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
            </Field>
            <Field label="转出金额">
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          </div>
        ) : kind.includes("listing") ? (
          <Field label="挂单 ID">
            <input
              value={listing}
              onChange={(e) => setListing(e.target.value)}
            />
          </Field>
        ) : (
          !["claim-bond", "claim-fees"].includes(kind) && (
            <Field label="市场地址">
              <input
                value={market}
                onChange={(e) => setMarket(e.target.value)}
              />
            </Field>
          )
        )}
        <ErrorNotice error={error} />
        <Button disabled={busy} onClick={() => void prepare()}>
          核对地址、调用与自付费用
        </Button>
      </section>
      {prepared && prepared.revision === revision && (
        <section className="surface stack">
          <h2>确认独立退出</h2>
          <p>
            资产地址 <AddressText value={prepared.account.address} full />
          </p>
          <pre>{JSON.stringify(prepared.intent, null, 2)}</pre>
          <p>
            最大网络费用 {formatEther(prepared.cost)} ETH；应用账户 ETH 余额{" "}
            {formatEther(prepared.balance)}。
          </p>
          {prepared.balance < prepared.cost && (
            <Notice tone="warning">
              应用账户的 ETH
              不足，请向已核对的应用地址补充网络费用后重新准备。不会自动扣 USDC
              或 ctUSD 作为 Gas。
            </Notice>
          )}
          <Button
            disabled={busy || prepared.balance < prepared.cost}
            onClick={() => void send()}
          >
            确认自付 ETH 并签名提交
          </Button>
        </section>
      )}
      {journal && (
        <section className="surface stack">
          <h2>原操作恢复</h2>
          <p>
            操作哈希 <code>{journal.userOperationHash}</code>
          </p>
          <Notice>{status || "仅查询原操作，不自动重发。"}</Notice>
          <Button disabled={busy} onClick={() => void query()}>
            继续查询原操作
          </Button>
          {canContinue && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void query(true)}
            >
              保留记录，继续下一笔退出
            </Button>
          )}
        </section>
      )}
      <p className="small">
        供应商不可用时，请保留哈希并稍后查询。独立恢复必须使用与你的固定账户配置兼容的服务；更换控制者、模块或账户版本不在本工具范围内。
      </p>
    </main>
  );
}
const root = document.getElementById("root");
if (root) {
  const appRoot = import.meta.hot?.data.root ?? createRoot(root);
  if (import.meta.hot) import.meta.hot.data.root = appRoot;
  appRoot.render(<Recovery />);
}
