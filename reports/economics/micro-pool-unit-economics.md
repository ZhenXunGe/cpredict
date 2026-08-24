# PF-CHAIN-005 微池单位经济模型报告

## 结论与证明边界

本报告提供可复现的整数定点模型和试运营 go/no-go 公式，但**不构成 Arbitrum 当前成本或价格验证**。
正式 gas 输入采用 executable gate 的严格阈值减一，即可通过该“< threshold”门禁的最大整数；
`resolve`、`void finalize`、bond settlement 和 timeout bonus claim 尚无独立正式门禁，报告中的
249,999 gas 只是待验证的试运营验收上限。
因此 PF-CHAIN-005 仍应保持 partial，直到 Arbitrum 目标环境 receipt、最终价格策略和批量赞助策略验收完成。

单个 `claim/refund` 合约路径是 O(1)，但 N 个 claimant 的总 EVM 执行成本是 O(N)。智能账户可以在
一个 UserOperation 中批量提交 1–32 个 calldata，减少提交与签名交互；它不会把 N 次内部 call 变成
一次 EVM call。本模型保守地逐 call 使用 transaction-equivalent gas，并按每批增加 Paymaster
validation+postOp gas；这可能重复计算批内 transaction base gas，故是安全侧上界而不是节省承诺。

## 精确公式

设 gas 为 G、L2 gas price 为 p wei/gas、ETH/USD 定点价格为 x（1e8）、USDC decimals 为 d：

`costFloor = floor(G × p × x × 10^d / (1e18 × 1e8))`

`costCeil = ceil(G × p × x × 10^d / (1e18 × 1e8))`

预算、break-even 和 go/no-go 一律用 `costCeil`；展示下界才用 `costFloor`。抽水为
`rake=floor(principal×rakeBps/10000)`。固定 claimant 数下：

`minimumBreakEvenPool = ceil(totalCostCeil×10000/rakeBps)`

`rakeCoverageBps = floor(rake×10000/totalCostCeil)`

该比率不封顶：10,000 表示刚好 1× 覆盖，大于 10,000 表示可覆盖多倍成本，避免丢失安全余量信息。

最大可完整补贴 claim 数通过单调二分精确求得，同时计入
`ceil(claimCount/batchSize)` 个 Paymaster 批次开销，而不是用忽略批次阶梯的近似除法。

## 试运营情景（非价格预测）

共同试算输入：0.01 gwei、ETH/USD=3,000、rake=500 bps、100% claim 赞助、AA batch=32。
这些只是覆盖敏感性的测试向量，不是当前报价、预测或 launch 参数承诺。

| 情景 | principal | rake | resolve settlement cost ceiling | settlement break-even pool | budget max full claims | scenario budget sufficient |
|---|---:|---:|---:|---:|---:|---|
| trial-full-5000 | 5000 USDC | 250 USDC | 0.391499 USDC | 7.82998 USDC | 13086 | YES |
| trial-clone-500 | 500 USDC | 25 USDC | 0.087 USDC | 1.74 USDC | 3270 | YES |

JSON 同时分别包含 creator void 与 timeout void（refund、bond settlement、bonus claim）路径。
Void 不产生 rake，所以其 refund/Paymaster 成本只能由用户、运营预算或另行
批准的补贴承担，不能被表述为“由本池抽水覆盖”。创建、买入、挂单和 fill 的 lifecycle 成本与 terminal
settlement 成本分别输出；前者通常由 creator/交易用户承担，不应全部归入 Paymaster 预算。

## 敏感性网格（非价格预测）

| 情景 | gas price (gwei) | ETH/USD input | resolve settlement cost ceiling | break-even pool | rake coverage bps |
|---|---:|---:|---:|---:|---:|
| trial-full-5000 | 0.001 | 1000 | 0.01305 USDC | 0.261 USDC | 191570881 |
| trial-full-5000 | 0.001 | 3000 | 0.03915 USDC | 0.783 USDC | 63856960 |
| trial-full-5000 | 0.001 | 6000 | 0.0783 USDC | 1.566 USDC | 31928480 |
| trial-full-5000 | 0.01 | 1000 | 0.1305 USDC | 2.61 USDC | 19157088 |
| trial-full-5000 | 0.01 | 3000 | 0.391499 USDC | 7.82998 USDC | 6385712 |
| trial-full-5000 | 0.01 | 6000 | 0.782997 USDC | 15.65994 USDC | 3192860 |
| trial-full-5000 | 0.1 | 1000 | 1.304995 USDC | 26.0999 USDC | 1915716 |
| trial-full-5000 | 0.1 | 3000 | 3.914985 USDC | 78.2997 USDC | 638572 |
| trial-full-5000 | 0.1 | 6000 | 7.829969 USDC | 156.59938 USDC | 319286 |
| trial-clone-500 | 0.001 | 1000 | 0.0029 USDC | 0.058 USDC | 86206896 |
| trial-clone-500 | 0.001 | 3000 | 0.0087 USDC | 0.174 USDC | 28735632 |
| trial-clone-500 | 0.001 | 6000 | 0.0174 USDC | 0.348 USDC | 14367816 |
| trial-clone-500 | 0.01 | 1000 | 0.029 USDC | 0.58 USDC | 8620689 |
| trial-clone-500 | 0.01 | 3000 | 0.087 USDC | 1.74 USDC | 2873563 |
| trial-clone-500 | 0.01 | 6000 | 0.174 USDC | 3.48 USDC | 1436781 |
| trial-clone-500 | 0.1 | 1000 | 0.289999 USDC | 5.79998 USDC | 862071 |
| trial-clone-500 | 0.1 | 3000 | 0.869997 USDC | 17.39994 USDC | 287357 |
| trial-clone-500 | 0.1 | 6000 | 1.739994 USDC | 34.79988 USDC | 143678 |

## 费用承担与 launch go/no-go

- Creator/创建方：market create 和 bond 相关交易；除非产品另行赞助。
- 买方/卖方：一级 buy、listing、fill；C2C fee 是协议收入，不等于链上 gas 补贴预算。
- Claimant：未赞助 claim/refund gas。
- Sponsor：按 sponsorShareBps 向上取整后的 claimant 数、每批 Paymaster 开销，以及配置为 sponsor 的
  terminal keeper 操作；链上 payout 永远支付权益人，不支付 sponsor。
- Void：没有 rake；必须以独立预算做 go/no-go。

候选 launch 配置只有同时满足下列条件才可 GO：

1. `principal >= minimumBreakEvenSettlementPool`（若目标是 rake 覆盖 resolve 结算）；
2. `sponsorBudget >= sponsorRequiredCostCeil`，且预算限额在 PostgreSQL/链上策略中 fail closed；
3. 以目标 Arbitrum 环境的 receipt gas、选定 gas-price percentile 和经批准 ETH/USD 风险上界重跑 JSON；
4. resolve/void finalize 独立 gas gate 通过；
5. 对 void 路径另有足额预算，或明确由 holder 自付；
6. provider、bundler、Paymaster、USDC/Arbitrum 异常演练通过。

任一点不满足即 NO-GO，不能靠降低偿付检查、reentrancy、cap、deadline 或精确到账保护来达标。

## 残余外部边界

模型不预测 gas price、ETH/USD、Arbitrum L1 data fee/压缩规则、sequencer 可用性、bundler markup、外部
Paymaster 政策或 USDC 可用性。当前 gas gate 主要是本地 Forge/Anvil 证据；真实 UserOperation 的
preVerificationGas、calldata/L1 data fee 和 provider 计费需用部署候选环境的 receipt 单独加入。
大额极端输入使用 JavaScript BigInt，不会浮点丢精，但不能把超出协议/供应商实际边界的数学输出当成
可执行交易保证。

## 可复现命令与产物

`node --check scripts/economics/unit-economics.mjs`

`node --test scripts/economics/unit-economics.test.mjs`

`node scripts/economics/generate-report.mjs`

机器可读输出：`reports/economics/micro-pool-unit-economics.json`。生成器不使用网络、时间戳或随机数，
相同源码和输入应产生逐字节相同输出。
