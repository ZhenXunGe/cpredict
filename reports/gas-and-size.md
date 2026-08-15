# Gas 与代码体积门禁

核查日期：2026-08-08。编译：Solidity 0.8.36、Cancun、optimizer 200、viaIR、无 metadata
hash。当前 production-context runner **10/10 PASS**。所有数值是本地交易等价测量，不是 Base
Sepolia receipt，也不包含主网价格、L1 data fee、Bundler markup 或外部 Paymaster 计费。

## 当前 operation gas

| 操作 | 当前测量 | 门禁 | 结果 |
|---|---:|---:|---|
| Full create transaction | 5,433,892 | <8,000,000 | PASS |
| Clone deploy + initialize | 542,400 | <600,000 | PASS |
| allowance buy | 278,005 | <300,000 | PASS |
| Permit2 buy | 329,233 | <370,000 | PASS |
| listing create | 224,354 | <230,000 | PASS |
| allowance fill（双 fee 路径） | 225,074 | <350,000 | PASS |
| Permit2 fill（platform + creator fee） | 293,555 | <430,000 | PASS |
| winner claim | 86,856 | <250,000 | PASS |
| refund | 80,987 | <250,000 | PASS |
| Paymaster validation + postOp | 148,072 | <150,000 | PASS |

EOA 路径采用 cold execution、21,000 transaction base gas 和精确 calldata 零/非零字节成本；
依赖通过 `vm.cool` 冷却。Paymaster 数字是 validation 与 postOp 的组合门禁，不把两个独立 max
错误相加。coverage 使用未优化字节码时仍执行行为路径，但只关闭 optimizer-sensitive 数值断言；
本表来自独立 production-viaIR runner。

## 当前代码体积

| 合约 | runtime bytes | 门禁 | 结果 |
|---|---:|---:|---|
| FullMarketVaultV1 | 22,975 | <23 KiB | PASS |
| FullMarketDeployerV1 | 23,763 | EIP-170 <24,576 | PASS，余量 813 B |
| MarketFactoryV1 | 15,838 | EIP-170 <24,576 | PASS |
| SponsorshipPaymasterV1 | 7,381 | EIP-170 <24,576 | PASS |

Full/Clone 行为差分由独立测试门禁承担；Clone 的低部署 gas 不消除 delegatecall、initializer、
storage layout 和 implementation 锁定风险。

## 结论与边界

当前本地 production gas/size 门禁通过。旧报告中的 allowance buy 348,144、Permit2 buy
391,284、Paymaster 合计 193,796 或 gas FAIL 属于历史候选，已被本报告取代。该 PASS 不能外推为
Base 运行时、微池经济或商业可发布结论；`reports/economics/micro-pool-unit-economics.md` 仍将
`PF-CHAIN-005` 保持 partial，直到目标 Base 环境 receipt、费用策略和批量赞助方案通过验收。
