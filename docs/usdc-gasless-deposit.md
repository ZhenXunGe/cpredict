# USDC 免 Gas 入金：实现与阶段验收

2026-09-11 更新：本阶段交付默认关闭的代码、增量迁移、配置模板与测试。按用户最新范围，独立 USDC 环境部署、域名和供应商配置、PC 真实钱包代付及资金闭环验收后移。当前 ctUSD 仍走原代付领币流程。没有向测试网广播交易，也没有启用入金或修改供应商项目。

## 固定范围

仅支持 Arbitrum Sepolia（421614）的 Circle USDC `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`，6 位精度；Kernel 0.3.1、EntryPoint 0.7、USDC index 1002。ctUSD index 1001 保持原值。本实现不能直接作为主网配置启用；主网地址、domain、账户与部署需要单独验证。

资金钱包是普通 EOA，可以与应用账户控制钱包不同。连接资金钱包使用 Privy `useConnectWallet`，不执行登录、绑定账户或切换当前账户。MetaMask / Rabby 使用现有外部连接入口，邮箱 / Google 使用现有登录与内嵌控制钱包入口。当前验收只证明界面行为，未证明这些真实钱包组合已经通过。

1. 应用服务为目标账户准备固定授权，生成并持久化随机 nonce，有效期 10 分钟。
2. 资金钱包签署 EIP-712 `ReceiveWithAuthorization`。签名前读取真实 USDC 的 name、decimals、domain separator 和 receive typehash；版本固定为经验证的 `2`，名称为 `USD Coin`。
3. 服务端恢复签名人，核对记录、身份、余额、EOA 代码、暂停/黑名单、nonce 和授权时间，再进入现有操作登记与 AA 链路。进入 AA 准备时，授权剩余时间须大于 `sponsor.validitySeconds + 10` 秒。
4. 应用账户控制钱包另行签署 UserOperation。Kernel 调用 USDC 的 `receiveWithAuthorization`，调用者和 `to` 都是当前应用账户。没有中转合约、approve、自动自付 ETH 或 USDC Gas 扣费。
5. 校验和模拟后，网关保存准确 UserOperation hash，再发送一次。恢复只查询原 hash。成功需要该 UserOperation 成功，并在其执行日志范围内匹配同一 USDC 的 `AuthorizationUsed` 和金额精确的 `Transfer`。

原理与代币地址依据：[EIP-3009](https://eips.ethereum.org/EIPS/eip-3009)、[Circle 官方地址](https://developers.circle.com/stablecoins/usdc-contract-addresses)。

## 数据与接口

权威类型为 `offchain/app-core/src/contracts.ts` 中的 Zod。`generated/public-site/contracts.json` 由 `site:contracts` 生成，不能手改。

1. `POST /v1/deposits/prepare`：登录后提交 `accountId, source, amount, idempotencyKey`，金额为 USDC 最小单位十进制字符串。返回 `{deposit}`，包含固定 domain、授权、有效期和记录 ID；不返回签名。
2. `GET /v1/deposits?accountId=…&active=true&limit=30&cursor=…`：仅查询当前用户已验证的应用账户；省略 `active` 可查询历史。结果为 `{items,nextCursor}`。服务端游标绑定环境、主体、账户和筛选。
3. `GET /v1/deposits/:id`：返回 `{deposit,recovery}`，关联操作存在时同步执行原操作恢复。查询失败保留上次状态并返回 `recovery: "unavailable"`。
4. `POST /v1/deposits/:id/cancel`：只取消未提交流程或无已保存发送 hash 的待签操作。已提交/未知状态只能继续查询。取消流程不等于撤销链上 USDC 授权。
5. 原 `/v1/operations/prepare` 与 `/v1/operations` 接受 `deposit-usdc` 意图，包含 `depositId, authorization, signature`。服务端逐字段核对保存记录；前端独立重建 USDC 调用并核对 Kernel callData。原登记幂等、工厂、账户 nonce、Gas 上限和恢复规则继续生效。
6. `GET /v1/ops/deposits?start=…&end=…&limit=30&cursor=…`：仅服务端 `adminSubjects` 中的只读管理员可以查询；时间为 UTC ISO 的半开区间，最多 32 天。可增加 `id`、`accountId` 或 `source`。返回无签名的入金记录，包含金额、状态、原因、关联操作、hash、区块及实际单笔 Gas；不返回登录主体或可执行 callData。USDC 运营页使用此接口，普通历史页使用用户接口。

新增迁移 `offchain/app-service/migrations/003_usdc_deposits.sql`。同一用户的幂等 key 唯一，同一代币/来源/授权 nonce 唯一，关联操作 ID 唯一。账户未决入金检查、创建、取消和操作关联沿用同一个数据库事务锁；操作登记与入金关联在一个事务里完成。数据库永久绑定环境及部署，USDC/ctUSD 不共用数据库。

未签记录可以过期；已经保存发送 hash 的未知记录不能仅因授权过期改成失败。回滚记录在最终确认前继续阻止新入金。结果与金额从原操作和转账事实投影，不另建一套余额/收益记账。资金来源不会因转入而成为控制者。

浏览器仅保存入金 ID 和原操作恢复 key；资金签名只在当前确认窗口内存中存在。服务端签名仅保存于私有操作记录，日志、运营接口和前端历史详情不输出可执行签名。

## 开关与预算

`environment.features.gaslessDeposit` 可省略，省略或 `false` 均关闭。USDC 模板明确为 `false`，ctUSD 旧配置继续有效。入金同时要求 `newExposure` 和 `sponsorship` 开启，且服务端 sponsor 配置完整。准备、登记、代付回调和发送都会复核开关。

入金占用新增操作额度：每环境每周 0.1 ETH，总额中的 0.08 ETH 用于新增操作，0.02 ETH 留给退出。继续使用原项目/账户/用户/方法限额，并以 `sponsor.methodDailyOperations` 限制每个已验证资金 EOA 的每日入金操作数；先验证签名，再登记和预留额度，不能伪造来源占用他人额度。每日限流按现有 UTC 日，周预算按上海周一；二者独立。

ZeroDev 的 Custom Policy 仍要求精确的已登记操作、正确项目/链、AND、出错拒绝。本地额度配置不证明供应商硬上限已经生效。代付失败时停止，不切换支付方式。

## 本阶段证据

1. `npm run test:offchain`：269 通过。该命令中的 36 个 PostgreSQL 用例因没有外部数据库变量而跳过，已用下一项真实数据库通道全部执行。
2. `npm run site:test:postgres`：自有本地 PostgreSQL 集群，原地升级/恢复 7 项通过；公开站用例 27/27，全部公开站及原服务用例 36/36，无跳过。覆盖同 key 并发、登记/取消竞争、重启恢复、未知状态、来源限额和管理员分页脱敏。
3. `npm run site:test:browser`：52/52 通过、无重试，包含 PC Chrome 与 390px 窄屏。新增入金用例使用模拟身份、无效占位资金签名，控制钱包边界拒绝真实签名；不连接外部 RPC、钱包或供应商，不能替代真实登录及代付。
4. `npm run site:check:dependencies` 与完整 offchain 编译通过；依赖版本未升级，保持严格依赖声明检查。站点构建与生成契约一致性检查通过。
5. 真实 Circle USDC 固定区块分叉：区块 `307486321`，hash `0xb9535918d67342063b993caea9c08e5f659304d541c495567dcee1669dd615ca`；56 项检查、12 个本地 UserOperation。覆盖同一/独立来源 × 首次部署/已部署 Kernel、三个用户地址均零 ETH、精确转账、无 allowance、重放/错误链失败、真实回执归属和代理代码不变。

分叉在本机私有 Anvil 上模拟 USDC minter 以提供测试余额，并由本地 relayer 预存 EntryPoint Gas。它证明真实代币与 Kernel 的机制兼容，**不证明 ZeroDev 托管 Paymaster 已代付**。报告包含区块、代码 hash、工具和输入文件摘要；签名与私钥不进入报告。重新生成可用：

```sh
npm run site:test:usdc-deposit-fork -- \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc \
  --block 307486321 \
  --output reports/generated/public-site/usdc-deposit-fork-recheck.json
```

本次报告位于 `reports/generated/public-site/usdc-deposit-fork-final.json`，浏览器报告为同目录 `browser-regression.json`。这些是被 Git 忽略的本地证据，需在以后发布时单独脱敏归档。移动实机、实际 MetaMask/Rabby/邮箱/Google 组合、托管代付、公开 HTTPS、资金闭环均尚未验收。

## 后续发布与关闭入口

当前不执行下列外部步骤；待 USDC 发布阶段恢复：

1. 从已确认源码版本创建独立 USDC 协议部署，使用现有 `debug` 测试部署路径，沿用经核实的测试角色；保存交易、部署区块、manifest、代码 hash。本入金方案不新增托管合约。该协议部署包含的旧 Paymaster 不改变应用账户的 Kernel 0.3.1 / EntryPoint 0.7 / ZeroDev 路径。
2. 核对独立 USDC 数据库、index 1002、Privy/ZeroDev `cpredict-prod` 项目、回调和供应商硬上限。此处 `prod` 只是已有供应商项目名，仍是测试网。默认关闭 `gaslessDeposit`，先运行迁移，再启动应用/索引；迁移 003 已进入 Compose、维护工具和备份迁移清单。
3. 复用 `site:maintain validate-site` 生成双环境公开配置，现有 `stack:config -- --public-site --usdc` 校验隔离，再按原运行手册从 main 更新目标主机。受限验收期间依靠已配置访问限制与受控测试账号，不向公众提前开放。
4. 由用户完成真实钱包登录与两次签名，记录资金 EOA、控制 EOA、首次部署应用账户三者前后 ETH/USDC 余额、业务 ID、授权 nonce、UserOperation、交易/区块和实际 Gas。再完成购买、C2C、领取/退款及退出，对账资金与费用，并演练响应丢失、重启、回执延迟和重组。
5. 验收后才开放入口。异常时同时关闭服务器与公开配置中的 `gaslessDeposit`，保留 `sponsorship` 供已有资产退出（预算允许时）。查询、历史和恢复不依赖入金开关。回退应用版本时保留新增表、原操作和迁移校验和，不删数据库、不自动重发未知操作。
