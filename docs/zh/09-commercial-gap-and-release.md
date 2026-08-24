# 商用成熟度差距、决策点与发布路线

当前动态门禁数字只以 [当前候选状态](00-delivery-status.md) 为准。本文件描述差距与发布决策，
不把任何单项本地 PASS 升级为商用发布结论。

## 1. 与成熟商用协议的核心差距

| 能力                 | 当前仓库                                                                                                                                                                                             | 商用要求                                                                                                                     |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 独立审计             | RFP/范围/退出条件已备好，未聘请                                                                                                                                                                      | 两家独立团队、两次修复复审、公开范围/tag                                                                                     |
| Bug bounty           | 完整政策草案，未出资/发布                                                                                                                                                                            | funded scope、safe harbor、响应/支付 SLA                                                                                     |
| Formal/fuzz/mutation | 旧快照 Halmos 3/3、SMTChecker 限定范围及 Echidna arm64 1,000,053 calls 曾通过，但当前 verifier 因输入漂移拒绝；x86_64 lifecycle 未闭合；旧 FeeVault 133/135 但 lifecycle FAIL；全协议 0/12、无 score；runner 修复后 fresh campaign 未运行 | 核心数学/权限/状态证明、当前冻结快照的 Echidna 完整跨架构证据和全协议 ≥90% mutation                                                         |
| 覆盖率               | 当前 20 suites/121 tests，`src` line 100%、function 100%、branch 99.13% PASS                                                                                                                         | 持续绑定冻结 source manifest；不得外推为外审或实链证明                                                                       |
| 商业负载             | schema-v4 三机执行/telemetry/签名门禁已静态实现；正式三机运行 NOT RUN；保留的同机 schema-v3 API 旧证据 FAIL                                                                                          | 独立 SUT/load/chain 主机、生产等价容量、0 drops、10k simultaneous WS、30k 链上分类、reorg/lag/event latency 与签名证据全通过 |
| 实链历史             | 无                                                                                                                                                                                                   | 长时间 testnet canary、故障注入和监控基线                                                                                    |
| Safe/KMS             | 只有脚本/接口                                                                                                                                                                                        | 实际多签、硬件密钥、KMS/HSM、轮换演练                                                                                        |
| Indexer/API          | common-ancestor/dynamic discovery/read API 已实现；本地真实 PostgreSQL 9/9 PASS                                                                                                                      | HA PostgreSQL、多 RPC、备份恢复、reorg 演练                                                                                  |
| Paymaster            | 合约完整 gas binding、可运行安全服务与 SDK fallback                                                                                                                                                  | 真实 KMS/HSM、transactional budget、Bundler、provider fallback、deposit/SLA/地区演练                                         |
| 前端信任层           | 最小 React 全调用面，不是产品 UI                                                                                                                                                                     | 风险知情、信誉、标注、审核/申诉、钱包、可访问性/浏览器 E2E                                                                   |
| 经济验证             | 确定性微池模型和 fail-closed 七项评估器已实现；当前 7/7 NOT_VERIFIED                                                                                                                                 | 已批准阈值、source/deployment-bound Arbitrum receipts、独立业务 cohort、价格证据和风险委员会签字                                 |
| 法律/ToS             | 未评估                                                                                                                                                                                               | 赌博/证券/消费者/隐私/制裁/直播平台评审                                                                                      |
| 运维                 | runbook/alerts 模板                                                                                                                                                                                  | 24×7 owner、paging、SLO、演练与审计日志                                                                                      |

因此“代码存在”不能等同“商用安全”。当前最准确标签是 pre-audit candidate。

负载实现与未运行边界见[分布式商业负载系统记录](../../reports/performance/distributed-commercial-load-system-2026-08-12.md)；
七项经济门禁、缺失输入和精确舍入见[商业经济参数验收](../../reports/economics/commercial-economics-gate.md)。
这些新增工具没有修改 V1 Solidity：经验结论只能形成配置/开关/Timelock 提案；LaunchGuard 的永久退休
还必须经过独立治理授权，评估器本身不会发交易。

## 2. 必须冻结的产品决策

1. Full-only 首发还是 Full+Clone 同 tag；推荐主网首发 Full-only，Clone 在独立外审后开启。
2. creator 单次杀猪风险的最大 Full cap、用户 cap、曝光分级和强制风险文案。
3. C2C fill 是否纳入 emergency pause；当前实现为可暂停，需甲方接受偏离。
4. 早鸟比例、creator rake、协议分成、创建费、C2C fee 的试运营默认值。
5. 主网链、USDC proxy/admin 风险、sequencer downtime 处理和 finality 深度。
6. Paymaster 免费预算、外部 USDC provider、ETH fallback、地区限制和反滥用隐私政策。
7. metadata/rules/source 的存储、内容安全、永久性和修改审计策略。
8. 零参与者 timeout 时 bond 返 creator credit 的边界政策；若业务坚持罚没，必须指定可验证的替代
   beneficiary，而不能把资金注入无分母池。
9. 批准商业经济 policy：分别冻结 bond 覆盖倍数、微池资金范围（gross rake/protocol fee/扣早鸟后
   creator net）、承诺资金比例与成本覆盖率、Full/Clone cap 利用率与
   损失上限、早鸟 Sybil 阈值、C2C 流动性损失、LaunchGuard 退休观察窗和极端 gas 退出下限；批准
   reference、审计 commit、完整部署地址/codehash inventory 和截止不晚于 assessment time 的数据
   provenance 必须一起留档。

## 3. 建议发布阶段

- M0 设计冻结：甲方批准偏离、单位、状态机、权限、风险文案。
- M1 内部 alpha：关闭 Clone/Permit2/Paymaster 等可选 flags，极低 cap，完成全部质量门禁。
- M2 Arbitrum Sepolia：完整 E2E、24h canary、Indexer/monitoring/runbook、负载与故障注入。
- M3 外审 RC1：冻结 commit/tag/source manifest，双外审和修复复审。
- M4 限额主网：Full-only、总 exposure guard、低 cap、Bug bounty、7d Timelock、24×7 on-call。
- M5 扩容：基于无事故时间、对账、成交和运营数据逐级提高；每次提高走 Timelock 与发布清单。
- M6 可选功能：Clone、Permit2、Paymaster、API settlement 分别独立风险接受和 canary。

## 4. Go/No-Go

No-Go：任一未处置 High/Medium、coverage/formal/mutation 未达、schema-v4 三机商业负载未 PASS、
商业经济七项任一不是 PASS、source/bytecode 不可复现、角色漂移、
Factory activation fingerprint 未独立复核、USDC/Permit2/EntryPoint codehash 未核对、PostgreSQL reorg
未实跑、Paymaster KMS/Bundler/gas-header 未演练、timeout canary 未完成、真实退出路径未演练、值班/
法律未签字。

Go 需要产品、安全、工程、运维、法务五方书面批准；批准内容包含 cap/fees/flags/addresses/tag/
审计报告/accepted risks/回滚 owner，而不是一句“测试通过”。
