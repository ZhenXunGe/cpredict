# ctUSD 快捷交易

本功能默认关闭。`environment.quickTrading` 独立于 `environment.deployment`，不能为了添加权限模块修改部署 ID、manifest hash 或账户派生 index。USDC 不开放快捷交易。

## 配置

配置字段由 `quickTradingConfigSchema` 校验。`version=1`，`policy/policyCodeHash` 为本次部署的 `TradingSessionPolicyV1` 地址和运行时代码的 keccak256；`signer/signerCodeHash` 为锁定 SDK 使用的 ECDSA signer 模块；`paymaster` 必须与实际代付返回值一致。

金额使用 6 位小数的最小单位字符串，默认值如下：

| 字段                                      | 默认值        |
| ----------------------------------------- | ------------- |
| `enabled`                                 | `false`       |
| `defaultPerOperation` / `maxPerOperation` | `100000000`   |
| `defaultTotal`                            | `1000000000`  |
| `maxTotal`                                | `10000000000` |
| `maxDurationSeconds`                      | `86400`       |

有效期最多 24 小时，预算使用 uint128。默认值不能超过上限，单笔不能大于累计。更改配置只影响新授权；现有权限使用签署时的公开描述。服务启动时核对模块代码哈希及 Factory、Marketplace、Token、BondEscrow、FeeVault、Paymaster 六项不可变绑定。

## 权限执行

账户继续使用原 ECDSA sudo、Kernel 0.3.1、EntryPoint 0.7、index 与 MetaFactory。`@zerodev/permissions@5.6.3` 的 regular permission 同时绑定自定义 policy 和 execution hook。策略合约不替换已有市场。

- 验证阶段检查完整调用组合、零 ETH value、执行模式、指定 Paymaster、期限和预算。禁止 delegatecall、独立 approve、额外调用、资产转出、升级和通用消息签名。
- 买入仅允许清零、精确授权、买入、清零四连调用。挂单仅允许开启 ERC-1155 授权、创建挂单、关闭授权三连调用。
- 执行钩子检查 Factory 登记、挂单卖家和押金创建者。动态跨合约读取位于执行阶段，避免违反 ERC-4337 验证阶段的存储访问限制。Kernel 的 hook `isInitialized` 和一字节 hook 安装标志均已适配。
- 预算按 `maxPayment` 在验证阶段扣减；后续执行失败也不恢复。退款、领取、卖出不增加预算。ID 和账户共同隔离计数，重复安装不能重置，未安装权限也可以先撤销。
- 领取受益人为当前资产账户。创建市场、发布结果、作废、水龙头、入金和资产转出使用控制钱包签名。

legacy-v1 与 time-v2 使用的买入、挂单和领取调用选择器保持兼容；每份策略绑定所属部署的 Factory。分叉验证在真实 Kernel/EntryPoint 上运行了固定历史源码的 legacy-v1 和当前 time-v2 实际 FullMarketVault 合约的买入、份额归属及退款，确认退款不恢复预算。市场登记、应急开关和风险敞口依赖使用测试夹具；完整线上部署仍需联调。legacy 源码固定为 `a196e7784f26675c552997ed5199b96e0a1797b2`，构建脚本仅在 `.tools` 中提取和编译，不更改当前工作区源码。

## 服务端接口

所有接口沿用环境头、部署头、登录身份和账户归属检查。

| 接口                                                | 请求 / 返回                                               |
| --------------------------------------------------- | --------------------------------------------------------- |
| `POST /v1/trading-sessions/prepare`                 | `accountId, publicKey, perOperation, total` → `{session}` |
| `POST /v1/trading-sessions/:id/activate`            | `signature` → `{session}`                                 |
| `GET /v1/trading-sessions?accountId=...&cursor=...` | `{items,nextCursor}`，每页最多 20 条                      |
| `GET /v1/trading-sessions/:id`                      | `{session,spent,pending,revoked}`                         |
| `POST /v1/trading-sessions/:id/disable`             | `{}` → `{session}`                                        |
| `POST /v1/trading-sessions/:id/revoke/prepare`      | `gasPayment` → 普通控制钱包操作准备结果                   |
| `POST /v1/trading-sessions/:id/revoke`              | 标准操作注册请求，intent 必须撤销当前 ID → `{operation}`  |
| `POST /v1/trading-sessions/disable-all`             | `{}` → `{disabled:true}`，仅当前登录主体                  |

prepare 的授权内容有效准备窗口为 5 分钟。activate 重新构造规范 Kernel typed data，核对 hash 和控制钱包签名后丢弃签名。数据库仅保存公开描述和 `prepared/active/disabled` 状态；迁移为 `006_trading_sessions.sql`。

操作 prepare、register 和 operation 记录增加可选 `signingMode`、`sessionId`。旧请求默认为 controller。会话模式必须明确提供 ID 且使用项目代付；nonce 来自对应 permission。注册、代付回调和最终提交仍执行服务端检查，数据库事务保护并发预留，未知结果仍查询原操作。

链上撤销复用普通操作流程：`{kind:"revoke-trading-session",sessionId}`。此操作只能由控制钱包签名，可选项目代付或自付 ETH；开始准备撤销时先停用服务端记录。只有链上查询确认 revoked 才显示“链上已撤销”。关闭快捷开关不会关闭查询或撤销。

## 浏览器与等待时间

会话密钥在客户端生成，和首次 enable signature 一起用 AES-GCM 加密后保存到 IndexedDB。包装密钥不可导出，额外认证数据绑定用户、环境和账户。服务器从不接收会话私钥；日志继续屏蔽请求体和授权头。

刷新恢复同一 permission；BroadcastChannel 同步停用，Web Locks 串行化当前账户提交，退出时更新浏览器失效标记、停用服务端记录并删除本地凭证。异步授权或签名在退出后不能继续提交。清理本地凭证不等同于链上撤销；服务端停用失败会明确提示重试。

内存缓存仅复用本地 Kernel/签名器实例；每笔仍查询会话状态、获取正确 nonce、核对当前控制者并重新进行服务端注册。切换账户、退出、跨标签页停用会清除缓存。独立的客户端读取、账户核对和服务端准备并行执行；没有预签最终交易、自动改成控制钱包签名或关闭 Privy 默认 UI。

授权过期、预算不足、自付 ETH 时，用户必须选择重新授权或逐笔控制钱包签名。站内确认弹窗始终保留，提交结果与链上确认分别展示。

## 本地验证与开放门槛

可重复运行：

```sh
npm run site:check
npm run check:offchain
npx vitest run offchain/app-core offchain/app-service examples/user-site/test --exclude '**/browser/**'
.tools/foundry/bin/forge test --match-contract TradingSessionPolicyTest --offline
node scripts/public-site/test-trading-session-postgres.mjs
npm run site:build
npx playwright test --config examples/user-site/test/browser/playwright.config.ts trading-session.spec.ts deposit.spec.ts
npm run site:test:trading-session-fork -- --rpc-url https://sepolia-rollup.arbitrum.io/rpc --block 308757042
```

固定区块 308757042 的本地验证通过 29 项检查。历史重放需要支持该区块状态的归档 RPC；公共 RPC 可能裁剪历史状态，此时应选定新的固定区块并保存区块 hash，不能跳过检查。

分叉 runner 只对测试网发起读取；部署、资产、密钥、代付及 UserOperation 全在自有的临时 Anvil 内。macOS 无原生 Anvil 时使用固定镜像与二进制摘要的 Foundry 容器。数据库 runner 使用锁定 PostgreSQL 镜像和临时回环端口，不接触运行中的业务数据库。

浏览器用真实 WebCrypto、IndexedDB 和生产确认组件，交易传输及两种钱包身份为夹具；没有真实 Privy 登录或外部钱包弹窗。分叉证明真实 Kernel/EntryPoint 行为，但不证明供应商 Bundler 的全部验证规则。分叉报告额外保存 20 组只读准备微基准，明确排除了托管服务、人工钱包等待和链上确认，不能冒充公开环境性能验收。

最近一轮 20 组本地微基准：准备 p50 从 34.69 ms 降至 27.07 ms（约 22%），p95 从 46.63 ms 降至 34.89 ms。该微基准尚未达到 30% 目标，且不是公开环境验收；不得据此打开开关。

开放前仍须：

1. 在实际 legacy-v1、time-v2 市场完成同一策略的调用联调，核对实际 Paymaster 与 Bundler 接受策略。
2. 部署并登记模块哈希，使用真实内嵌钱包及外部钱包完成授权、连续两笔小额操作、刷新、退出和链上撤销。
3. 在同一公开环境、相同交易条件下收集至少 20 组优化前后样本，分开记录准备、钱包人工等待、提交和链上确认；准备 p50 降低至少 30% 后再开放。

部署工具默认只生成待审阅的未签名请求：

```sh
node scripts/public-site/deploy-trading-policy.mjs \
  --runtime <ctUSD-runtime.json> --env-file <restricted-runtime-env> \
  --paymaster <verified-paymaster-address> --output <new-preview.json>
```

同样参数加 `--broadcast`、使用新的输出文件才会部署。凭据仅从受限环境文件读取；工具不打印私钥、供应商 URL 或签名。部署前核对现有资产部署，部署后核对六项依赖和模块运行时代码，并始终生成 `enabled:false` 配置。广播前保存发送者和 nonce、返回后立即保存交易 hash；结果未知时查原部署，禁止覆盖报告盲目重发。真实验收通过后再由运行配置显式开启。

## 默认关闭状态的应用发布

`006_trading_sessions.sql` 仅新增公开会话元数据表、归属查询索引和操作 JSON 的可选 sessionId 索引，不删除或改写既有数据、字段及约束。已将其内容摘要登记到 `deploy/public-site/update-policy.json`。常规发布先备份 indexer 数据库、暂停 indexer 和 app-service 写入，再应用迁移并恢复服务；旧应用可继续使用原有表结构。

本轮应用发布保持快捷交易关闭，普通控制钱包操作仍省略会话签名字段。链上策略部署与真实钱包验收按上述开放门槛单独完成。
