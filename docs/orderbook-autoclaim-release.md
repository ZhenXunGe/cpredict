# 求购、自动撮合与自动领取：V2 发布说明

## 2026-10-02 整单规则与账户到账证据候选

本节描述新的源代码能力，尚不表示旧不可升级合约或线上环境已切换。旧部署没有 `orderbookFillPolicyVersion: 1` 时继续沿用原部分成交接口；下方日期记录属于对应历史版本。

- 新 Marketplace `defaultAllowPartialFills` 默认 false。仅 Factory.governance 可修改；每笔订单创建时以 `orderAllowsPartialFills` 固定快照，并发出 `OrderFillPolicySnapshotted`。旧 orders 查询元组及用户创建订单参数保持不变。新部署通过 `fillPolicyVersion() == 1` 核验能力。
- 整单手动接单要求 desiredUnits、minUnits 都等于剩余数量。按数量的堆与部分成交堆均由合约维护，数量组内价格优先、同价 FIFO。`matchOrdersForUnits` 只成交同剩余数量的订单；原 `matchOrders` 在新能力下只处理允许部分成交的队列。相等数量可跨模式成交，数量不等时双方均须允许部分成交。不能拼多个对手单。
- 成交前移除旧数量索引，部分成交后重建剩余数量索引；撤单、到期、终局、自成交、拒收账户同步释放索引。后台轮转数量组，事件游标和索引 epoch 驱动活跃订单缓存，重组后重新建立缓存。发送仍使用现有单 nonce、确认与恢复通道及费用限制。
- `GET /v1/claim-receipts` 为认证、账户归属检查接口，金额来自当前部署规范 ledger_facts；每个事实独立保留。后台交易从控制库匹配，手动操作从应用库与对应 UserOperationEvent 区间匹配，无法可靠关联的 AA 操作显示来源待核验。确认未索引与实际到账分开展示。
- `GET /v1/sponsored-gas` 返回本环境已核实个人代付、公共撮合/维护代付、待核验数及完整性。AA 使用 actualGasCost 加服务端 sponsored 证据；EOA 使用规范回执 gasUsed × effectiveGasPrice，按哈希去重，失败执行也计入。Arbitrum 数据发布成本已折为链上 Gas，不再重复增加 L1 字段：[官方费用说明](https://docs.arbitrum.io/how-arbitrum-works/deep-dives/gas-and-fees)。未知费用为 null，预算预留不作为费用。
- app-core Zod 为接口权威源；`features.accountEvidence` 启用统一到账页面，未开启仍兼容旧展示。控制库和应用/索引库可以分离；启动检查 migration013，费用补核验独立低优先级，活跃领取期间不抢占通道。稀疏索引缺失无日志回执块时，补核验同时检查规范索引 checkpoint 与回执，并保存 epoch/区块锚点；epoch 变化撤销旧费用证明并重新核验。页面只显示 ETH，个人明细不泄露其他账户交易。

### 当前 time-v2 环境重置与发布边界

这次只允许旧 time-v2/orderbook-v2（无整单能力标识）到新 fillPolicyVersion1 的明确过渡，保留既有 legacy-v1 → time-v2 工具兼容。不允许任意地址/资产/账户派生修改。候选生成可使用原 `--id` 加新的 `--deployment-id`；旧交易及恢复记录不复制为新任务。

上线前必须单独授权 Git 推送、新合约交易、线上重置和服务切换，旧批次授权不扩大到本批。当前工作只生成本地候选，不访问真实账户签名或发送公链测试交易。

1. 保存旧服务镜像、完整配置、签名者在途记录、规范合约地址/代码哈希以及应用/索引/控制库备份；使用现有 verified-backup 与 restore-drill 工具核验并恢复演练。关闭新操作入口，停止 app、indexer、claims、matching、RPC 操作接收者。对账全部在途 UserOperation 和 keeper；unknown/prepared/broadcasting 阻止切换。
2. 新 Factory/Marketplace/FeeVault/BondEscrow 使用新地址，支付 Token、登录项目与账户派生参数保持原值。部署入口独立 orderbook-v2 pending 状态，候选核验代码、依赖接线、治理及默认 false。既有链上托管资产保持原合约，不自动迁移或返还。
3. 通过 maintenance rollover 干跑与明确 apply 执行应用/索引 schema 归档，只携带身份与防滥用预算。必须提供 `CPREDICT_AUTOMATION_CONTROL_DATABASE_URL`；工具检查独立控制库 unresolved 记录及停机连接。控制库旧记录、nonce 恢复与预算证据原样保留并备份，队列和累计接口均按新 deploymentId 隔离，不删除旧交易。
4. 显式执行新增迁移（含控制库013）；worker 只检查 schema。服务及网页用同一最终源版本，依次启动新索引与 metadata、app、matching/claims、RPC 与网页，验证登录/账户派生与新空市场/空订单后开放入口。不得用旧合约 ABI 推断整单能力。
5. 公网验证 10 对 5 不成交、10 对 10 成交，手动抢先领取到账记录，个人/公共费用分离与新批次 ≤30秒；观察至少30分钟。本地自动挖矿 Anvil 的性能结果只证明隔离环境，不能替代公网验收。
6. 回退保留所有新旧交易；新部署出现用户资产后暂停新操作，通过兼容镜像继续支持撤单、领取、恢复，不能直接切回旧库或地址。未完成真实账户验收时报告线上验收待完成。

### 本批静态分析审阅

Slither 原 `books` 未初始化候选随显式 storage 参数堆操作消失；既有 `reentrancy-no-eth` 报告从 matchOrders 转到私有 _matchOrders。该函数只能由两个 nonReentrant 公开入口调用，外部转份额入口只允许 msg.sender == address(this)。原 fillOrder 警告保持，经济写入与恢复顺序沿用原模型；整单恶意接收者、回调重入及混合模式状态不变量测试覆盖新增入口。其余 High/Medium 基线保持原逐项匹配，未隐藏新增检测器或降低门槛。


## 2026-10-02 自动领取队列与发布验收

实施基线为 `4fe4e0bd7c361cda65cb6f55a9db5607f8b05672`，实施分支为 `fix/automatic-claims-queue-20261002`，通过 `main` 交付；app-service、claims 和网页使用同一发布提交构建。合约、经济规则、收款地址、撮合规则、signer、nonce 并发策略、Gas 预算及清理配额保持原有约束。发布提交、镜像 digest 和运行核对记录保存在本地 `reports/generated/orderbook/claims-queue-deployment.json` 及云端本次发布证据目录。线上小批次从结算到最后到账不超过 30 秒、争取 20 秒，是发布后的验收目标；本地 Anvil 的即时出块耗时不能作为线上结果。

### 持久状态和处理链路

- control 库增量迁移 `012_automation_claim_queue.sql` 保存部署/链/epoch 的完整区块游标、带版本的待核验范围和未签名候选。沿用既有迁移入口，不修改已应用迁移。索引库增加 `012_claim_discovery_indexes.sql`，仅增加按链和区块读取事实的索引，不改变索引器写入流程。
- 每 2 秒读取 `ledger_facts` 中已完成索引的完整区块。owner/counterparty 均被唤醒；无 owner 的结算、作废和超时注资事件展开该市场历史权益人。游标和唤醒范围在同一个 control 事务内提交，错误不推进游标。
- 历史补扫首次启动即开始，每页 25 个历史地址，持久保存页游标；完成后 5 分钟启动下一轮。新事件优先，补扫不阻塞已经就绪的交易。链上 deadline 单独持久化，未来到期即唤醒，不依赖再出现事件；重新开启偏好主动补扫该账户。
- 每次核验最多处理 4 个到期范围，共享同一规范区块的公共读取；RPC transport 全局最多 4 个读取在途，回执、nonce 和发送前核验优先。发送前仍检查当前余额、偏好、预算、收款意图和可执行性，不把发现缓存作为发送资格。
- 消费器独立运行。新工作入库立即唤醒空闲消费器；有在途或就绪工作时最多 2 秒再对账。确认后同一轮立即提交下一笔，仍只有一笔 nonce 在途。市场维护及阻碍领取的托管返还优先；个人领取按批次年龄和账户轮转，赢家/本金优先于奖励、费用。失败候选退避 2/5/15/30/60 秒，不固定占据每轮前 20 个位置。
- 核验结果使用范围版本 CAS，核验期间发生的新事件和关闭偏好不会被旧结果覆盖。候选和原签名交易在 `store.save()` 的事务内关联；prepared/broadcasting/unknown 先恢复原记录，保留原哈希、替换哈希和 signer 锁。epoch 或游标哈希变化只撤销未发送发现结果，已签名记录继续对账。
- 手动抢先领取、偏好关闭或链上权益消失时取消未发送候选。旧版 worker 回退期间完成的交易，在重新启动新版后按 journal 状态修复候选关联，不复活旧 nonce。

### API、页面与诊断

`GET/POST /v1/automatic-claims` 保留原字段和分页，增加可选 `queue`。摘要只统计当前资产地址的个人任务；其他账户阻塞 signer 时仅提供固定的通用原因。未广播的 prepared 任务显示排队；已广播任务显示确认。队列读取失败或心跳过期显示 unavailable，不把它解释为零积压。未提交候选不进入已到账列表，也不展示估算金额或倒计时。

页面展示等待数量、确认数量、核验状态以及预算、Gas、RPC、索引和未知交易暂停原因。关闭后已提交交易继续确认。活跃时每 2 秒刷新，空闲/旧 API 每 5 秒刷新，页面隐藏后暂停周期刷新。权威 Zod 来源仍是 `offchain/app-core/src/orderbook-contracts.ts`，副本由 `npm run site:contracts` 生成。

Prometheus 增加 `cpredict_automation_stage_seconds{phase,result}`（发现、核验、排队、发送前校验、广播、确认、索引延迟及到账延迟）、`cpredict_automation_read_requests_total`、`cpredict_automation_discovery_items_total{kind}`、`cpredict_automation_claim_queue{state}`、`cpredict_automation_oldest_queued_seconds` 和 `cpredict_automation_discovery_block`。日志只记录固定原因、数量和游标，不记录 RPC 凭据、签名原文或私钥，指标不使用钱包标签。并行周期日志中的 `sharedRpcRequests` 是共享读取通道在观察窗口内的请求数，可能包含同时进行的消费读取。

`event-to-payout` 使用触发事实的链上时间到实际回执区块时间；`indexed-to-payout` 使用规范索引事务中的 `chain_events.observed_at`（历史补扫使用首次核验时间）到回执区块时间。索引事务观察时间不等于精确 commit 时刻，因此同时保留索引延迟及阶段耗时，不能将该近似值单独当作精确处理 SLA。故障通过失败阶段、持久暂停原因、积压年龄和错误计数保留，不从总事件/队列样本中删除。

### 本地验收及证据边界

- 全量 Vitest 在真实隔离 PostgreSQL 和 Anvil 环境下执行，必需测试不以 skip 通过。队列测试覆盖游标原子性、范围版本竞争、候选关联及重启、多个实例竞争、关闭/重新开启、deadline 无事件唤醒、份额转移双方、未注册权益人、失败退避、账户轮转、重组保留签名记录和旧版回退对账；既有 worker 故障测试覆盖预算、RPC、未知交易、替换哈希和手动抢先领取。
- 两组无关历史夹具分别为 38 个市场/53 个地址和 200 个市场/500 个地址，每组 20 轮真实签名的 3 账户/7 交易批次；验证规范回执、实际余额、赢家份额清零、无重复 nonce、无 reverted 交易及读取量不随无关历史线性增长。另验不同协议费用收款人的 4 账户/8 交易批次。历史规模是数据库夹具，到账验证使用真实隔离合约。
- 隔离链证据为 `reports/generated/orderbook/anvil-lifecycle.json` 和 `claims-performance.json`。Anvil 自动出块，测试显式推进 discovery/consumer；2 秒对账下的调度另用真实 PostgreSQL 和受控回执时钟验证。两者均不证明公网 RPC 延迟或真实账户的 30 秒 SLA。
- `node scripts/orderbook/test-postgres.mjs` 强制真实数据库、完整清单和零 skip，包含队列套件及原地迁移/恢复演练。桌面与窄屏浏览器夹具验证排队、确认、暂停、关闭、旧 API、历史分页和到账显示；夹具不等于线上登录钱包验收。
- 发布要求核对最终提交的镜像来源、线上运行状态，并完成至少 30 分钟观察和真实小批次到账验收。本机未安装 Docker，镜像由云端从已提交源码构建；不能将本地 TypeScript/Web 构建或空队列健康检查报告为真实到账性能验收。

### 发布和回退

已获提交、合入 main、推送、迁移和部署授权。发布时先冻结最终提交和生成产物，记录镜像 revision/digest；保存当前镜像、私有配置、已校验的索引库与 control 库备份，以及已有 prepared/broadcasting/unknown 与替换哈希清单。迁移通过既有工具分别应用到索引库和 control 库，再按 **app-service → claims → 网页** 切换。claims 启动只检查 schema，不自动迁移；停止旧 claims 实例后才启动新版，确认同一 signer 只有一个执行实例。撮合、索引器、metadata 和合约镜像保持现状。

上线后至少观察 30 分钟，记录所有约定批次的结算区块、首次索引观察、每笔广播与实际到账区块时间；正常样本完整批次 ≤30 秒，并记录是否达到 20 秒。RPC/预算/索引故障样本单列原因及恢复时间，仍保留在总批次清单；检查积压、游标、查询量、收款人及金额、开关与页面状态。

回退恢复应用镜像和配置，保留两处新增迁移、全部队列和签名交易记录。不要用数据库回滚把已广播、替换或确认的交易恢复成旧状态，不清空 unknown，也不另发新 nonce。重新启用新版时先对账旧版运行期间的规范事实和既有 journal，再恢复候选消费。没有真实账户验收时，交付状态必须写为“实现和本地验证完成，线上性能验收待完成”。

## 2026-09-24 新合约测试站替换

公开测试入口已切换至 `https://43.160.199.165/ctusd-orderbook-v3/markets`，环境 ID 为 `ctusd-orderbook-v3`。Arbitrum Sepolia 的新 Factory 为 `0x83442827A7799814878a8d6E8f78f83B847EA73A`，新 Marketplace 为 `0x165f78f354A4c0f3f49486491afdB82C7A7754FE`；部署源码提交为 `35fb874ec65a9c1ca439af37a6b0fc920da82593`。13 笔部署和 4 笔激活交易的回执均成功，工厂已激活，Marketplace 的 `receiverRecoveryVersion()` 返回 `1`。这是测试网 sandbox 部署，不是正式审计或主网发布。

新合约将拒收份额的最优买单隔离并退款；到期或撤销卖单遇到拒收时，先将订单移出队列，份额记为仅原卖方可指定接收地址取回的 `pendingShares`。费用、成交价格、其他交易规则及 ctUSD 支付资产未更改。旧链上合约和记录无法删除，但旧站入口和七个服务已停用；新站使用独立空数据库，不迁移旧市场、订单、持仓或自动领取任务。旧卷、镜像、私有配置及已校验的三库备份保留用于回退。

切换前验收时，新站七个容器健康，索引追到安全块，回执 pending/unresolved 和自动化 pending 均为 `0`；公开页面、站点配置和市场接口可用，市场列表为空，页面提供创建市场入口。切换后一分钟内 12 次采样的索引落后为 0–23 块，4 次超过原定的 20 块门槛；不能将该门槛记为通过。回执和自动化队列仍为 0，七个新服务健康、七个旧服务停用。云端证据位于 `/home/ubuntu/cpredict-migration/receiver-safe-20260924/`，包括 `onchain-evidence.json`、`pre-cutover-acceptance.json`、`post-cutover-acceptance.json`、`lag-observations.json`、镜像清单、旧配置及数据库备份。真实钱包在新合约上的完整下单、撮合和领取流程仍需单独验收，不能由空市场页面或本地测试代替。

## 2026-09-23 历史快照

当时公开入口是 `https://43.160.199.165/ctusd-orderbook-v2/markets`，使用 Arbitrum Sepolia 的 ctUSD 测试资产。以下是**组件分别核对**的历史运行状态，不代表正式审计、主网发布或真钱可用：

| 组件 | 当时运行版本 | 2026-09-23 增量发布范围 |
| --- | --- | --- |
| 网页 | `cpredict-web-demo:main-d9cc16f-20260923` | 保留先前的资产与份额校验；自动清理触及配额时给出手动撤单、取回资产和领取提示。 |
| 自动领取、自动撮合 | `cpredict-automation:main-d9cc16f-20260923` | 两条独立 signer 通道共用账户和市场清理配额；终态卖单优先，额度核验在任务落库时加锁完成，并暴露配额指标。 |
| 应用、索引、规则服务 | 保持此前已部署镜像 | 本次未替换这些服务，不能把它们描述为运行 `d9cc16f`。 |
| 链上 V2 合约 | 仍为 2026-09-18 已部署版本 | `fa271445afb0d0b23429ce79e746847e3a2e482b` 中的 `OrderbookMarketplaceV2.sol` 零金额最小成交保护**只在源码和生成产物中，尚未上链**。当前合约继续按其既有字节码执行。 |

当时工厂的 Marketplace 地址只能绑定一次，不能把新交易合约替换到旧工厂。上节记录的 2026-09-24 替换使用了新工厂、Marketplace 和权限策略，未升级旧市场的链上规则。旧链上资产不会因网页切换而消失。

配额提交 `d9cc16f66ba287cfc9b2ee5126c712b9b58c3b23` 的验证：链下 Vitest 579 项通过、78 项因缺少对应隔离环境跳过；隔离 PostgreSQL 的配额竞争 5 项、订单索引 8 项及既有 9 个集成套件 45 项通过。前后端类型检查、网页构建、生成产物及凭据扫描通过。云端切换后公开页面返回 HTTP 200，七个业务容器健康，索引追平；回执 `pending=0`、`unresolved=0`，两个自动化队列 `pending=0`。本次没有为触发配额而向公网发送测试交易；真实配额拦截由隔离数据库并发测试证明。公网冒烟不等于真实钱包的完整已登录交易验收。

本次云端构建、测试与回退证据位于 `/home/ubuntu/cpredict-migration/cleanup-quota-20260923/`，包含切换前私有 Compose/镜像清单、已校验的 PostgreSQL 备份及构建和隔离测试日志。回退只恢复对应镜像与私有 Compose，保留增量迁移和业务数据库；不要重发结果未知的链上交易。先前 `fa27144` 发布证据仍位于 `/home/ubuntu/cpredict-migration/review-fixes-20260923-fa27144/`。本次没有更新链上合约；Prometheus 规则和脱敏日志已具备，但云端尚未接入外部通知渠道。

## 交付范围与状态

初始实现来自独立分支 `codex/orders-autoclaim-20260918`，基线 `release-2026-09-18` / `f16bf40f7d0fc6134feadd22c0f5ca7061c54f3a`；后续改动已进入 `main`。初始实现包含从独立 RPC 工作区复制的现用主备读取实现；原工作区、V1 合约和封版标签未修改。

本批实现 V2 订单簿、权限策略、后台任务、账户设置、事件索引及页面。已进行本地 Solidity、PostgreSQL、真实签名 Anvil 演练及浏览器组件交互测试。**2026-09-18 已部署公网 Arbitrum Sepolia 测试环境并切换新加坡站点入口。** 真实 Kernel / ZeroDev 签名交易、云端自动撮合与自动领取已通过；公开页面及登录弹窗已检查。尚未通过浏览器执行完整的已登录交易流程，组件夹具与真实协议验收分别记录。

隔离链地址及交易记录：`reports/generated/orderbook/anvil-lifecycle.json`。这是临时 loopback Anvil，测试结束已关闭，里面的地址不能作为公网地址使用。

## 产品与资产规则

- 每个市场的本金继续由自己的 Vault 保管。订单支付款和份额进入独立 V2 交易合约并逐单记账，不进入一级本金池。
- 同市场、同结果的买卖单使用链上堆队列：买价高优先、卖价低优先；同价按订单号 FIFO。成交价是先挂订单价格。手动接单选择具体订单。
- 新订单默认自动撮合；关闭后只接受手动接单。改变模式须撤单重挂。支持部分成交，低于最小挂单量的尾单退回。
- 买单冻结款按上限向上取整；成交按既有规则向下取整。改善价差立即退回，剩余订单留足资金，结束时退完尾款。卖方支付现有 C2C 费用。
- 自成交自动取消较新订单；`matchOrders` 每笔最多处理 20 步，后台每笔使用 1 步。暂停新增交易仍允许退出和领取。
- 新旧账户的领取偏好按链和资产地址保存，缺省开启。所有部署必须共用 control database/schema；显式关闭保留。只有通过既有账户控制权核验的会话可以更改。
- 后台发现历史链上权益人，不要求登录或持有平台账号。使用原 `claimFor` 类方法，收款人由合约固定。没有非零可领余额不发送。
- 任一开启自动领取的实际权益人，可在最终结算期限到达后触发整个市场超时作废；随后结算押金、返还终态托管、退款和补偿。后台不判断事件结果。

## 代码入口

- `src/marketplace/OrderbookMarketplaceV2.sol`：托管、队列、主动接单、撮合和退出。
- `src/core/TradingSessionPolicyV2.sol`：V2 智能账户临时授权与消费预算。
- `offchain/sdk/src/orderbook.ts`：ABI / 买单冻结款计算。
- `offchain/workers/src/automatic-runtime.ts`：claims / matching 两种后台服务。
- `offchain/workers/src/automatic-{claims,store,chain,source}.ts`：候选发现、并发锁、签名与持久恢复。
- `offchain/indexer/src/orderbook.ts`、`operation-receipt.ts`：订单投影与精确 UserOperation 回执关联。
- `offchain/app-core/src/orderbook-contracts.ts`：订单与自动领取接口 schema；生成副本在 `generated/public-site/contracts.json`。

新增接口：`GET /v2/orders`（绑定 environment/deploymentId，可按 market/owner 和 cursor 查询）；`GET /v1/automatic-claims?accountId=...`；`POST /v1/automatic-claims`（accountId、enabled）。网页继续使用既有操作注册、准备、签名和恢复接口，新增 create-order / fill-order / cancel-order / release-order 意图。

## 服务部署准备

1. 为新协议建立**新工厂、新 marketplace、新 TradingSessionPolicyV2**。不要重新绑定旧工厂，不迁持仓、不覆盖旧 deployment 的身份。
2. 使用 `node scripts/orderbook/deploy.mjs --help` 查看 preflight/plan/deploy/finalize 流程。无秘密模板为 `deployments/arbitrum-sepolia/orderbook-v2/deploy.env.example`。该入口显式选择 V2 脚本、独立 bootstrap salt 和 `deployments/arbitrum-sepolia/orderbook-v2/` 状态目录；默认 V1 入口不变。当前 V2 入口只支持隔离 sandbox/debug；既有 formal 证据工具针对 V1，不能用其生成 V2 正式验收结论。
3. 提供私有部署配置中的 `TRADING_SESSION_PAYMASTER` 和 `TRADING_SESSION_PAYMASTER_CODEHASH`：必须是新站实际使用、已核验的 AA Paymaster，不从旧地址或协议自带 Paymaster 猜测。预检及 Solidity 部署脚本都核验代码哈希。工厂部署脚本同时部署权限策略；新环境 quickTrading 配置引用其地址和代码哈希。正式部署前仍须 provider/kernel 联调。
4. 新部署采用 `marketplaceVersion: "orderbook-v2"`、`protocolVersion: "time-v2"`。本次按用户最终决定完整重置测试环境：旧站入口关闭，旧数据库、配置和镜像归档，旧链上合约不删除。站点仅发布新版环境，不迁移旧持仓。新环境必须保持同一支付资产、Privy 项目和原账户派生参数，账户余额不做搬迁。
5. 每个部署的索引/应用 schema 增量执行现有 migration runner（含 indexer `008_orderbook.sql` 以及 app `007_order_automation.sql`、`008_automation_status_scope.sql`、`009_automation_canonical_audit.sql`）。旧数据库保存在停止的旧卷及三库备份中；新环境使用独立数据库。
6. 建立共用控制数据库/schema，私有环境变量 `CPREDICT_AUTOMATION_CONTROL_DATABASE_URL` 指向它。运行 `node scripts/orderbook/migrate-control.mjs`。同一运行环境的应用和 keeper 使用同一值。若以后重新接入历史环境，须共用该控制库并保留显式关闭偏好。部署索引数据库另由 `CPREDICT_AUTOMATION_DATABASE_URL` 指定。
7. 为每个部署的 claims 与 matching 分配**不同的独立 Gas 账户**，私钥仅放入权限 0600 的服务端文件。配置 expected signer、显式日预算、确认深度、RPC 主备和代码哈希。不要使用用户钱包、Bundler、Paymaster 或部署者私钥充当 keeper。
8. 可使用 `compose.automation.yaml` 的 opt-in `automation` profile；本次仅 V2 运行 claims + matching；旧测试环境按重置决定退出。启动前核对容器能以只读方式读取自己的密钥文件。没有预算和 signer 不启动。不要把私有环境文件放入网页目录。
9. V1/V2 应用使用 `features.automaticClaims: true` 后展示默认开关及说明；先验证控制数据库、只读候选和预算，再启动发送器。本次重置后不再提供旧测试市场的站内入口；旧协议兼容代码仍保留。
10. `/readyz`、`/metrics` 只绑定本地。`cpredict_automation_ticks_total`、`pending`、`blocked{reason}` 与 RPC 池指标用于运维。预算不足/余额不足/原交易未知会写持久状态并输出脱敏告警；Prometheus 规则见 `deploy/alerts/automation.yaml`，需要接入实际采集和通知渠道。

## 可靠性与恢复

- Keeper 在估算 Gas 后增加向上取整的 30% 限额余量，应对 Arbitrum L1 数据费用与执行估算在收录前的波动；费用预留、单笔和日预算均按增加后的最大费用核验。未用限额不计为实际支出。
- 广播失败输出 `automation_submission_failed`，仅记录 lane、原交易 hash、nonce、固定原因和数字 RPC code，不输出节点地址、原错误消息或签名 bytes。广播失败仍进入 unknown，不因日志失败而重播。迁移 011 的 `automation_attempts` 在广播前落库并持久保存最终校验、广播及恢复诊断；仅允许固定原因、节点别名和 32 位 RPC code，禁止记录原始 RPC 错误。
- PostgreSQL 会话 advisory lock 按 chain/signer 串行化 nonce；prepared 交易签名、hash、nonce 在网络发送前落库，CAS 后才广播。
- broadcasting/unknown 默认只查询已登记哈希、不分配新 nonce。显式开启 `CPREDICT_AUTOMATION_AUTO_RECOVERY_ENABLED=true` 后，至少等待 120 秒，每分钟最多核查一次；三个可用节点须一致确认原交易及回执不存在、latest/pending nonce 未变化、共同规范区块哈希相同且头差不超过 120 块，才允许同 nonce 的一次替换。不可用节点不算不存在票；证据冲突、nonce 异常转人工。替换保持 chain/signer/to/calldata/value 不变，原权益人和权限不变，重新模拟、保留 30% Gas 余量，费用至少上调 25%，同时满足单笔、每日预算和余额。原始及替换签名在 CAS/广播前保存于私有数据库。
- 正式广播前在同一选定 writer 校验签名、链/账户/nonce/调用/费用预留，按确定区块执行带实际 Gas 限额和费率的估算及模拟，重新核对区块哈希，再检查偏好、预算和余额。claim 返回值缺失、格式错误或零金额均拒绝；未触及广播的确定失败才取消 prepared，RPC 不可用仍保留 prepared。
- 恢复记录准备后进程崩溃、CAS 后崩溃或广播结果未知均不自动再次发送；只查询原/替换哈希，任一规范最终回执可完成对账并清除两份签名，失败或持续未知留给人工。每个持久任务最多登记一个恢复，替换本身不重试。人工恢复须逐笔授权，禁止删除 unknown、改写为 prepared 或新 nonce 重发。
- 两分钟卡单由独立于 RPC worker 的 15 秒数据库检查产生 `automation_alert_events` firing/resolved 事件；替换不重置计时，也不视为问题已解决。提供 oldest-pending、manual-recovery、alert-unsent/configured/delivery 指标及 Prometheus 两分钟规则。SMTP 邮箱留空时不发送，未发送事件持续保留，不能声称外部通知已接通。SMTP 配置有效时使用验证证书的 TLS、并发租约和退避重试；告警可能至少一次投递，稳定 Message-ID 用于去重。
- prepared 且未广播时会重新核验偏好、链状态、日预算和余额；超时作废还会重新发现触发人的现存权益。已关闭或失效的未发送任务可取消。已发送交易在用户关闭后仍完成原回执查询。
- 日预算按实际标记广播的 UTC 日期统计最大费用预留，保守计费；准备后隔夜发送会重新检查。可选的 `CPREDICT_AUTOMATION_MAX_TX_COST_WEI` 限制单笔估计最大 Gas 费用，缺省等于日预算；超额时保持排队并告警，不签署或发送新交易。confirmed/reverted 清除原始签名 bytes，保留哈希和 nonce。
- 源索引不完整、明显滞后或区块哈希冲突时停止发现任务。链上余额在发送前再次模拟核验；手动抢先领取不会导致改收款人或重复经济执行。
- claims 与 matching 独立 signer/进程，历史批量领取不会占用撮合 nonce。matching 每 2 秒检查订单事件水位，仅有新事件或满 30 秒维护周期时读取链上订单；同一批次同一市场的终态仅查询一次。claims 新版使用持久增量队列；发布状态和性能验收边界见 2026-10-02 一节。两者有在途交易时均每 2 秒查询。
- 平台代付的订单清理在两个 signer 通道共用滚动 24 小时配额：每账户最多 8 笔、每市场最多 80 笔；其中普通到期清理分别最多 4 笔和 40 笔，其余额度预留给阻碍权益领取的终态卖单。终态卖单在撮合候选中优先，配额在签名交易入库时以数据库锁再次核验；超额候选不会发送。旧清理记录仍计入账户总量，未记市场的旧记录无法计入市场量。用户自己撤单、取回托管资产或手动领取不经过后台配额。
- 达到配额会记录脱敏告警日志并增加 `cpredict_automation_cleanup_quota_denials_total{lane,reason}`；告警规则在 `deploy/alerts/automation.yaml`。只有实际接入 Prometheus 与通知渠道后才会外部通知。配额不是每笔 Gas 成本上限；新合约若要由挂单资产覆盖清理成本，需单独确定收费与退款规则，并部署新工厂和协议，不能靠更新现有镜像改变已部署字节码。
- 已确认交易每 5 分钟与索引器的规范区块复核。相同哈希在新块重收录时更新锚点；被深重组移除时撤销个人“已到账”语义，并让仍符合条件且未关闭自动领取的任务重新进入发现流程。此流程不重发 unknown 交易。
- 个人领取历史的金额、市场和结果来自同一笔规范链 `ledger_facts`，不使用发送前估算。索引尚未追到该回执时显示“链上明细索引中”；发生回滚时明细随规范事实一起撤销。
- 2026-09-18 的旧 Marketplace 存在拒收 ERC1155 份额阻塞订单簿的问题，且无法原位修复；其市场已从新站移除。2026-09-24 的新 Marketplace 用隔离转账处理拒收买方，并在卖方拒收返还时移除订单、保留原权益人的待取回份额；财务事实只在实际取回后记账。恶意接收者、重入及托管守恒的测试与静态分析复核见 `docs/orderbook-receiver-security-review-20260924.md`。

## 验收和正式上线清单

本地命令：

```sh
bash scripts/test-all.sh --offline
npx tsc -p tsconfig.json
npx tsc -p examples/user-site/tsconfig.json
npx vitest run
node scripts/orderbook/test-postgres.mjs
npm run site:build
npx playwright test --config examples/user-site/test/browser/playwright.config.ts orderbook.spec.ts
node scripts/public-site/contracts.mjs --check
node scripts/stack/scan-site-bundle.mjs dist/user-site
node --test scripts/orderbook/*.test.mjs
```

准备隔离站点环境（只读链验证，不发送交易、不覆盖旧文件）：编译链下代码后，设置私有 `CPREDICT_ORDERBOOK_VERIFY_RPC_URL`，调用 `node scripts/orderbook/prepare-environment.mjs --pending <V2-pending.json> --template <旧单环境.json> --source-commit <真实源提交> --deployment-block <首次部署块> --id ctusd-orderbook-v2 --prefix /orderbook-test --output <新的environment.json>`。它核验工厂已激活、fingerprint、合约代码、权限策略依赖及支付资产，保留原钱包身份。输出固定关闭新敞口和快捷交易，须在隔离站点完成配置及 provider 测试后显式开启；不会修改生产 site-config。

本地验收记录：Solidity 185 项通过（全量首轮 170 项，补上 Permit2 0.8.17 独立编译产物后原两套用例 15 项通过），其中 V2 16 项、模糊测试 10,000 次、不变量 128,000 次；相关服务 44 项、PostgreSQL 48 项、浏览器 6 项通过。前后端类型检查及前端构建通过，637 个前端文件凭据扫描零发现。完整 Vitest 仍有 1 项既有 deposit quota 断言失败（535 通过，66 集成用例在该命令中跳过）；该失败已在未修改的 RPC 工作区复现，本次 PostgreSQL 独立命令实际执行了相关集成用例。

Compose 以云端已有 v5.5.1 CLI 对本地 base + automation 输入执行只读 `config --no-interpolate --no-env-resolution --quiet`，校验通过。该项为早期静态证据；后续云端镜像构建、运行时挂载及七个容器健康检查另有实际验收。

隔离演练使用随机临时签名账户、loopback Anvil 和一次性 PostgreSQL schema，结束删除，不读取真实钱包或公网凭据。验收文件位于 `reports/generated/orderbook/` 和本任务 `work/task-state/`。

## 2026-09-18 首次公网测试发布验收（历史记录）

- 入口：`https://43.160.199.165/ctusd-orderbook-v2/markets`；仅一个新版环境。旧 `/ctusd-platform-fees/` 返回 410。
- Factory：`0x0BC9bd3794E4cf92aE5328B4851307D81Fad7552`；Marketplace：`0x2Aa0AaBa55BC3AA0b1a0eEAB08c2aF0483E3D97B`。13 笔部署和 2 笔 bootstrap 交易确认。部署状态仍为 sandbox `FINALIZED_PENDING_EVIDENCE_VERIFICATION`，不能声称 formal/mainnet 验证。
- 实测买卖单创建、自动部分撮合、主动接单、撤单及退款。云端撮合按先挂卖单价格 0.8 成交 4 份，买单余款与剩余 2 份准确。
- 自然封盘后结算测试市场，12 笔后台交易全部确认，覆盖自动成交、终态挂单返还、押金结算、中奖、早鸟、费用及押金领取；逐笔核对收款人，领取零用户签名。公网超时作废尚未等待一天完成；该边界由隔离 Anvil 测试覆盖。
- 最终账务对账 28 项通过，快照块 310205881。切换后七个新服务健康、索引追平，receipt pending/unresolved 均为 0。
- 原钱包派生方式和 ctUSD 地址保持；两个 keeper 各有独立测试 Gas 账户，分别充值 0.01 ETH、日预算 0.005 ETH。
- 三库在旧写入者停止后导出、校验 SHA256 和归档目录；五个旧容器已停止，旧卷及镜像保留。归档目录：`/home/ubuntu/cpredict-migration/orderbook-v2-20260918/final-old-backup`。
- 公网网页检查确认新环境、完整市场地址、求购/挂卖说明、已结算市场及 Privy 登录入口。真实交易验证直接使用 Kernel/provider，未冒充已登录浏览器 E2E。
- 在 2026-09-18 首次发布时，源码仍为当时分支的未提交改动；云端构建清单记录 641 个输入文件及其哈希。此句仅描述首次发布的历史状态，不代表上方 2026-09-23 的 `main` 提交及增量发布状态。现有封版标签不变。

证据：`work/task-state/orderbook-automatic-claims-accepted.json`、`orderbook-public-https-acceptance.json`、`orderbook-live-acceptance-capture.txt`。云端对应目录还保存 `final-reconciliation.json`、`live-acceptance.json`、`cutover-complete.json`。定时巡检维持已删除状态。

回退：关闭 V2 新增下单和后台调度，保留新版订单撤销、资产退出、手动领取和历史查询；旧测试环境不自动恢复公开。不要回滚业务数据库，也不要把未知发送记录恢复到 prepared 或删除。

## 有限恢复的运维边界（2026-10-02）

新增迁移只添加控制表和列，旧业务数据及协议不变。先备份控制数据库，再使用表所有者/既有 migrator 的控制数据库连接运行 `node scripts/orderbook/migrate-control.mjs`，为受限 keeper 角色授予三个新增表的 SELECT/INSERT/UPDATE 和两个序列的 USAGE/SELECT。服务角色不得用于 ALTER TABLE，也不扩大其 DDL 权限；服务启动只检查迁移，不自行改库。首次仅在 claims 私有运行配置开启自动恢复，matching 默认关闭；缺少三个 writer 时启动拒绝。回退优先使用同一候选镜像关闭自动恢复，继续对账原/替换哈希，保留迁移及当前记录。尚未登记恢复时才可使用之前领取镜像；登记恢复后，旧镜像不认识双哈希，不能直接回退。已经替换或已到账的交易不能恢复成旧 hash。

人工介入时先查看 `automation_transactions`、`automation_attempts`、`automation_recoveries` 及双方回执。节点冲突、nonce 已变化、调用或签名不一致、一次恢复已耗尽、替换持续未知及权限/权益失效均不具备再次自动发送条件。暂时 RPC 故障、原交易仍在节点中、用户关闭开关和预算不足只等待，不增加交易；原交易已到账自动补记。控制表含原始签名，备份和访问须按私有配置保护。

外部邮件未配置；本地测试与部署证据以 `work/task-state/claims-recovery-20261002/checkpoint.md` 为准，文档不代表已部署。队列分片不在本批次内。
