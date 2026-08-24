# 部署、验证、监控、应急与回滚

## 1. Arbitrum Sepolia 前置条件

- 确认 chainId 421614、Ethereum Sepolia parent chainId 11155111、canonical
  USDC/Permit2/EntryPoint v0.8 地址和 runtime codehash；
- 已创建 4/6 Governance Safe、2/6 Emergency Safe、treasury、独立 sponsor signer；
- deployer 有受限测试 ETH，RPC 可信且不得把 private key 写入 `.env`/shell history；
- 所有静态/测试/审计阻断关闭，source manifest 冻结；
- 明确部署不是外部审计或主网上线授权。

## 2. 两阶段部署

`DeployArbitrumSepolia.s.sol` 部署 Timelock(1h)、Config、Emergency、Guard、Escrows、Full deployer、
Clone implementation、Factory、Marketplace、Paymaster，并 schedule 一次性 wiring batch。等待至少 1h
后运行 `FinalizeBootstrap.s.sol` 执行 batch，并撤销 deployer proposer/canceller/admin。两阶段都必须
核对 pending manifest、simulation、broadcast receipt 和最终 roles。

Factory 在部署后保持 inactive。部署操作者必须离线/独立计算并复核
`EXPECTED_FACTORY_DEPENDENCY_FINGERPRINT`，它绑定 chainId、Factory 以及 Config、Emergency、Guard、
Bond/Fee、Full deployer、Clone implementation、payment token、Permit2、Marketplace 的地址和当前
runtime codehash。Finalize 只有在完整 wiring 完成后调用一次 `activate(expectedFingerprint)`；激活事件
与 storage fingerprint 必须与部署清单一致。不得从待激活 Factory 自身读值后不经独立清单复核就回填。

禁止跳过：源码验证、constructor args、runtime/creation hash、Clone implementation lock、Factory
marketplace/guard/escrow/deployer binding、Fee/Bond authorized caller、Timelock permissionless executor、
deployer 临时角色清零；还必须在 activation 前验证 payment token/Permit2/Marketplace code 存在、
Clone implementation pristine、所有 governance/factory/token wiring 与 FeeVault accrual 授权。激活前
尝试 `createMarket` 应以 `FactoryNotActive` 回滚，激活后第二次 activate 应失败。

## 3. E2E 清单

分别创建 Full/Clone：allowance buy、Permit2 buy/replay reject、AA approval+listing、partial fill、cancel、
terminal return、resolve/winner/early/fee/bond、creator void/refund、emergency pause/expiry、Paymaster
budget/fallback。创建独立 timeout canary，真实等 24h，执行 permissionless void→principal refund→
延迟 bond settle→bonus；另建零参与者 canary，timeout 后 bond 应进入 creator credit 而不是空 bonus
pool。边界烟测必须覆盖 deadline-1 creator void、deadline creator void reject + permissionless timeout。
每一步记录 address、tx、block/hash、caller、before/after storage 和事件。

## 4. 监控与值班

启动前部署多 RPC、Indexer DB backup、Prometheus/Alertmanager/Grafana/Sentry，执行 synthetic read 和
只读 solvency reconciliation。Pager runbook 按 critical/page/warning；任何 assets<liabilities、非法
terminal、codehash/role drift 立即升级安全事件。日志保留与隐私按法律政策配置。

Indexer 上线必须先对 disposable/预生产 PostgreSQL 实跑 migration、common-ancestor 多区块 reorg、
动态市场发现与 raw/derived/checkpoint 原子回滚，再做 backup/restore。当前独立 disposable
PostgreSQL 17.10 门禁已执行 Paymaster 2/2、Indexer 3/3、readiness 4/4，共 9/9、0 skip；普通
off-chain 命令中的 5 个数据库条件用例仍会在未设置 `TEST_DATABASE_URL` 时跳过，两条 lane 不得混写。
Paymaster 必须实接 KMS/HSM、transactional budget store、Bundler，校验
链上 sponsorSigner/policyVersion，并演练两段 paymaster gas header 篡改与 deposit loss cap。

## 5. 事件响应

1. 确认信号：至少 RPC/storage/receipt 两类证据，排除 indexer 假阳性。
2. 若新增资金风险，2/6 只暂停必要 flags，记录 epoch/expiry/reason；不碰 cancel/claim/refund。
3. 固化 block/tx/log/codehash/roles/source manifest，启动沟通与法律流程。
4. 评估存量退出；不得部署“管理员抢救提款”。
5. 修复只能新版本部署，旧 Factory deprecate；Timelock 公开迁移配置。
6. 复盘、监控补强、外审复核、再开放。Emergency Safe 无权 unpause；到期自动恢复，必要的新 epoch
   只能由 Timelock 重置，避免无期限 2/6 停服。

## 6. 回滚/弃用

不可升级合约没有代码 rollback。安全回滚定义为：暂停旧版本新增→部署/审计 V2→弃用旧 Factory→
前端停止创建旧市场→旧市场按原语义结算/退款→Guard 在 exposure 清零后处理。禁止迁移或 sweep
用户本金。链下 release 可回滚服务版本，但不能回滚已上链交易；Indexer 可从已知 finalized block
重放。

## 7. 密钥与角色

Safe 签名者使用硬件密钥和独立恢复渠道；禁止 deployer、sponsor、RPC、Sentry 共用密钥。制定加入/
移除、离职、丢失、疑似泄露和 KMS rotation 演练。Paymaster deposit/stake 只保留短期预算；提取只能
Timelock。主网 Timelock 计划为 7 天，任何缩短属于新审计/治理决策。

## 8. 当前部署状态

未部署。`deployments/arbitrum-sepolia/README.md` 是唯一当前状态；没有地址/交易/区块意味着所有实链
项均为 unverified。

Compose、部署同步、Arbiscan、可恢复 canary、备份/恢复和本地故障演练入口已经补齐，操作手册见
`docs/zh/13-compose-runtime-operations.md`。当前主机没有 Docker/Compose，所以镜像构建、新鲜 Compose
健康链、真实 backup/restore 仍未运行；本地故障报告也只能标记 `LOCAL_SIMULATION`。这些工具不改变
`BLOCKED_NOT_DEPLOYED`、24h canary `NOT RUN` 或 formal ops `NOT RUN`。

## 9. 证据门禁与禁止伪证

仓库已提供 fail-closed 的静态工具，但它们不会部署或广播：

- `final-manifest.schema.json` 定义最终交付字段；`validate-final-manifest.mjs` 进一步严格校验
  chainId 421614、全部地址/交易/区块/codehash/constructor/config、4/6 与 2/6 Safe、1h Timelock、
  Factory fingerprint、源码验证和临时权限清零；
- `verify-live-rpc.mjs` 必须连接两个不同 origin 的独立 RPC，并在同一个 reference block 比较
  block hash、runtime code、关键 getter/wiring、Factory active/fingerprint、Safe owner/threshold 和
  从 RoleGranted/RoleRevoked 日志重建的 Timelock 最终角色；reference block 还必须绑定
  `l1BlockNumber`，且不高于两个 RPC 各自返回的 `finalized` block；任何缺失或分歧均失败；
- `validate-canary-evidence.mjs` 要求 Full、Clone、allowance、Permit2、AA、C2C、resolve、void、
  emergency、Paymaster、deadline 边界以及真实 24h timeout 的完整 receipt；本金必须 1:1，bonus
  总和必须等于 slash bond，零参与者 bond 必须进入 creator credit；
- `validate-ops-evidence.mjs` 要求角色快照、指标、告警送达、RPC 分歧/切换、负债告警、暂停但可退出、
  自动到期、Indexer reorg/备份恢复、KMS rotation 和 Paymaster deposit loss cap 的不可变证据；
- `validate-monitoring-config.mjs` 只证明规则静态完整，不证明 Alertmanager/Pager/Sentry 真实送达。

`deployments/arbitrum-sepolia/templates/*.template.json` 都带 `TEMPLATE_NOT_RUNTIME_EVIDENCE`，并被严格
validator 主动拒绝。禁止把模板、simulation、pending manifest、单 RPC 输出、未确认 receipt 或手填
状态当作 Arbitrum Sepolia runtime proof。证据必须存放在受控的不可变外部存储，仓库不保存私钥、RPC token、
KMS 凭据、Safe 凭据或告警路由 secret。
