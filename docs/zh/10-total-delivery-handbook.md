# Cpredict V1 总交付册

## TL;DR

Cpredict V1 是不可升级、每市场隔离的 USDC 彩池协议，提供 creator 主权结算、机械超时退款、
ERC-1155 份额、固定价 C2C、早鸟、bond/fee 分账、受限应急、Full/Clone、Permit2/AA 接口。
核心代码与本地验证已落地，但当前未外审、未部署、未完成强制安全门禁，不得用于真实资金。
所有会变化的门禁数字只以 [当前候选状态](00-delivery-status.md) 为准；本册负责操作说明，不另建
第二套状态真相。

当前全协议 mutation 已终止且无可用全协议 score；release tooling 39/39 仅属静态 PASS。22-gate
release-audit、GitHub OIDC attestation 和 signed-tag 外部 evidence 验签链已实现，但真实 OIDC/CI
未运行。Echidna arm64 百万调用已通过，但 x86_64 lifecycle、mutation、商业负载仍阻断发布。
商业负载 schema-v4 三机工具链已静态/fixture 验证，但正式运行仍为 NOT RUN；商业经济评估器已测试，
但因无已批准阈值、真实 Arbitrum receipt 和独立业务数据，当前七项均为 NOT_VERIFIED。这两项没有修改
V1 Solidity，也不能被描述为商用验收通过。

## 权威来源、版本与范围

- 产品唯一权威：`product-framework.md` v0.21（2026-08-04），31,449 bytes，SHA-256
  `5a76a9e0d98691ccc20a1faa37b1607a1d4afd2ca5b17563641cad707ff9aca4`，锁定于
  `manifests/requirements.lock`。
- 编译：Solidity 0.8.36、Cancun、viaIR、optimizer 200、metadata hash none。
- 依赖：见 `manifests/dependencies.lock`；源码/bytecode 候选清单为
  `manifests/source-manifest.json`，每次源码改动后必须重新生成/check 才能作为证据。
- `ref/` 只用于文档呈现参考且被 Git 忽略，不参与设计。

## 核心语义速查

| 项目       | 语义                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| 1 share    | 1,000,000 ERC-1155 units；一级成本 1 USDC                                        |
| 一级 cap   | 累计购买，不因转让恢复；C2C 不占用                                               |
| 早鸟       | 原下注地址 score，不随 token 转移                                                |
| resolve    | creator 在 close 后 24h 内即时终局                                               |
| void       | 当前 holder 1:1 principal refund                                                 |
| timeout    | deadline 起任意 caller；creator 同时失去 void 权限；principal 与 bond bonus 解耦 |
| 空 timeout | 无一级参与者时无 bonus 分母，bond credit creator                                 |
| C2C        | sell-only escrow、partial、cancel、无订单服务器                                  |
| pause      | 只停新增风险；cancel/transfer/claim/refund 不停                                  |
| Full/Clone | Full 推荐≤5k；Clone 风险更高≤500 USDC                                            |

## 代码导航

- `src/core`：Config/Emergency/Guard/Factory/Bond/Fee/Full deployer。
- `src/market`：共享 Vault core 与 Full/Clone runtime。
- `src/marketplace`：固定价 escrow C2C。
- `src/paymaster`：EntryPoint v0.8 sponsor Paymaster。
- `test`：流程、Permit2、Paymaster、invariant。
- `offchain`：SDK、Indexer、workers、sponsor service。
- `examples/react`：create/buy/marketplace/terminal/claims 最小调用和 edge security headers。
- `examples/web-demo`：Arbitrum Sepolia 可运行验证/交互控制台；说明见 `12-web-demo-integration.md`。
- `generated`：ABI、event/error/function selector/bytecode registries 与 Full/Clone storage layout。
- `script`/`deployments`：测试网部署与状态。
- `compose.yaml`/`deploy`/`scripts/stack`：测试网验收栈、备份恢复和故障演练；运行手册见
  `13-compose-runtime-operations.md`。

## 配置和开关

所有配置都有 owner、硬上限、事件和生效点。Governance=Timelock；Emergency 只有 pause。经济默认
影响新市场并在创建/首注冻结；不存在任意 key/value 或任意 calldata。feature flags 对早鸟/Permit2
等可选面做市场级快照；协议级 Paymaster/Permit2 可紧急停用，重新启用必须 Timelock。
Factory 另有不可逆启动门：依赖 code、wiring 及部署清单地址+codehash fingerprint 全部一致后才能
activate/createMarket；这不是可关闭的产品 feature flag。

## SDK 快速开始

```bash
npm ci --ignore-scripts
npm run check:offchain
npm run test:offchain
```

使用 `CpredictClient` 注入 viem public/wallet client 与 account。所有写交易遵循 validate→simulate→
single send→receipt；AA 在签名前按免费→外部 USDC→显式 ETH 选择，绝不静默收费。完整说明见
`07-sdk-integration.md`。

授权必须精确且面向正确 spender：create=`creationFee+bond`→Factory，普通 buy→Vault，Permit2
buy/fill 先→Permit2，allowance fill=`maxGross`→Marketplace，卖单托管另用 ERC-1155
`setApprovalForAll`。示例展示这些步骤，但不是浏览器/钱包 E2E。

## 本地合约验证

```bash
bash scripts/bootstrap-foundry.sh
bash scripts/bootstrap-deps.sh
bash scripts/forge.sh fmt --check
bash scripts/test-all.sh
bash scripts/test-non-ir.sh
bash scripts/coverage-full.sh
bash scripts/forge.sh build src --sizes
npm run generate:artifacts
npm run check:artifacts
npm run test:gate-parsers
npm run scan:secrets
```

不要绕过 `test-all.sh`：Permit2 固定 pragma 0.8.17，协议固定 0.8.36，需要两阶段编译。
`coverage-full.sh` 不排除 suite 且会执行 100/100/95 门禁；当前 20 suites、121/121 tests，
`src/**` line 100%、function 100%、branch 99.13% PASS。原始未过滤 LCOV 另含 scripts、安全 harness
和测试辅助代码，不替代 production `src/**` 分母。深度工具使用
`scripts/security/` 下的 fail-closed runner；完整本地负载必须显式设置
`CPREDICT_LOAD_CONFIRM=I_UNDERSTAND_RESOURCE_USAGE`。
该开关只允许历史同机诊断 runner；正式容量验收必须使用 `scripts/load/sut-up.sh`、`load-run.sh`、
`chain-run.sh` 和 `evidence-collect.sh` 在三个不同主机生成 schema-v4 签名证据。
secret scan 覆盖当前 Git cached 与未忽略的 untracked 交付文件，输出只包含文件名和模式，禁止回显
疑似凭据值；正式 release 仍需对冻结 commit 的完整 Git 历史执行独立凭据扫描。

## Arbitrum Sepolia

填写 Safe/treasury/KMS signer 和受控 deployer secret，先 simulation，再运行 Deploy、独立复核
`EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT`、等待 1h、运行 Finalize/一次性 activate、撤临时角色。
核对清单和 E2E 见 `08-deployment-operations-incident.md`。当前未部署。

Debug/final manifest 到 Demo、SDK、Indexer、Paymaster 和 Compose 的唯一同步入口、Arbiscan 验证、
可恢复 canary、备份恢复及本地故障演练见 `13-compose-runtime-operations.md`。当前主机未安装 Docker，
这些运行栈能力只有静态/构建证明，不能替代 Arbitrum Sepolia 真实部署和 24 小时证据。

## 监控与告警

持续对账 Vault assets/liabilities/supply、terminal pool、Guard、bond/fee credit、listing escrow、
Paymaster reserved/spent/deposit、RPC heads、Indexer lag。Critical signal 先用链上 storage/receipt 复核。

## 常见故障

| 症状                     | 优先检查                                               | 恢复                                         |
| ------------------------ | ------------------------------------------------------ | -------------------------------------------- |
| buy expected revert      | close/cap/min/max/deadline/pause/allowance             | read+重新模拟，不盲重发                      |
| listing fill 失败        | active/remaining/expiry/maxGross/终局                  | 刷新 listing；seller 可 cancel               |
| refund 可用但 bonus 0    | BondEscrow 是否 settle/fund                            | permissionless settle 后 claim bonus         |
| 零参与者 timeout bonus 0 | totalPrincipal/`EmptyTimeoutBondCredited`              | 设计如此；creator 从 BondEscrow claim credit |
| receipt 未知             | tx hash、多 RPC、canonical block                       | 等待/查询，不生成重复经济操作                |
| indexer 差异             | canonical blocks/common ancestor/ABI/动态市场 registry | 原子 rollback/replay，以链上 storage 为准    |
| sponsor 拒绝             | auth/adapter/selector/budget/pause                     | USDC Paymaster 或 ETH fallback               |

## 应急、弃用和回滚

漏洞时最小化 pause flags，绝不停止退出；固定证据，部署新版本而非升级旧 Vault；Factory deprecate，
旧市场继续终局。旧本金不得迁移/sweep。完整 runbook 见第 08 文档。

## 已知问题与剩余风险

creator 单次杀猪、Sybil、内幕 C2C、USDC/Arbitrum/Paymaster 外部信任、Clone delegatecall、流动性不足
无法被本合约消除。测试/外审/实链/法律阻断见 `00-delivery-status.md` 和 `09-commercial-gap-and-release.md`。
当前 bond/cap/fee/早鸟/LaunchGuard 退休和极端 gas 退出也只有可执行评估框架，没有真实参数 PASS；
发布前必须以批准 policy 和 source/deployment-bound 证据重跑。微池 policy 必须指定 gross rake、
protocol fee 或扣早鸟后 creator net 中哪一种资金范围及实际承诺比例；数据 provenance 不得晚于评估
时点，部署 inventory 必须精确绑定 audit commit/address/codehash。评估器不会自行修改配置或发治理交易。

## 证据索引

| 证据                             | 路径                                                                                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 产品符合性                       | `docs/zh/02-requirements-traceability.md`                                                                                                                                                                                                                             |
| 设计/数学/威胁                   | `docs/zh/01-contract-design.md`、`docs/zh/03-mathematical-model.md`、`docs/zh/04-security-threat-model.md`                                                                                                                                                            |
| 事件错误                         | `docs/zh/05-events-errors-observability.md`、`generated/registries/`                                                                                                                                                                                                  |
| 测试质量                         | `docs/zh/06-testing-and-quality.md`                                                                                                                                                                                                                                   |
| 最终本地回归                     | `reports/final-regression-2026-08-08.md`                                                                                                                                                                                                                              |
| 内部安全复核                     | `reports/internal-security-review.md`                                                                                                                                                                                                                                 |
| Slither 分诊                     | `reports/slither-triage.md`、`reports/slither-latest.json`                                                                                                                                                                                                            |
| Token/ERC-1155/USDC/Permit2 集成 | [Token integration report](../../reports/security/token-integration.md)                                                                                                                                                                                               |
| 人工攻击面复核                   | [Manual review](../../reports/security/manual-review.md)                                                                                                                                                                                                              |
| 架构/权限图                      | [Inheritance graph](../../reports/security/diagrams/inheritance-graph.dot)、[functions/auth](../../reports/security/diagrams/functions-auth-printer.json)                                                                                                             |
| coverage                         | `reports/coverage/REPORT.md`、`reports/coverage/full.lcov`                                                                                                                                                                                                            |
| invariant                        | `reports/nightly-invariant.md`                                                                                                                                                                                                                                        |
| static/fuzz/formal               | `reports/security/`、`manifests/security-tools.lock`                                                                                                                                                                                                                  |
| 负载性能                         | `reports/performance/distributed-commercial-load-system-2026-08-12.md`（schema-v4 工具链已实现，formal NOT RUN）；`reports/performance/production-composition-smoke-2026-08-08.md` 与 `reports/performance/load-acceptance-2026-08-08.md` 仅为历史同机/旧 schema 证据 |
| 商业经济参数                     | `reports/economics/commercial-economics-gate.md`（当前 7/7 NOT_VERIFIED）；`reports/economics/micro-pool-unit-economics.md`（确定性敏感性模型，不是实时价格证明）                                                                                                     |
| gas/size                         | `reports/gas-and-size.md`                                                                                                                                                                                                                                             |
| ABI/selector/storage             | `generated/abi/`、`generated/registries/selectors.json`、`generated/storage-layout/`                                                                                                                                                                                  |
| 编译器 known-bugs                | `reports/compiler-known-bugs.md`                                                                                                                                                                                                                                      |
| SDK/调用                         | `docs/zh/07-sdk-integration.md`                                                                                                                                                                                                                                       |
| 部署运维                         | `docs/zh/08-deployment-operations-incident.md`、`docs/zh/13-compose-runtime-operations.md`、`reports/deployment/deployment-operations-tooling-2026-08-21.md`                                                                                                           |
| 商用差距                         | `docs/zh/09-commercial-gap-and-release.md`                                                                                                                                                                                                                            |
| 英文审计包                       | `docs/en/`                                                                                                                                                                                                                                                            |
| 外审/赏金启动包                  | `docs/en/EXTERNAL_AUDIT_RFP.md`、`docs/en/BUG_BOUNTY_DRAFT.md`                                                                                                                                                                                                        |
| 锁定清单                         | `manifests/`（含需求、依赖、工具与 hash-pinned binary evidence）                                                                                                                                                                                                      |
