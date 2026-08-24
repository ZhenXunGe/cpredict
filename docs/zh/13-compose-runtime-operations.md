# Docker Compose、部署同步与运行演练

## 1. 证据边界

本章提供测试网和甲方验收所需的一键运行体验，不是生产高可用拓扑。当前仓库状态仍是：

```text
Compose/tooling: STATIC VERIFIED; LOCAL DOCKER RUNTIME NOT RUN ON THIS HOST
Arbitrum Sepolia deployment: BLOCKED_NOT_DEPLOYED
24h canary: NOT RUN
Formal ops evidence: NOT RUN
```

本地 Compose、Anvil 或 `LOCAL_SIMULATION` 报告不能生成 `FINALIZED_VERIFIED`。Kafka、Nacos、撮合服务
和 CLOB Helm Chart 不属于单池 parimutuel 协议范围。

## 2. 准备环境

要求 Docker Engine + Compose v2、Node.js 22。复制服务端配置并限制权限：

```bash
cp .env.compose.example .env.compose.local
chmod 600 .env.compose.local
```

密码必须是 24–128 位 URL-safe 随机值；RPC 只能是 HTTPS 或本机 loopback HTTP。解析器不会
`source .env`，拒绝命令替换、重复 key、宽松文件权限和把秘密写入生成的 public env。RPC、数据库、
部署私钥、Arbiscan、Auth/KMS 信息不得使用 `VITE_*`。浏览器只能取得同源路径、公开地址、chainId、
codehash 和 Explorer URL。

## 3. 从部署产物生成配置

Debug 部署完成后，使用 Foundry receipt 中最早的部署区块：

```bash
npm run deploy:sync -- candidate \
  --pending deployments/arbitrum-sepolia/pending.json \
  --broadcast broadcast/DeployArbitrumSepolia.s.sol/421614/run-latest.json
```

也可人工传入已复核的 `--deployment-block`。候选模式原子生成 immutable runtime 目录、
`current.env`、Demo DEBUG 地址包、SDK/Indexer/Paymaster/Compose 配置和逐文件 SHA-256；它永远不生成
`final.json`。Demo 自动加载 DEBUG 地址并实时检查 chainId、所有 code 和 Factory/Marketplace wiring，
黄色 DEBUG 不等于最终验证。

pending manifest 必须直接绑定部署时的 `protocolTreasury`、`sponsorSigner`、Paymaster
`policyVersion` 与三级预算。同步工具不会用 deployer 或默认值猜测 signer/预算；任一字段缺失或预算
顺序错误都会失败关闭。

正式同步必须提供两个不同 origin RPC 和实际证据：

```bash
npm run deploy:sync -- final \
  --manifest /secure/evidence/final-manifest.json \
  --canary-evidence /secure/evidence/canary-evidence.json \
  --ops-evidence /secure/evidence/ops-drill-evidence.json \
  --source-verification-evidence /secure/evidence/source-verification.json \
  --rpc-a "$ARBITRUM_SEPOLIA_RPC_URL_A" \
  --rpc-b "$ARBITRUM_SEPOLIA_RPC_URL_B"
```

正式入口会重新执行 final manifest、canary、ops 和双 RPC validator，校验当前 source manifest SHA，
任何错误链、占位 canary、地址/codehash/wiring/角色分歧或输入漂移都失败。运行目录在 Git 中忽略，
不会覆盖 tracked source。

## 4. 一键运行栈

```bash
npm run stack:config
npm run stack:up
npm run stack:status
npm run stack:logs
npm run stack:down
```

基础栈依赖顺序为 PostgreSQL 17 ready → Indexer/Paymaster schema migration → canonical Indexer/API/WS
ready → Nginx Demo ready。PostgreSQL 不发布宿主机端口；外部仅以 `127.0.0.1` 发布 Demo 和 Indexer。
容器启用 `no-new-privileges`、capability drop、只读根文件系统（数据卷和限定 tmpfs 除外）、资源上限、
健康检查与日志轮转。Nginx 同源代理 `/rpc`、`/indexer/`、WebSocket 和 `/deployment/`；远程环境必须在
外层增加 TLS、认证、限流和网络策略。

Paymaster 只能显式启用：

```bash
npm run stack:up -- --sponsorship
# 等价底层模式：docker compose --profile sponsorship ...
```

必须在 `.env.compose.local` 配置绝对 adapter 路径。容器只挂载外部 adapter；adapter 必须提供
Authorizer、KMS/HSM signer、PostgreSQL budget store 和账户解码器。仓库不提供 raw-key adapter，
Paymaster 也不由 Nginx 暴露给浏览器。Indexer/Paymaster 默认 loopback；只有 Compose 显式设置
`*_CONTAINER_MODE=true` 时才允许 `0.0.0.0`。

## 5. Arbiscan 验证

候选 manifest 必须已经包含 11 条和地址绑定的 `PENDING` source verification 记录、完整 constructor
参数和编译设置：

```bash
ARBISCAN_API_KEY=... npm run deploy:verify-source -- \
  --manifest /secure/evidence/candidate-manifest.json \
  --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL_A" \
  --output runtime/arbitrum-sepolia/source-verification.json
```

工具固定 chainId 421614、Foundry wrapper、Solidity 0.8.36、optimizer/viaIR/EVM 设置，逐项 ABI 编码
constructor args，在提交前后核对 RPC runtime codehash，且把每个 redacted log 和 SHA-256 留下。
相同输入的完整 PASS 幂等跳过；输入或参数变化失败，不自动改参或重试。USDC/Permit2/EntryPoint 只做
runtime identity 核验。Explorer PASS 不代替双 RPC 验证。

## 6. Canary

```bash
npm run canary:arbitrum-sepolia -- start \
  --manifest /secure/evidence/candidate-manifest.json \
  --adapter /secure/adapters/canary-executor.mjs \
  --winning-outcome 1
npm run canary:arbitrum-sepolia -- status --manifest ... --adapter ...
npm run canary:arbitrum-sepolia -- finish --manifest ... --adapter ...
```

操作者必须明确选择 winning outcome。外部受审 adapter 承担三测试钱包/KMS 的实际签名；接口见
`deployments/arbitrum-sepolia/CANARY-ADAPTER.md`。Runner 在调用前原子写入 `STARTING/FINISHING`，锁定
manifest、source manifest、adapter SHA、部署 identity 和三个账户。中断后只能调用 receipt/state 驱动的
resume 方法，禁止盲发。Paymaster 不 ready 时在任何交易前写 `BLOCKED`；RPC 区块时间未达到
`closeAt + 86400` 时拒绝 finish。完整输出仍须通过现有 canary validator。

## 7. 备份、恢复与故障演练

```bash
npm run stack:backup
npm run stack:restore-drill -- --backup runtime/arbitrum-sepolia/backups/<id>
npm run stack:drill -- --adapter /secure/adapters/local-ops.mjs
```

备份以只读 `cpredict_backup` 角色生成 Indexer 和 Paymaster custom dump，并记录 PG 版本、migration SHA、
source/deployment identity、关键表行数、文件大小和 SHA-256。恢复入口不接收数据库 URL，只创建随机命名
的一次性容器和 volume；先校验 dump，再 restore、重放全部 migration 验证幂等性、比较所有关键表行数，
最终强制删除容器和 volume。

本地 ops adapter 依次覆盖 13 项：双 RPC、metrics、告警、RPC 分歧/切换、负债、pause 但可退出、自动
到期、Indexer reorg、backup/restore、KMS rotation 和 deposit loss cap。状态在每项前落盘并支持恢复。
输出固定为 `LOCAL_SIMULATION`，不能通过 formal ops validator；正式 evidence 仍需真实监控/KMS、durable
URI 和三名独立操作者签署。接口见 `deployments/arbitrum-sepolia/OPS-ADAPTER.md`。

## 8. 门禁与故障排查

核心实现与稳定 schema 索引：

- `compose.yaml`、`.env.compose.example`
- `scripts/stack/stack.mjs`、`scripts/stack/backup.mjs`、`scripts/stack/restore-drill.mjs`、
  `scripts/stack/ops-drill.mjs`
- `scripts/deployment/sync-runtime.mjs`、`scripts/deployment/verify-source.mjs`、
  `scripts/deployment/canary-runner.mjs`
- `manifests/runtime-package.schema.json`、`manifests/source-verification.schema.json`、
  `manifests/canary-state.schema.json`、`manifests/backup-manifest.schema.json`、
  `manifests/local-ops-drill.schema.json`

```bash
npm run test:stack-tools
npm run test:deployment-tools
npm run check:offchain
npm run demo:test
npm run demo:build
npm run scan:demo-bundle
npm run scan:secrets
npm run check:artifacts
```

当前主机没有 Docker/Compose，因此本轮只能证明 Compose JSON 解析、权限/端口/profile/依赖静态断言、
TypeScript、Demo build/secret scan 和工具 fixture；不能声称镜像或本地 Compose runtime 已验证。具备 Docker
的干净环境还必须执行镜像构建、新鲜 PostgreSQL migration、API/WS/Demo health、真实 backup/restore
zero-skip。Arbitrum Sepolia 广播、Arbiscan、24h canary 和 formal ops 需要另行授权与外部资源。
