# 数学模型、精度与守恒报告

## 1. 整数域

所有金额和份额均为非负整数。USDC atomic unit = `10^-6 USDC`；share atomic unit =
`10^-6 share`。一级购买令 `principal += units`、`supply[outcome] += units`，因此金额与份额
在 atomic unit 上严格 1:1。合约不接受 decimals 非 6 的 payment token。

## 2. Resolve 分解

设 `P∈uint256`，bps 分母 `B=10000`：

```text
R=floor(P*r/B)
Q=floor(R*q/B)
E=enabled ? floor((R-Q)*e/B) : 0
C=R-Q-E
W=P-R
```

直接恒等式：`W+C+Q+E=P`。每一步先向下取整，最后通过减法把所有原子单位分配给明确
的 bucket，不存在“未记账 dust”。`r≤1000`，因此 `W≥0.9P`；`q,e≤5000`，所以
`C,Q,E` 非负。实际计算用 512-bit 中间值的 `Math.mulDiv`。

## 3. Remaining-pool 算法

对 pool `A`、总 units `U`，每次领取 `u≤remainingU`：

```text
if u == remainingU: payout = remainingA
else: payout = floor(u*remainingA/remainingU)
remainingU -= u
remainingA -= payout
```

归纳可知 payout 永不超过 remainingA；最后一次把 remainingA 归零；全体 payout 精确等于
初始 A。它用于 winner、early、timeout bond bonus。注意每次分母、分子都会更新，因此这不是
“所有人按初始比例下取整，只有最后一人拿 dust”：先前舍入留下的原子单位会进入后续动态比例，可能
由多个后续领取者取得。比如 `A=10,U=6` 且六次各领 1 unit，payout 是 `1,1,2,2,2,2`，而不是
`1,1,1,1,1,5`。不同领取顺序、持仓转移和地址拆分可能改变各地址的 atomic-unit 分配；唯一不变的是
每次不超付、全体总和精确等于 A，且拆分不能增加池总价值。这是公开、可观测的舍入政策和残余公平性风险。

## 4. Void

每个 outcome 的当前 ERC-1155 supply 来自一级 mint，转移不改总 supply。退款 burn `u` 并付
`u` USDC，因此所有 outcome 完全 burn 后退款精确为 `P`。creator void 时 bond 返 creator；
timeout 时 principal 先独立退款，burned units 变为 bonus eligibility；当 `P>0` 时最终 bonus 总和
等于 bond。当 `P=0` 时没有 burned units 或合法分母，BondEscrow 不建立不可领取 bonus pool，而把
bond 记入 creator pull credit；这不产生用户负债。

## 5. C2C

```text
gross=floor(units*unitPrice/1e6)
pf=floor(gross*platformBps/10000)
cf=floor(gross*creatorBps/10000)
seller=gross-pf-cf
```

因此 `seller+pf+cf=gross`。价格范围 1 atomic USDC/whole share 至 1,000 USDC/whole share；
每次成交要求 gross≥1 atomic USDC。成交仅转 ERC-1155 owner，不 mint/burn，不改 P。

## 6. 上溢、窄化与边界

- 乘除：`Math.mulDiv`；上下限和余额运算使用 Solidity checked arithmetic。
- storage 窄化：`SafeCast`；外部 uint256 先检查再写 uint128/uint64/uint8。
- 不使用浮点数、assembly 或无证明的 `unchecked`。
- deadline/closeAt 使用 L2 timestamp；validator/sequencer 的秒级偏差不能改变总偿付，只可能影响
  边界交易是否在窗口内，客户端必须留安全余量。

## 7. Reference properties

必须持续满足：Vault balance 覆盖未付本金/terminal pools；`Σsupply=unburned principal units`；
resolve 四分量和为 P；所有 winner= W；所有 early=E；所有 void refund=P；timeout bonus=bond；
C2C seller+fees=gross；Guard reported exposure 不低于真实活动负债；任何治理地址不能成为本金接收者。

当前 Foundry invariant 已覆盖其中的资产覆盖、supply、Guard 和 Fee/Bond solvency；边界回归覆盖
creator deadline 与零本金 timeout bond。coverage 的 `src/**` 100/100/99.13 门禁和 Medusa
1,024,046 calls / 27 properties 已通过；Halmos 3/3 与 SMTChecker CHC/BMC 各 10 assertions 提供限定
范围的数学证明。Echidna arm64 已完成 1,000,053 calls、4/4 properties；x86_64 只完成
1,032-call 诊断并在 coverage 持久化阶段挂起。whole-protocol mutation 和完整授权/状态形式化仍是
发布阻断项。当前总状态以 `00-delivery-status.md` 为准。
