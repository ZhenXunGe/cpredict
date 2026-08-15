# Cpredict V1 内部安全复核记录

复核日期：2026-08-08。范围：当前未提交、未部署的本地工作树。本文记录人工复核发现，
不构成独立外部审计结论。

## CPV1-INT-001：终局 Marketplace 托管份额可被第三方代领

- 初始严重度：High
- 当前状态：已在本地工作树修复并加入回归测试
- 受影响版本：本次开发过程中的中间实现；不存在已提交 tag、已部署地址或已承载资金的版本
- 影响路径：`claimWinningsFor(marketplace)`、`refundFor(marketplace)`

### 原因与影响

协议允许任何地址为权益所有者触发 claim/refund，资金只能支付给 owner。该规则对普通 holder 是安全且
有利于可用性的，但 Marketplace 在 active listing 期间也是 ERC-1155 owner。终局后，攻击者可以把
Marketplace 作为 owner 调用 Vault：托管份额会被整体烧毁，USDC 会支付到 Marketplace，而 Marketplace
没有按 listing seller 分摊这笔 USDC 的会计路径。结果不是攻击者获利，而是卖家的份额及对应 payout/
refund 被困在 Marketplace。

### 修复

- Factory 接口暴露唯一协议 Marketplace 地址；
- Vault 的 winner claim 和 principal refund 拒绝以该地址作为 owner；
- 终局托管份额必须先走 `returnTerminalListing`，该操作 permissionless，始终把份额返还原 seller；
- seller 随后自行调用或由 keeper 调用 `claimWinningsFor(seller)` / `refundFor(seller)`；
- 自定义错误 `EscrowOwnerMustReturnListing` 使故障原因可索引、可回溯。

### 证据

- `testTerminalEscrowMustReturnBeforeHolderRefund`；
- `testResolvedEscrowMustReturnBeforeWinnerClaim`；
- 两个用例均验证拦截、permissionless return、卖家完整领取以及 Marketplace 不留存 USDC。

### 残余边界

该控制只识别本协议注册的唯一 Marketplace。其他第三方托管合约必须自行实现权益分配；Vault 无法可靠
推断任意地址是否为托管账户。前端和审计文档必须明确：协议只对官方 Marketplace 提供终局自动返还
安全语义。

## CPV1-INT-002：timeout bonus 注入后 Guard 可能低报

- 初始严重度：Medium
- 当前状态：已修复并回归

Timeout 市场在 principal refund 后可能已把 Guard exposure 同步到零，随后 BondEscrow 注入 bonus 会
重新产生用户负债。修复后 `guardExposure()` 同时计入剩余 principal 与 timeout bonus，且
`fundTimeoutBonus` 原子调用 Guard `sync`；事件记录同步前后 exposure。即使因此令总 reported exposure
高于 cap，`reserve` 也以可用容量零和 `ExposureCapExceeded` 失败关闭，不产生算术下溢 Panic。

证据：`testTimeoutPrincipalDoesNotDependOnBondAndBonusArrivesLater`、
`testGuardFailsClosedWithCustomErrorWhenSyncedExposureExceedsCap`。

## CPV1-INT-003：Paymaster 日预算漏计已结算支出

- 初始严重度：High
- 当前状态：已修复并回归

早期实现仅校验 active reservation，完成 `postOp` 后 reservation 释放，可能使同一日预算重复使用。
现按 `spent + reserved + nextReservation` 校验；`postOp` 释放 active reservation 后把完整 reserved
prefund 计入 daily spent。该规则比 EntryPoint 提供、且不含本次 postOp/unused-gas penalty 的
`actualGasCost` 更保守，避免预算低报。

证据：`testSettledSpendContinuesToConsumeDailyBudget` 及 Paymaster 预算/重放测试。

## CPV1-INT-004：SDK claim ABI 名称漂移

- 初始严重度：Medium（集成可用性）
- 当前状态：已修复并回归

SDK 精简 ABI 曾使用链上不存在的 `claimWinnerFor` / `claimRefundFor`，真实前端会在 simulate 阶段
失败，合约资金不受影响。现改为 `claimWinningsFor` / `refundFor`，并新增测试将 SDK 精简 ABI 的
function signature 与生成的 Full Vault/Marketplace ABI 逐项比较；未来 ABI 漂移将直接令链下门禁失败。

## CPV1-INT-005：creator void 越过 permissionless timeout 边界

- 初始严重度：High
- 当前状态：已修复并回归

creator 的 `resolve` 已受 24 小时窗口约束，但中间实现的 `creatorVoid` 只检查非终局状态，使 creator
可能在 deadline 后先执行 creator void、取回本应在弃盘时罚没的 bond，并抢在任意 caller 的 timeout
之前选择不同终局。现 `creatorVoid` 与 `resolve` 一样在 `block.timestamp >= resolutionDeadline()` 时以
`ResolutionWindowExpired` 失败；`voidAfterDeadline` 从等号边界开始开放，两个权限窗口不再重叠。

证据：`testCreatorVoidExpiresAtDeadlineAndCannotRacePermissionlessTimeout` 覆盖 deadline-1、deadline 和
deadline+1，并验证 terminal 后不能二次调用；`testResolveWindowAndTimeoutBoundariesAreExact` 覆盖 resolve
与 timeout 等号边界。

## CPV1-INT-006：零参与者 timeout bond 可被注入不可领取 bonus pool

- 初始严重度：Medium（资金可用性/会计）
- 当前状态：已修复并回归

当 `totalPrincipal == 0` 时，市场没有任何 burned refund units，因而不存在 timeout bonus beneficiary
或合法分母。中间实现若仍把 bond 转入 Vault，会形成永久不可领取余额。`BondEscrowV1.settleBond` 现只在
`VOIDED_TIMEOUT && totalPrincipal != 0` 时 fund bonus；空市场把金额计入 creator 的既有 pull-credit
会计，同时发出 `EmptyTimeoutBondCredited` 和 `BondCredited`。该例外不影响任何有参与者市场的罚没。

证据：`testBondEscrowEmptyTimeoutCreditsCreatorInsteadOfLockingBond` 和
`testEmptyTimeoutCreditsBondBackToCreatorWithoutFundingUnclaimableBonus` 验证 Escrow/Vault 余额、credit、
事件及 creator claim。

## CPV1-INT-007：Permit2 witness suffix 非 canonical 的签名不可互操作风险

- 初始严重度：Medium（集成可用性）
- 当前状态：已修复并加入独立向量

Permit2 `permitWitnessTransferFrom` 要求传入以 `<PrimaryType> witness)` 开头、随后连接 primary type 与
依赖 `TokenPermissions` 的 canonical suffix。Vault/Marketplace 现分别公开
`BUY_WITNESS_TYPE_STRING` / `FILL_WITNESS_TYPE_STRING`，SDK 使用相同规范生成 typed data；测试不是仅把
SDK 常量与合约常量互比，而是用独立字面量/typehash、标准 EIP-712 account sign/recover 和 buy/fill
域分离向量复算，降低双方复制同一错误的风险。

证据：`testCanonicalWitnessReferenceVectorsAndContractExposure`、
`offchain/sdk/test/permit2.test.ts` 与既有真实 Permit2 replay/changed-outcome 用例。Base canonical Permit2
runtime codehash 和真实 provider 钱包仍须在测试网验证。

## CPV1-INT-008：Paymaster 签名未绑定 packed paymaster gas limits

- 初始严重度：High
- 当前状态：已修复并回归

ERC-4337 v0.8 的 `paymasterAndData` header 包含独立的 verification/postOp gas limits；只绑定
account gas fields 不能证明 sponsor 授权了实际 packed header。合约/服务的 `Sponsorship` typed data
现同时包含 `paymasterVerificationGasLimit` 与 `paymasterPostOpGasLimit`，分别限制在 150k–500k、
100k–300k；服务将同一值写入 header 与 EIP-712 message，任一字段变化都会改变 digest/令签名失效。

证据：`testSignedPaymasterGasHeaderCannotBeMutated`、`test/viair/SponsorshipDigest.t.sol`、
`offchain/paymaster-service/test/sponsorship.test.ts` 的独立 canonical digest 和双字段 mutation。真实
Bundler/stateful Paymaster、KMS/HSM、deposit 损失上限仍未运行验证。

## CPV1-INT-009：Factory 可在依赖半接线/错代码状态接受新市场

- 初始严重度：High（部署完整性）
- 当前状态：已修复并回归

只依赖部署脚本顺序不足以让合约自身拒绝半接线或错版本依赖。Factory 现默认 `active=false`，
`createMarket` 先检查 `FactoryNotActive`。Governance 只能执行一次 `activate(expectedFingerprint)`：该入口
检查所有必需依赖 runtime code、governance/factory/payment-token/Permit2/Marketplace wiring、Clone
implementation pristine 状态、FeeVault accrual 权限，再将 chainId、Factory 和每个依赖地址+codehash
组成的实际 fingerprint 与独立部署清单期望值比较。成功后的 fingerprint 固化，不能替换。

证据：`testFactoryFailsClosedBeforeActivationAndOnFingerprintMismatch`、
`testFactoryActivationRejectsMissingMarketplaceCodeAndWrongWiring`，以及部署/Finalize 脚本要求外部提供
`EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT`。残余风险是部署清单与审批过程自身出错，须外审和实链
codehash/role 核对。

## CPV1-INT-010：Indexer 单 checkpoint reorg 处理不足以恢复深分叉和动态市场

- 初始严重度：Medium（展示/worker 数据完整性；不进入本金会计）
- 当前状态：已修复；内存、接口及独立真实 PostgreSQL lane 均有回归证据

Indexer 现持久化每个扫描区块（包括无事件区块）的 hash、parentHash、timestamp；发现 checkpoint
不一致后逐块回退找到 common ancestor，并要求 store 在同一事务删除分叉后的 raw events、market
registry 和所有 derived projections，再从保留 raw evidence 重建。Factory `MarketCreated` 动态注册 Vault，
同一批次重新查询新 Vault，避免漏掉创建交易中较早的初始化事件。只读 API 物化 markets/listings/
fills/positions/claims；terminal worker 使用有界 API 分页、每市场每区块一次 simulate/send，并输出
结构化/脱敏结果。

证据：`offchain/indexer/test/indexer.test.ts` 覆盖无事件 common ancestor、多区块 reorg、动态发现、
幂等和 projections；API/worker/SDK/React 聚焦用例已通过。独立 disposable PostgreSQL 17.10 lane
实际执行 Indexer 3/3、Paymaster 2/2、readiness 4/4，共 9/9、0 skip。该结果是本地真实数据库证据，
不是生产 TLS、备份、复制、恢复演练或 Base runtime verified。

## 链下交付与证明边界

- SDK 已覆盖 create/update、allowance/Permit2 buy、listing/fill/cancel/return、terminal、四类 claim、
  bond/Guard maintenance，并统一 simulate→single send→receipt。
- AA helper 按 protocol-free→external-USDC→显式 native-ETH 选择，使用独立 nonce key、有限 timeout，
  不自动重发已提交 UserOperation；provider 即使忽略 `AbortSignal` 并永不 settle，也会由独立 Promise
  deadline 结束等待并进入下一 fallback。
- Paymaster service 实现 loopback-only server、auth/KMS adapter、policy、持久 budget boundary、
  health/readiness/metrics；仓库不包含 raw-key signer，也未实接生产 KMS/Bundler/TLS/WAF。
- Terminal worker 对专用 EOA 的 settle/sync 顺序提交，避免单 nonce lane 竞争；结果区分 simulation、
  submission、receipt 和链上 revert，32-byte 及更长 hex 被脱敏。
- React 示例覆盖完整协议写调用面、creation fee+bond/Permit2/Marketplace fill 精确授权与不可逆提示，
  但 SSR unit 不是钱包、浏览器或旗舰 UI E2E。
- 当前普通全量链下命令为 79 tests pass、5 个 PostgreSQL conditional skip；独立真实 PostgreSQL
  17.10 lane 为 9/9 pass、0 skip。两个 lane 的证明边界必须分别陈述。

## 结论

上述链上发现均在未部署工作树内修复并有聚焦回归；它们证明人工攻击面复核确实发现了自动化测试
最初未覆盖的问题，也说明当前代码不能跳过独立审计。当前 coverage lane 为 20 suites、121/121 tests，
`src/**` line 100%、function 100%、branch 99.13% PASS；production gas/size 为 10/10 PASS。Slither、
Aderyn、Halmos、SMTChecker 与 Medusa 均有当前 source-bound 本地 PASS 证据，其中 Medusa 为
1,024,046 calls、27/27。Echidna arm64 已完成 1,000,053 calls、4/4 PASS；x86_64 诊断达到
1,032 calls、4/4 PASS，但在保存 coverage 时挂起，未形成百万调用生命周期证据，因此 security
aggregate 仍为 FAIL。Mutation runner 生命周期已加固但 fresh whole-protocol campaign 未运行；
两轮外部审计、正式商业负载、Base
Sepolia 和 24 小时 canary 仍是发布阻断项。完整当前口径只以
`docs/zh/00-delivery-status.md` 为准。
