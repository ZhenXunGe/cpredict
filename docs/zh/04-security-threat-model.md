# 安全威胁模型与内部审计报告

## 1. 资产、信任与攻击者

首要资产是各 Vault USDC 本金；其次是托管 listing 份额、creator bond、FeeVault credit 和
EntryPoint deposit。信任对象：Base L2/sequencer、canonical USDC proxy/admin、Permit2、
EntryPoint、Safe 成员、Timelock、creator 结果诚信、KMS/赞助后端、RPC/indexer。任意用户、
creator、keeper、ERC-1155 receiver、智能账户、Bundler、RPC 和 metadata URI 均按潜在恶意处理。

## 2. 安全架构

- 不可升级 Vault，无 selfdestruct/任意 call/delegatecall/admin sweep。
- 每市场资金隔离；C2C 不沉淀 USDC；bond/fee 分开。
- checks-effects-interactions + ReentrancyGuard；receiver callback 明确白名单状态。
- pull claims 固定 beneficiary；`claimFor` 不允许 caller 改收款人。
- 受限 pause 只停新增风险，自动过期且无法由 Emergency Safe 续期。
- Permit2 EIP-712 witness 和 Paymaster typed data 均域绑定。
- deployment salt 含 chain/factory/creator/nonce/rules/close/cap/mode；原子初始化。
- Factory 默认 inactive；一次性 activation 校验依赖 runtime code、不可变/一次性 wiring 与地址+codehash
  fingerprint，禁止在半接线状态接收创建费/bond。

## 3. 攻击矩阵

| 威胁                         | 控制                                                                                                          | 剩余风险/验证                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Clone implementation 初始化  | implementation constructor 锁死；Factory 原子 init                                                            | storage layout 专项外审未完成                                                                          |
| CREATE2 抢跑/碰撞            | Factory-only deployer、域分离 salt、整 tx 回滚                                                                | 地址预测信息公开但不可劫持                                                                             |
| Factory 半接线/错版本依赖    | inactive 默认、code presence、wiring、部署清单 fingerprint、不可逆 activation                                 | 清单来源/审核错误与部署后依赖自身治理风险需外审/实链核验                                               |
| ERC-1155 reentrancy/直接托管 | ReentrancyGuard、expected receipt、拒绝 batch                                                                 | 恶意 receiver 测试需扩充                                                                               |
| 终局 Marketplace 托管        | Vault 禁止直接为协议 Marketplace claim/refund；permissionless return 后由 seller 领取                         | 第三方托管需自行分配，协议无法识别任意托管地址                                                         |
| 恶意/非标准 USDC             | 6 decimals；Factory/buy/Permit2/fee 入账做余额差/偿付校验；对外支付用 SafeERC20                               | 不逐笔校验 outbound recipient delta；依赖 canonical USDC 无 fee/rebase，pause/blocklist/升级仍外部信任 |
| Permit2 replay/cross-domain  | 官方实现、nonce、canonical witness suffix、独立 reference vector、完整业务域                                  | 正式依赖 codehash 需实链核验                                                                           |
| fill/cancel race             | 顺序执行、active/remaining、min/max/deadline                                                                  | MEV 只能决定先后，不能超支                                                                             |
| rounding/split claim         | 动态 remaining-pool 守恒并最终清池                                                                            | 多个后续 claimant 可取得舍入原子单位；顺序/拆分改变个体分配，已披露                                    |
| fee/bond double claim        | terminal/settled 标志，credit 清零再转账                                                                      | 需 mutation/formal 强化                                                                                |
| Guard under-report           | buy reserve、permissionless sync、保守不减                                                                    | 活跃时全局热点；可不可逆退休                                                                           |
| 无限 emergency pause         | ≤7d、epoch once、Timelock reset                                                                               | Timelock 可创建新 epoch，需社会治理监督                                                                |
| Paymaster deposit drain      | 签名含两段 paymaster gas header、完整 UserOp 经济字段；on-chain spent+reserved 预算、服务白名单、有限 deposit | Bundler/stateful Paymaster、真实 KMS/TLS/预算库未实测                                                  |
| Indexer reorg/丢块           | 每区块 hash/parent、common-ancestor、raw+derived 原子回滚/重放、动态市场发现                                  | 本地真实 PostgreSQL 9/9 PASS；DB HA、备份和多 RPC 未运行验证                                           |
| metadata XSS/注入            | 合约只存 URI/哈希；前端正常 JSX                                                                               | 完整产品必须 allowlist/sanitize URL/内容                                                               |

## 4. 经济与产品攻击

无法由合约消除：creator 单次杀猪、Sybil 绕 per-address cap、封盘后内幕 C2C、creator 自买/
关联账户、C2C 流动性枯竭、Base/USDC/外部 Paymaster 失效。合约保证的是资产路径与公开语义，
不是结果真实性。缓解依赖 cap、显著知情文案、creator 信用、地址关联检测、头部盘二次确认和运营限制。

Flash loan 对一级购买没有同 tx 赎回路径，不能无成本操纵后退出；但有资本的攻击者仍可改变实时
隐含赔率，且 creator 可恶意 resolve，属于经济/信任风险而不是 solvency 漏洞。

## 5. 供应链

Trail of Bits Solidity skills 在固定 commit 审查后由 Codex 官方 installer 安装；锁定信息和
SHA-256 在 `manifests/solidity-skills.lock`。Solidity/OZ/Foundry/Permit2/AA commit 在
`manifests/dependencies.lock`；npm 使用 exact versions 与 lockfile，安装禁用 lifecycle scripts。
`manifests/source-manifest.json` 应记录源码、设置和 bytecode SHA-256；本轮改动后必须重新生成/check，
旧 manifest 不构成当前源码的确定性证据。

ERC-1155 conformance、canonical USDC 入账/对外支付边界、Permit2 witness/approval 与残余风险的专项
证据见 [Token integration report](../../reports/security/token-integration.md)。该报告不改变 USDC proxy、
pause/blocklist/rebase 语义和真实 Base codehash 仍属于外部/实链验证边界的结论。

完整人工攻击面结论见 [Manual attack-surface review](../../reports/security/manual-review.md)；机器可读
辅助材料包括 [inheritance graph](../../reports/security/diagrams/inheritance-graph.dot)、
[inheritance printer](../../reports/security/diagrams/inheritance-printer.json) 和
[functions/auth printer](../../reports/security/diagrams/functions-auth-printer.json)。图包含依赖合约，
审计范围仍须过滤到 `src/**`。

## 6. 安全成熟度（内部自评，0–4）

| 类别          | 分数 | 说明                                                                                                          |
| ------------- | ---: | ------------------------------------------------------------------------------------------------------------- |
| 权限与治理    |    3 | 有界角色/Timelock 脚本；实链角色未核验                                                                        |
| 资产与会计    |    3 | 隔离、守恒、invariant；完整 formal/mutation 未做                                                              |
| 外部调用/重入 |    3 | 最小调用面和 receiver guard；攻击套件待扩                                                                     |
| 输入/状态机   |    3 | 当前 production `src/**` coverage 为 line 100%、function 100%、branch 99.13% PASS；仍需外审和实链状态边界验证 |
| 数学/精度     |    3 | mulDiv/SafeCast/remaining pool；formal 未完成                                                                 |
| 签名/重放     |    3 | Permit2 实现级用例、Paymaster 域；AA 实链未做                                                                 |
| 供应链/构建   |    3 | 精确 pin/manifest；完整 SBOM/SCA 签名待做                                                                     |
| 测试/分析     |    2 | unit/coverage/nightly/Medusa/Halmos 已执行；部分强门禁仍失败或未闭合                                          |
| 运维/响应     |    2 | scripts/runbooks/alerts；演练和真实监控未做                                                                   |

## 7. 当前内部发现

- 已修复（High）：终局后任意 caller 原可为协议 Marketplace 触发 claim/refund，烧毁托管份额并把
  USDC 困在缺少 seller 分账的 Marketplace。现强制先 permissionless return 给 seller，winner/void
  两条路径均有回归用例；详见 `reports/internal-security-review.md`。
- 已修复（Medium）：timeout bond bonus 注入会重新增加用户负债；现 `guardExposure` 纳入 bonus，
  funding 原子同步 Guard，并使 exposure 超 cap 时以自定义错误失败关闭而非算术 Panic。
- 已修复：Paymaster 日预算最初未把 settled spend 纳入后续 reservation 校验；现按
  `spent+reserved` 封顶并有回归用例。
- 已修复：creator 原可在 timeout deadline 后继续 void；现 resolve/creator void 均为
  `[closeAt, deadline)` / `<deadline`，deadline 起只允许 permissionless timeout，并有 exact-boundary 回归。
- 已修复：零参与者 timeout 原会把 bond 注入无分母、永远不可领取的 bonus pool；现 credit creator，
  以 `EmptyTimeoutBondCredited` 明确观测。
- 已硬化：Permit2 使用 canonical witness suffix 与独立 reference vector；Paymaster digest 新增
  `paymasterVerificationGasLimit` / `paymasterPostOpGasLimit`，修改任一 packed header 都令签名失效。
- 已硬化：Factory 市场创建需要一次性 activation，并在激活时校验完整依赖 code/wiring/codehash
  fingerprint；部署清单必须从独立 reviewed output 提供期望值。
- 已实现并有本地验证：Indexer common-ancestor rollback、Factory 动态市场发现、只读 API、worker、
  SDK 与 React 调用面；独立 disposable PostgreSQL 17.10 lane 为 9/9、0 skip。该证据不能升级为生产
  TLS/HA/备份恢复或 Base 运行证据。
- 已接受：Full deployment 因 Factory EIP-170 体积拆为 Factory-only deployer；初始化仍在
  createMarket 同一交易原子完成，但不再是带参数 constructor，须在 ADR/审计范围明确。
- 待验证：Forge 对协议时钟的 block.timestamp lint 是设计必需，不是自动关闭；外审需审查每个边界。
- Fresh Slither 已完成：66 contracts、102 detectors、25 findings；2 High 均按固定 Permit2+
  `nonReentrant` 调用图分诊、0 Medium、21 Low、2 Info，runner 与 14 个 parser tests PASS。该结果是
  内部静态证据，不是外审结论。
- 发布阻断：Slither、Aderyn、Medusa 1,024,046 calls/27 properties、Echidna arm64
  1,000,053 calls/4 properties、Halmos 3/3 与 SMTChecker CHC/BMC 限定证明通过，coverage 和
  production gas/size 也通过；但 Echidna x86_64 lifecycle、fresh whole-protocol mutation、
  正式商业负载、两轮外审和 Base runtime 尚未闭合。
