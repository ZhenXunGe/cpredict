# Slither 0.11.6 分诊报告

状态：2026-08-08 本地静态检查完成；最终机器可读结果见 `reports/slither-latest.json`。

命令（项目本地工具，未修改全局 Python 或 Foundry）：

```bash
bash scripts/security/run-slither.sh
```

runner 使用全新的临时 JSON，成功生成后原子替换旧报告，避免 Slither 拒绝覆盖时误校验陈旧证据。
结果：分析 66 个合约、102 个 detector，报告 25 项；2 High、0 Medium、21 Low、2
Informational。Slither 因存在 finding 返回 255，这是预期行为；机器门禁随后校验精确 High/Medium
清单并正常退出 0。

## High：Permit2 exact-balance reentrancy（2 项）

位置：

- `MarketVaultCoreV1._pullWithPermit2`；
- `FixedPriceMarketplaceV1._pullWithPermit2`。

处置：`accepted false positive, externally reviewable`。

理由：两者均为 `internal`，唯一生产调用者分别是带 OpenZeppelin `nonReentrant` 的
`buyWithPermit2` 和 `fillListingWithPermit2`。外调地址是构造/初始化时固定的官方 Permit2；支付资产
固定为初始化时校验 6 decimals 的 payment token。Permit2/USDC 外调、前后余额差检查、后续状态更新
处于同一交易；回调所有可写资金入口会被 guard 拒绝，任一步失败会整体回滚。余额差检查本身用于拒绝
fee-on-transfer/非精确转账，不能删除。

残余风险：Base USDC proxy、官方 Permit2 或链执行语义若被破坏，属于外部信任失效；主网上线前仍需
独立审计复核调用图和恶意 token/receiver harness。

## 已关闭的 Medium：memory struct 初始化

旧位置：`SponsorshipPaymasterV1._validateAuthorization.authorization` 与
`SponsorshipPaymasterV1._sponsorshipHash.message`。

处置：`resolved`。

理由：Solidity 原本会把 memory struct 零初始化，旧代码也逐字段覆盖后才编码；为消除审计歧义，当前
源码改为显式完整 struct 初始化。Paymaster non-IR/viaIR 聚焦回归及独立 canonical EIP-712 reference
vector 均通过，fresh Slither 报告不再包含该 Medium。

## Low / Informational

| detector | 处置 |
|---|---|
| `missing-zero-check permit2_` | 有意允许零地址；standard allowance 永远可用，Permit2 feature 在地址为零时 fail-closed |
| `reentrancy-benign _completeBuy` | `reserve` 仅进入固定 Guard；外层 buy 有 `nonReentrant`，Guard 不回调且失败整体回滚 |
| `reentrancy-benign createListing` | callback 由 `_expectedReceipt` 精确绑定 vault/from/id/value/listingId，入口有 `nonReentrant` |
| `reentrancy-benign createMarket` | Factory 入口有 `nonReentrant`；Full deployer、Clone implementation、initializer 均固定且原子执行 |
| `reentrancy-events` | 仅固定 FeeVault/EntryPoint 外调后的观测事件；失败会回滚，无后置授权或资产会计写 |
| `timestamp` | 市场封盘、结算窗口、deadline、listing expiry、pause expiry 的规范时钟；接受 L2 timestamp/sequencer 信任边界 |
| `cyclomatic-complexity` | 仅有限参数校验与 O(1) fill 校验；用边界测试覆盖，未以拆分隐藏规则 |
| `missing-inheritance` | concrete 合约通过结构化接口被消费者调用；不影响 ABI/访问控制，列入审计清理候选 |

结论：本次 fresh Slither 无未处置 High/Medium，但“已分诊”不等于“外部审计通过”。当前
Aderyn、Medusa、Halmos 和 SMTChecker 各自在限定范围内 PASS，coverage 与 production gas/size
也已通过本地门禁；Echidna arm64 已执行 1,000,053 calls 并通过，x86_64 仅完成 1,032-call
诊断且 coverage 保存生命周期未闭合。fresh whole-protocol mutation 和两轮独立审计未完成。
不得据此发布主网声明；当前总状态以
`docs/zh/00-delivery-status.md` 和 `reports/security/security-gates.md` 为准。
