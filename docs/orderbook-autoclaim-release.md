# 求购、自动撮合与自动领取：V2 发布说明

## 当前测试站快照（2026-09-23）

当前公开入口仍是 `https://43.160.199.165/ctusd-orderbook-v2/markets`，使用 Arbitrum Sepolia 的 ctUSD 测试资产。以下是**组件分别核对**的运行状态，不代表正式审计、主网发布或真钱可用：

| 组件 | 当前运行版本 | 2026-09-23 增量发布范围 |
| --- | --- | --- |
| 网页 | `cpredict-web-demo:main-fa27144-20260923` | 创建求购/挂卖、主动接单和一级购买在提交前读取实际可用资产或份额，余额不足时给出具体提示；自动撮合订单的最小成交量若会取整为零，页面给出提示。 |
| 自动领取、自动撮合 | `cpredict-automation:main-fa27144-20260923` | 撮合候选在未消费时保留队列；领取候选输出前校验规范链快照，避免在扫描期间继续使用已失效的索引视图。两个服务仍使用独立 signer/nonce。 |
| 应用、索引、规则服务 | 保持此前已部署镜像 | 本次未替换这些服务，不能把它们描述为运行 `fa271445`。 |
| 链上 V2 合约 | 仍为 2026-09-18 已部署版本 | `fa271445afb0d0b23429ce79e746847e3a2e482b` 中的 `OrderbookMarketplaceV2.sol` 零金额最小成交保护**只在源码和生成产物中，尚未上链**。当前合约继续按其既有字节码执行。 |

当前工厂的 Marketplace 地址只能绑定一次，不能把新交易合约替换到旧工厂。要使这次 Solidity 保护在新市场生效，须另外部署并核验新工厂、Marketplace 和权限策略，再单独安排新环境/市场入口切换。已存在的市场、订单和持仓仍受原合约约束；旧测试市场目前不提供站内入口，但链上资产不会因网页切换而消失。不得声称只更新网页和自动化镜像就升级了旧市场的链上规则。

本次提交的本地验证：浏览器回归 184/184，PostgreSQL 46/46，含 Anvil 的 PostgreSQL/订单回归 56/56；前后端类型检查、前端构建、合约编译与 Forge 测试及生成物检查通过。云端 2026-09-23 切换后，公开页面返回 HTTP 200，七个业务容器健康，索引 `/readyz` 返回 200；回执 `pending=0`、`unresolved=0`，两个自动化队列 `pending=0`。索引落后数在发布采样中波动，后续采样为 0。公网页面冒烟检查不等于新补丁在真实钱包的完整已登录交易验收，也不证明尚未上链的合约分支。

云端构建、发布与回退证据位于 `/home/ubuntu/cpredict-migration/review-fixes-20260923-fa27144/`，包含发布前 Compose/镜像清单、可校验的 PostgreSQL 备份、发布后 `deployment-acceptance.json` 和构建日志。需要回退网页或自动化时先核对该目录保留的原镜像与私有配置；不要重发结果未知的链上交易，也不要用数据库回滚覆盖发布后用户数据。本次文档提交不会更新云端镜像或链上合约。

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

- PostgreSQL 会话 advisory lock 按 chain/signer 串行化 nonce；prepared 交易签名、hash、nonce 在网络发送前落库，CAS 后才广播。
- broadcasting/unknown 只查原 hash，不自动重播、不分配新的 nonce。进程在“标记广播但尚未发送”的间隙崩溃会保守地保持未知，须运维核查；不能用删除记录解决。
- prepared 且未广播时会重新核验偏好、链状态、日预算和余额；超时作废还会重新发现触发人的现存权益。已关闭或失效的未发送任务可取消。已发送交易在用户关闭后仍完成原回执查询。
- 日预算按实际标记广播的 UTC 日期统计最大费用预留，保守计费；准备后隔夜发送会重新检查。confirmed/reverted 清除原始签名 bytes，保留哈希和 nonce。
- 源索引不完整、明显滞后或区块哈希冲突时停止发现任务。链上余额在发送前再次模拟核验；手动抢先领取不会导致改收款人或重复经济执行。
- claims 与 matching 独立 signer/进程，历史批量领取不会占用撮合 nonce。matching 每 2 秒检查订单事件水位，仅有新事件或满 30 秒维护周期时读取链上订单；claims 无任务每 30 秒补扫；两者有在途交易时均每 2 秒查询。
- 平台代付的订单清理在两个 signer 通道共用滚动 24 小时配额：每账户最多 8 笔、每市场最多 80 笔；其中普通到期清理分别最多 4 笔和 40 笔，其余额度预留给阻碍权益领取的终态卖单。终态卖单在撮合候选中优先，配额在签名交易入库时以数据库锁再次核验；超额候选不会发送。旧清理记录仍计入账户总量，未记市场的旧记录无法计入市场量。用户自己撤单、取回托管资产或手动领取不经过后台配额。
- 达到配额会记录脱敏告警日志并增加 `cpredict_automation_cleanup_quota_denials_total{lane,reason}`；告警规则在 `deploy/alerts/automation.yaml`。只有实际接入 Prometheus 与通知渠道后才会外部通知。配额不是每笔 Gas 成本上限；新合约若要由挂单资产覆盖清理成本，需单独确定收费与退款规则，并部署新工厂和协议，不能靠更新现有镜像改变已部署字节码。
- 已确认交易每 5 分钟与索引器的规范区块复核。相同哈希在新块重收录时更新锚点；被深重组移除时撤销个人“已到账”语义，并让仍符合条件且未关闭自动领取的任务重新进入发现流程。此流程不重发 unknown 交易。
- 个人领取历史的金额、市场和结果来自同一笔规范链 `ledger_facts`，不使用发送前估算。索引尚未追到该回执时显示“链上明细索引中”；发生回滚时明细随规范事实一起撤销。
- 恶意 ERC1155 接收者可以拒绝收货导致该最佳价成交回滚；资金保持原状，不跳过最优价或更换收款人。其他订单仍可手动接单/撤销；拒绝接收方可能阻塞该价位直到撤单或到期，此限制必须纳入公网验收。

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
