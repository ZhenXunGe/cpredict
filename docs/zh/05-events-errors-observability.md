# 事件、错误与可观测性规范

## 1. 机器可读注册表

`npm run generate:artifacts` 从最终 Foundry ABI 生成：

- `generated/abi/*.json`：11 个部署合约完整 ABI；
- `generated/registries/events.json`：event signature、topic0、inputs、contract；
- `generated/registries/errors.json`：custom error signature、selector、inputs、contract；
- `generated/registries/bytecode.json`：creation/runtime bytes 与 SHA-256；
- `manifests/source-manifest.json`：源码/依赖锁/编译参数/bytecode 证据。

注册表由 ABI 生成而非手工维护；本轮新增 activation/bond/Paymaster 接口后必须重新运行 generate/check，
改动前的 registry/source manifest 不能证明当前 ABI。`generated/registries/selectors.json` 固定 SDK/error decoding
所需函数 selector，`generated/storage-layout/` 固定 Clone/Full storage layout。ABI 或布局变化必须在
code review 中检查 snapshot diff。

## 2. 事件域

| 域          | 关键事件                                                                                                   | 监控用途                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Factory     | `MarketplaceConfigured`、`FactoryActivated(fingerprint)`、market/mode/salt/implementation/runtime codehash | 激活前接线、部署完整性、Clone 风险标识                                                       |
| Primary     | desired/fill/payment/outcome/weight                                                                        | cap、成交、早鸟重放                                                                          |
| Terminal    | resolve/creator void/timeout                                                                               | 非法状态、结算 SLA                                                                           |
| Claims      | winner/refund/early/bonus、最终池清空事件                                                                  | 池守恒、领取次序与原子单位分配、复投漏斗；不能把最终事件误读为只有最后领取者获得所有舍入余数 |
| Marketplace | create/fill/cancel/terminal return                                                                         | 托管余额、成交价、异常交易                                                                   |
| Bond/Fee    | lock/settle/fund、`EmptyTimeoutBondCredited`、accrue/claim                                                 | credit solvency、零参与者 timeout、重复处理                                                  |
| Guard       | register/reserve/sync/cap/retire                                                                           | 版本敞口和 headroom                                                                          |
| Governance  | 配置、deprecate、授权、emergency epoch                                                                     | 变更告警与 timelock 追踪                                                                     |
| AA          | signer/budget/reserve/settle/deposit/stake                                                                 | 赞助损失上限与滥用                                                                           |

标准 ERC-1155 `TransferSingle/Batch`、ApprovalForAll 和 URI 仍必须消费。事件不是会计真相；监控在
每批结束后用 balance/storage 抽样对账。

## 3. 错误分类

custom errors 按 Auth、Config/Range、Time/State、Capacity/Accounting、Factory/Clone、Listing/
Payment、Bond/Fee/Guard、Paymaster 分类。客户端只能用 selector 做稳定分类，不能依赖 provider
错误字符串。用户文案必须把 expected revert（cap 已抢完、listing 已成交、deadline 过期）与
协议故障（insolvent/invariant/codehash mismatch）分开。

Factory 启动类至少区分 `FactoryNotActive`、`DependencyCodeMissing`、
`DependencyWiringMismatch` 与 `DependencyFingerprintMismatch`；creator 在 deadline 调用 resolve/void
以 `ResolutionWindowExpired` 返回，而 deadline 前 permissionless timeout 以 `TimeoutNotReached` 返回。
Paymaster gas header 越界使用 `InvalidConfiguration(paymaster.*GasLimit)`，签名与预算失败不得混成 RPC 错误。

## 4. Indexer 语义

- 幂等主键 `(chainId, transactionHash, logIndex)`；
- `canonical_blocks` 保存每个扫描区块（含无事件块）的 number/hash/parentHash/timestamp；
- checkpoint hash 不一致时逐块向后找到 common ancestor，raw event、registered market 和所有 derived
  projection 必须在同一事务回滚，再从新 canonical branch replay；
- Factory `MarketCreated` 动态注册 Vault，同批查询必须包含新 Vault，避免漏掉同交易较早的初始化事件；
- provisional 至少等待配置 confirmation depth；
- 绝不按事件 arrival order 推断同块顺序，使用 block/tx/log index；
- ABI 未知、decode 失败、重复/缺口、RPC 分歧均独立计数；
- submitted、included、success、expected-revert、unexpected-revert 分开统计。

只读 API 提供 `/v1/markets`、单 market、listings、fills、owner positions/claims，金额与 block number
以十进制字符串输出并限制分页。内存 store/API/common-ancestor 用例已执行；独立 disposable
PostgreSQL 17.10 lane 实跑 migration/transaction/readiness，共 9/9、0 skip。普通链下命令中的 5 个
conditional skip 与该独立 lane 不冲突；本地真实数据库 PASS 仍不是生产数据库运行验收。

## 5. 告警

Critical：Vault assets<liabilities、非法 terminal transition、部署 codehash/role 漂移。Page：
indexer >2 L2 blocks、RPC divergence >1、Paymaster deposit 异常消耗、Guard headroom 低。Warning：
大额/高频 C2C、creator 关联地址行为、赞助拒绝激增、Fee/Bond claim backlog、USDC transfer failures。

`monitoring/prometheus/cpredict-alerts.yml` 只是规则模板；没有运行中的 Prometheus/Alertmanager
证据。Sentry 必须清除 private key、signature、authorization、cookie、完整 UserOperation 和 PII。

## 6. 回溯流程

每个用户问题记录 chainId、contract、tx hash、block hash、function selector、error selector、
market/listing ID、submitted/included 状态和客户端版本。先从 receipt/log/storage 复原，再对比
indexer；禁止仅凭前端 toast 或后端聚合标签给出根因。
