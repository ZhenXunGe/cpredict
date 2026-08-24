# 测试、性能与质量计划/结果

当前跨域门禁结论只以 [当前候选状态](00-delivery-status.md) 为准；本文件解释测试范围和方法。

## 1. 测试分层

1. Solidity unit：每个 public/external 的正常、权限、范围、状态、时间和重复调用。
2. Flow：create→buy→transfer/list→resolve/void→claim，真实 Permit2，Paymaster reservation。
3. Full/Clone differential：同 seed/sequence 比较 storage、余额、supply、事件和 revert selector。
4. Stateful invariant：随机 buy/transfer/terminal/claim 下的资产与 supply 守恒。
5. Fuzz/formal/mutation：数学、签名、初始化、terminal 和 reentrancy。
6. Off-chain：精确单位、schema/policy、indexer reorg/replay、SDK simulation→receipt、React 去重。
7. 实链 E2E：Arbitrum Sepolia 指定地址/receipt/storage/codehash。
8. 性能：本地受控链、Indexer/API/k6、gas/size；商业容量必须由不同 SUT/load/chain 主机的
   schema-v4 证据关闭，同机 runner 只作诊断。

## 2. 已实现 Foundry 用例目录

当前候选 coverage 命令已执行 20 suites、121/121 tests PASS；production `src/**` coverage 为
line 100%、function 100%、branch 99.13%。用例覆盖 creator void 在 deadline 精确失效、
零参与者 timeout bond 返 credit、canonical Permit2 reference
vector、Paymaster 两段 gas header 防篡改、Factory inactive/code/wiring/fingerprint activation，以及
ERC-1155 batch transfer 的标准 `TransferBatch` 事件、余额与 supply conformance。
coverage 与测试 lane 当前均通过其本地门禁；不得把该 PASS 合并为外审、Arbitrum 或生产 PASS。除原有
`ProtocolFlows`、`Permit2Flows`、
`SponsorshipPaymaster` 和 invariant 外，新增 Controls、FactoryValidation、MarketVaultEdges、
MarketplaceEdges、PaymasterEdges、TokenTransferIntegrity、internal harness 与 FeeVault mutation
regression。覆盖治理/epoch、所有 Factory 参数边界、Full/Clone 初始化与终局、舍入、直接 escrow、
并发 fill、异常 deployer、fee-on-transfer 原子回滚、预算/存款/Stake 管理和 custom error。4 个
invariant 在 CI 档各执行 1,000 runs × depth 128（128,000 calls、0 revert）。

## 3. 前端/后端调用用例

| 调用方              | 用例                                                                              | 预期                                                                                   |
| ------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Wallet/SDK          | allowance buy，cap 部分成交                                                       | simulate 显示 filled；receipt success；余额精确                                        |
| Wallet/SDK          | deadline/cap race                                                                 | expected revert，不无界重试，不重复 toast                                              |
| Wallet/SDK          | approval+listing AA batch                                                         | 同 nonce key 原子执行或整体失败                                                        |
| Buyer               | C2C desired>remaining                                                             | filled=min；低于 minUnits 则回滚                                                       |
| Seller              | fill/cancel 同块竞争                                                              | 只一个先成功；余额/remaining 不重复                                                    |
| 任意 caller         | claimFor(holder)                                                                  | 资金只到 holder                                                                        |
| Creator/任意 caller | `deadline-1/deadline/deadline+1` void                                             | creator 仅 deadline 前成功；deadline 起只有 timeout 成功                               |
| 任意 caller         | 零参与者 timeout→settleBond                                                       | 不创建 bonus pool；bond credit creator；事件可回溯                                     |
| Keeper worker       | timeout/settle/sync 重复或单 EOA nonce 竞争                                       | 每 market 的两笔写顺序提交；已执行时报 expected revert，不影响用户                     |
| Sponsor backend     | 未知 adapter/target/selector/value 或修改 paymaster gas header                    | 拒签/链上验签失败，无 key/签名日志                                                     |
| Indexer             | 多区块 reorg，common ancestor 为无事件区块                                        | 原子回滚 raw/derived/registry/checkpoint 并重放                                        |
| Indexer             | Factory 同交易创建/初始化 Vault                                                   | 动态发现，初始化与后续市场事件不漏扫                                                   |
| Worker              | Indexer 分页/重复 block/各交易失败阶段                                            | 有界分页；每市场每区块一次；区分 simulate/submission/receipt/revert，≥32-byte hex 脱敏 |
| React               | exact approvals + create/buy/list/fill/terminal/four claims 双击或 receipt revert | fee+bond、Permit2、fill 均精确授权；pending 去重、明确状态和不可逆提示                 |
| RPC                 | timeout/分叉                                                                      | 停止自动重发，按 tx hash 查询 canonical receipt                                        |

## 4. 强制门禁

| 类别           | RC 要求                                        |
| -------------- | ---------------------------------------------- |
| coverage       | line/function 100%，branch ≥95%                |
| fuzz           | CI 每属性 ≥10,000                              |
| invariant      | CI 1,000×128；nightly 10,000×256               |
| Echidna/Medusa | ≥1,000,000 calls                               |
| mutation       | ≥90%                                           |
| static         | Slither/Aderyn 无未处置 High/Medium            |
| formal         | Halmos/SMT 覆盖守恒、权限、terminal            |
| snapshots      | ABI/event/error/gas/size/storage/codehash      |
| off-chain      | TS strict、unit、indexer reorg、Playwright、k6 |

未运行项必须标 `not run`，不能用普通 unit 代替。

ABI、event、error、function selector、bytecode、storage-layout 和 source manifest 仍须在最终源码冻结后
重新生成并执行 drift check；任何早期 selector 数或 source SHA 都只属于其生成时的候选。

## 5. 性能验收

链上核心 O(1)，唯一有界 outcome 循环 ≤32。Launch Guard 是试运营期间的跨市场 buy 热点；
claim 不写 Guard，worker 后续保守 sync；retire 后无全局写。Marketplace 使用 seller nonce，
不保存链上排序数组。

目标：Full runtime <23KB；Full deploy <8M gas（硬<15M）；Clone deploy+init <600k；allowance
buy <300k；Permit2 buy <370k；listing <230k；fill <350k/Permit2 <430k；claim/refund <250k；
Paymaster validation+postOp <150k。链下目标 10k read connections、500 RPS steady、2k RPS burst、
100 markets、100k listings、API p95<300ms/p99<750ms、5xx<0.5%、event-to-client p95<2s。

当前独立 production-context gas/size runner 为 10/10 PASS：Full create、Clone deploy+init、
allowance/Permit2 buy、listing、两种 fill、claim/refund 和 Paymaster validation+postOp 均低于既定
阈值；Full runtime 22,975 B，FullMarketDeployer 23,763 B，仍需关注体积余量。精确值及本地/实链
边界见 `reports/gas-and-size.md`。

当前正式商业容量门禁为 schema-v4 三机证据，基础设施和 fixture/validator 已静态验证，但正式运行
**NOT RUN**。SUT 主机负责 API/Indexer/PostgreSQL 和完整 telemetry，独立 load 主机执行 500 RPS×5
分钟、2,000 RPS×1 分钟与 10,000 simultaneous WS×60 秒，独立 chain 主机执行 50 tx/s×10 分钟、
事件到客户端延迟与多块 reorg drill。三者必须 host identity 和 machine fingerprint 均不同、时钟偏移
≤100ms、窗口重叠≥300 秒，并由 source/release/runtime-image binding 和 Ed25519 签名证据闭合。
详见[分布式商业负载系统实现记录](../../reports/performance/distributed-commercial-load-system-2026-08-12.md)。

历史同机 schema-v3 production-composition API 运行仍是 **FAIL**：269,682 个 2xx、319 drops、p95
332.99ms、p99 751.55ms。2026-08-12 两次诊断校准的服务指标均为 0 drops/0 errors 且延迟达标，
但当时 runner 因阶段计数边界以 99 退出；最终 profile 修复后未第三次运行，不能标 PASS。focused
20-session WS smoke 也只证明低强度链路。这些证据都不能升级为 schema-v4 商业 PASS。历史详情见
`reports/performance/production-composition-smoke-2026-08-08.md` 和
`reports/performance/commercial-load-remediation-2026-08-12.md`。

## 6. 当前覆盖率证据

`bash scripts/coverage-full.sh` 不排除 suite/path，并机器校验 production `src/**` 100% line、100%
function、≥95% branch。当前执行 20 suites、121/121 tests PASS；`src/**` 为 line 100%、function
100%、branch 99.13%，门禁 PASS。原始未过滤 LCOV 为 line 79.61%、function 81.07%、branch 75.39%，
因为它还包含部署脚本、安全 harness 和测试辅助代码。runner 不使用 LCOV remove、path/suite exclusion
或空测试伪造生产覆盖率；完整命令、原始 LCOV、forced production build 与哈希见
`reports/coverage/REPORT.md`。

## 7. 深度安全工具结果

- Slither：保留的旧快照分析 66 contracts/102 detectors，25 findings=2 High 已分诊、0 Medium、21 Low、
  2 Info；当前 evidence verifier 因 `foundry.toml` 输入漂移拒绝该证据，不能写成当前候选 PASS。
  High 为固定 Permit2 调用面的 reentrancy detector，保留给外审复核，详见 `reports/slither-triage.md`；
- nightly invariant：4 属性各 10,000 runs×depth 256，即 2,560,000 calls/属性，0 revert；
- Medusa：旧快照 1,024,046 calls、27 passed/0 failed；当前 evidence verifier 因输入漂移拒绝；
- Echidna：旧 arm64 快照为 1,000,053 calls、4/4 PASS；当前 evidence verifier 因输入漂移拒绝。
  x86_64 诊断 1,032 calls、4/4 PASS，但在保存
  coverage 时挂起，未完成百万调用生命周期；
- Aderyn：旧快照官方固定版本正常退出；当前 evidence verifier 因输入漂移拒绝；
- Halmos：旧快照 Z3 对 rake、remaining pool、C2C 三个守恒性质 3/3 通过；当前 evidence verifier
  因输入漂移拒绝，范围也不是全协议；
- Solidity SMTChecker：旧快照固定 solc 0.8.36 + Z3 4.12.6，CHC/BMC 各证明 10 assertions；
  当前 evidence verifier 因验证脚本输入漂移拒绝，范围也不是全协议；
- mutation：旧 FeeVault bounded score 133/135（98.52%）达到数值阈值，但 raw rc 143 令正式结果
  FAIL；旧全协议 campaign 为 0/12。runner 已改为 exact source target、进程组 TERM/KILL、原子证据和
  ordered 12/12 summary binding，30/30 focused tests PASS；fresh FeeVault/full campaign 未运行，不能
  改写旧结果。

## 8. 测试报告规则

报告必须包含 commit/source manifest、compiler/profile、seed/runs/depth、测试名称、耗时、失败/
skip、机器规格和日志路径。Arbitrum Sepolia 只做低速真实烟测，不把提交吞吐量描述为链上确认 TPS。

## 9. 链下聚焦结果

当前全量普通链下 lane 覆盖 SDK、AA/Permit2、Paymaster service、Indexer memory/API、terminal worker
与 React SSR：90 tests pass；5 个 PostgreSQL 用例在该命令中 conditional skip。独立 disposable
PostgreSQL 17.10 lane 实际执行 Paymaster 2/2、Indexer 3/3、readiness 4/4，共 9/9、0 skip。
Playwright 浏览器、真实钱包、Bundler/KMS、Arbitrum Sepolia 和生产 API 仍未验证。

## 10. 商业经济参数验收

商业经济评估器使用整数 `BigInt`、明确舍入和 fail-closed 证据要求，覆盖 bond 威慑、微池可承诺资金是否
覆盖 claim/Paymaster、Full/Clone cap、早鸟 Sybil、C2C fee 流动性、LaunchGuard 退休资格及极端 gas
退出七项。输入/policy schema 拒绝未知字段；模型与负面证据用例通过只证明评估器能拒绝缺失、歧义、
过期或未绑定的数据；当前模板没有已批准
阈值、真实 Arbitrum receipt 或独立业务 cohort，因此生成报告必须保持 **7/7 NOT_VERIFIED**。

微池门禁不会默认把 gross rake 全部用于赞助：approved policy 必须明确选取 `GROSS_RAKE`、
`PROTOCOL_FEE` 或 `CREATOR_NET_AFTER_EARLY_BIRD`，再乘以 `committedFundingShareBps`。所有证据
provenance 的 collection end 必须不晚于 assessment time；deployment binding 必须精确包含完整
component inventory、audit commit、地址和 runtime codehash，receipt 才能进入成本计算。

证据见[商业经济参数验收](../../reports/economics/commercial-economics-gate.md)和
[微池单位经济模型](../../reports/economics/micro-pool-unit-economics.md)。前者是发布前经验参数门禁；
后者只是确定性敏感性模型。二者均不会自动修改 V1 Solidity、配置、cap、fee 或调用不可逆的
`LaunchExposureGuard.retireForever`。
