# 两轮外部审计、复审与 Bug Bounty 落地方案

状态日期：2026-08-08。本文件把外部安全工作细化到可采购、可验收；当前没有联系、预订或支付
任何供应商，也没有上线赏金。它们涉及预算、合同、公开范围和外部承诺，须由甲方单独授权。

## 1. 当前完成边界

- 已有英文送审范围、代码地图、信任假设、经济规范、审计问题清单。
- `docs/en/EXTERNAL_AUDIT_RFP.md` 给出两轮独立审计的输入、工作项、交付物、独立性和退出条件。
- `docs/en/BUG_BOUNTY_DRAFT.md` 给出资产/影响范围、排除项、研究规则、建议奖金、响应 SLA、
  safe harbor 和披露规则。
- 当前工作树未 commit/tag，Base Sepolia/主网均未部署，故不能生成真实审计 hash、地址范围或
  发布一个可兑现的 bounty。

“RFP 已完成”不等于“已外审”；“Bounty 草案已完成”不等于“赏金已上线”。两项继续保持
Release Blocker。

## 2. 不可颠倒的执行顺序

1. 关闭内部覆盖、静态分析、fuzz/invariant/formal/mutation 的已知缺口。
2. 甲方冻结功能、参数、偏离项与已接受风险；授权 commit/tag，生成最终 source manifest。
3. 至少向三支合格团队索取同口径方案，确认具名审计人员、工期、人周、修复复审和利益冲突。
4. Round 1 做完整设计/代码/经济/集成审计；代码只接受审计修复。
5. 冻结修复 commit，由 Round 1 原团队逐项复审。
6. Round 2 交给另一法律主体和不同主审；可采用资深团队审计或带资深分诊的审计竞赛。
7. Round 2 修复复审；任何后续代码变化都必须做差分复核。
8. 完成 Base Sepolia E2E、24 小时 canary、角色/应急/监控演练和法务评估。
9. 资金托管、24×7 分诊和应急联系人就绪后，才能发布 Bug Bounty。
10. 只有全部发布阻断项关闭，才进入限额主网。

## 3. 甲方必须决定并签字的项目

| 决策                 | 建议                                  | 未决定的影响             |
| -------------------- | ------------------------------------- | ------------------------ |
| Round 1 预算/供应商  | 资深 EVM 团队的完整人工审计           | 无法发起采购             |
| Round 2 形式         | 不同机构；优先不同方法/更广研究者覆盖 | 独立性不足               |
| 报告公开策略         | 修复复审后公开，运维秘密脱敏          | 无法约定披露条款         |
| Critical 奖金上限    | 草案建议 500,000 USDC                 | 无法承诺或托管奖金       |
| 奖金平台与付款主体   | 有托管/分诊/申诉能力的平台和合法主体  | 无法付款和履约           |
| 24×7 安全负责人/备援 | 至少两人 + Safe signer 升级路径       | 无法满足 Critical SLA    |
| Safe Harbor          | 经法务批准后再启用救援权限            | 不得默认授权白帽移动资金 |
| commit/tag 权限      | 审计前授权冻结，禁止审后静默改码      | 无法绑定审计结论与字节码 |

## 4. 供应商初筛，不等于推荐或已签约

应以“具名人员 + 近期相似公开报告 + 人周 + 方法 + 修复复审”评分，不能只看品牌。可从以下
官方入口取得同口径报价：

- Trail of Bits：https://trailofbits.com/services/blockchain/
- OpenZeppelin：https://www.openzeppelin.com/security-audits
- Cantina/Spearbit：https://cantina.xyz/solutions/spearbit/smart-contract-security-reviews
- Sherlock：https://docs.sherlock.xyz/audits/protocols

两轮不得由同一法律主体或同一主审人员完成；自动扫描不能算一轮独立审计。

## 5. Go/No-Go 证据

最终证据包至少包含：两份报告、两份修复复审附录、每个 finding 的稳定 ID/状态/回归测试、
审计 commit/tag、最终 source/bytecode manifest、审后差分清单、书面 accepted risks、赏金托管/
支付能力证明、分诊轮值表、应急演练记录和公开地址范围。

任一 Critical/High 未关闭、Medium 无书面风险接受、审计 hash 与部署字节码不一致、赏金无法兑现、
或 Critical 无人 24×7 响应，均为 No-Go。
