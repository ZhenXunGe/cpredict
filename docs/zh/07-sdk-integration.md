# SDK、前端、后端、AA 调用手册

## 1. 安装与单位

Node 22，执行 `npm ci --ignore-scripts`。SDK 源码在 `offchain/sdk/src`，完整 ABI 在
`generated/abi`。所有金额用 decimal string→bigint；`parseUsdc`/`parseShareUnits` 对超过 6 位
小数直接报错，绝不静默四舍五入。浏览器中的 RPC、合约地址是公开配置，任何 private key、
KMS credential、Paymaster API secret 都不得进入 `VITE_*` 或 bundle。

## 2. 写交易标准流程

```text
validate input → read authoritative state → simulateContract
→ user signs/sends once → wait receipt by hash → verify status/logs
```

SDK 不做无界重试。nonce underpriced、cap/listing race、deadline expired 要重新 read+simulate；
网络断开先查原 tx hash，不立即产生第二笔经济操作。`maximumPayment/maxGross/minimumUnits/deadline`
是强制用户保护，不允许 UI 偷设无限值。

`CpredictClient` 已覆盖 create/update、allowance/Permit2 buy、ERC-1155 approval、create/fill/cancel/
terminal return、resolve/creator void/timeout、四类 claim、bond settle 与 Guard sync。每个写入口统一
`simulate → send once → receipt.status`；simulate 拒绝时不发送，receipt revert 不自动重发。

## 3. 一级购买

用户先对具体 Vault 做 USDC allowance，或使用 Permit2 SignatureTransfer witness。调用参数：
`outcomeId, desiredUnits, minimumUnits, maximumPayment, deadline`。receipt 中以实际 filled/payment
事件为准，不能假定 desired 全部成交。累计一级 cap 不因出售恢复。

两条支付授权必须区分：普通 buy 将精确 USDC allowance 给 Vault；Permit2 buy 必须先将精确 USDC
allowance 给 canonical Permit2，再签一次性 bounded witness，不能误认为 witness 可绕过 ERC-20 allowance。
创建市场前向 Factory 精确授权 `creationFee + creatorBond`；两者任一变化都要重新 read/simulate，不能
沿用旧无限 allowance。

Permit2 builder 使用与链上一致的 canonical witness suffix，并分别构造 Buy/Fill EIP-712 typed data；
owner/buyer、spender、selector、Vault/listing、经济上下限、nonce/deadline 和 chainId 不得由 UI 隐式
复用。标准账户 sign/recover 与独立 reference vector 已覆盖，但 Arbitrum canonical Permit2 runtime codehash
和真实钱包/provider 行为尚未验证。

## 4. Listing

标准钱包先 `setApprovalForAll(marketplace,true)`，再 `createListing`；智能账户可 batch。价格单位是
“每整份的 USDC atomic units”，例如 0.9 USDC/share=`900000`。改价必须 cancel+create。fill
需要 desired/min/maxGross/deadline；allowance 路径在 fill 前按 `maxGross` 给 Marketplace 精确 USDC
授权，Permit2 fill 则按独立 canonical witness 流程。UI 必须展示 C2C 价不影响池子隐含概率。

## 5. Claim/Refund

任何 relayer 可调用 `claim*For(owner)`，收款固定 owner。winner claim 会烧 owner 当前全部 winning
balance；refund 可按各 outcome 当前余额进行。timeout principal 成功不代表 bonus 已到账，UI 需要
分开显示 `principal refunded` 与 `bond bonus pending/claimable`。

## 6. Paymaster

优先顺序：自建免费赞助→成熟外部 USDC Paymaster→用户明确允许的原生 ETH。SDK 在签名/提交前
选择 lane，按 provider 顺序设置 100–30,000ms deadline；全部失败且未显式允许 native ETH 时必须
报错，不能静默收费，也不重试已提交 UserOperation。每个 provider 调用都与独立 Promise deadline
竞争；即使 provider 忽略 `AbortSignal` 且永不 settle，deadline 仍会结束该次等待并进入下一条
fallback，不会卡死签名前流程。智能账户 batch 限 1–32 calls、`value=0`，并由
adapter 使用独立 nonce key。

自建服务只签已知 account adapter
解析出的白名单 target/selector/value=0 调用；返回 paymasterAndData 前做 schema、cost、bytes、auth、
rate、policy 检查。它将 `paymasterVerificationGasLimit` 和 `paymasterPostOpGasLimit` 同时写入 packed
header 与 EIP-712 message，合约端限制范围并在 digest 中绑定，任一处篡改都会失败。预算 reservation
在签名前持久提交；签名后 commit 结果不确定时保留 reservation，避免 fail-open 重复预算。
KMS/HSM signer 通过接口注入，启动时校验配置期望地址；这不是 live on-chain signer 查询证明。

服务提供 `/healthz`、依赖感知 `/readyz`、`/metrics` 和 authenticated `/v1/sponsorship`，仅允许
loopback bind，需部署侧补 TLS/WAF/egress。仓库不含 raw-key signer 或生产内存预算实现。外部
Paymaster 失败不得进入本金路径；客户端应提供清晰 fallback，不能反复弹签或静默切换付费。

## 7. Indexer/API

Indexer 保存 raw event、checkpoint 以及每个扫描区块（含无事件块）的 hash/parentHash/timestamp。
发生 reorg 时从 checkpoint 逐块回退到 RPC 与本地一致的 common ancestor，在一个 store transaction
删除分叉后的 raw/derived/registered-market/checkpoint 状态并重建 projection。Factory `MarketCreated`
动态发现 Vault，并在同批查询新 Vault 以摄取创建交易内较早的初始化事件。

只读 API 路由为 `/v1/markets`、`/v1/markets/:market`、`/v1/listings`、`/v1/fills`、
`/v1/positions/:owner`、`/v1/claims/:owner`，分页最大 100；金额和 block number 使用 decimal string。
API 不把 URI 当可信 HTML，也不提供 user-controlled outbound fetch。用户在不可逆操作前仍用 RPC
`eth_call/simulate` 验证。真实 PostgreSQL integration 只有在显式提供 disposable `TEST_DATABASE_URL`
时运行；当前为 SKIP，内存 store 通过不能替代数据库 runtime proof。

Terminal worker 从 Indexer API 有界分页读取 terminal markets，对每个 market/observed block 最多尝试
一次 permissionless `settleBond` 与 Guard `sync`；专用 EOA 只有一个 nonce lane，因此同一 market 的
两笔写必须顺序 simulate/send/receipt，不能 `Promise.all` 并发提交。结构化记录 `success`、
`simulation-rejected`、`submission-failed`、`receipt-failed` 与 `transaction-reverted`，并将 32 bytes
及以上 hex payload 脱敏。PostgreSQL state/Prometheus adapter 已有，
但生产数据库、签名账户、RPC 与监控实例未部署。

## 8. React 示例边界

`examples/react/src` 现包含 `CreateMarketPanel`、`PrimaryPaymentPanel`、`BuyPanel`、
`MarketLifecyclePanel`、`MarketplacePanel` 与 `ClaimsPanel`：覆盖不可变创建复核、allowance/Permit2、
显式上下限、creator 单方不可逆结算警告、permissionless timeout、ERC-1155 approval、list/fill/cancel
以及 winner/early/refund/bonus 四类 claim；共享 hook 防重复点击并展示 receipt/revert。SSR 用例只证明
组件调用面和关键文案存在。其中 creation 明示精确 `fee+bond` 授权，Permit2 明示先精确授权给 Permit2，
allowance fill 明示精确 `maxGross` 授权给 Marketplace。它不是完整旗舰 UI，没有 wallet onboarding、真实钱包/链状态、creator
信用、查询列表、可访问性或浏览器 E2E。
`security-headers.conf` 必须在真实 edge 设置并用浏览器响应头验证，仓库文件本身不生效。

`examples/web-demo` 在上述最小组件之上提供可运行 Vite 控制台：固定 Arbitrum Sepolia、EIP-6963
钱包、runtime config/final manifest JSON Schema 校验、runtime codehash/wiring 门禁、Full/Clone
创建复核、Allowance/Permit2 buy、C2C、canonical evidence 与四类 claim。它不会把 DEBUG 地址标成
正式验证，也不提供管理员任意调用或 AA UserOperation。完整运行与甲方验收见
`12-web-demo-integration.md`。

## 9. 错误处理

优先按 `generated/registries/errors.json` selector 分类。expected：cap/partial/min/deadline/listing race、
nothing-to-claim。critical：insolvent/invariant、unknown codehash、role drift。UI 永远展示 chain、tx hash、
market/listing 和可重试条件；日志不得包含 private key、签名、Authorization、cookie、完整 UserOp。
