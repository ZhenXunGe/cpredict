# 分布式商业负载系统实现记录（2026-08-12）

## 状态

系统与证据门禁已实现并完成轻量静态/fixture 验证；正式商业运行仍为 **NOT RUN**。本次没有执行
第三次同机校准、500/2,000 RPS full、10,000 WS、50 tx/s × 10 分钟或真实 reorg drill。

## 新执行边界

- `sut-up.sh`：只在 SUT 主机启动真实/等价 API、Indexer、PostgreSQL，并在整个重叠窗口采集指标。
- `load-run.sh`：只在独立 k6 主机访问非 loopback TLS API 与精确 `/v1/stream` WSS 目标。先证明
  本次新 SUT 进程的 WS baseline peak 为 0，再执行 10,000 WS × 60 秒；随后执行 500 RPS × 5 分钟、
  2,000 RPS × 1 分钟。阈值未降低。
- `chain-run.sh`：只在独立受控链主机执行 50 tx/s × 600 秒，并强制要求事件延迟与多块 reorg
  drill 证据；正式负载前后还会对 loopback Anvil 与 SUT 使用的 TLS RPC 做 chainId、genesis、同高度
  block hash 和 market runtime code 双端校验，拒绝“压 A 链、索引 B 链”。
- `evidence-collect.sh`：复制三个不可变 role 目录，重新验证原始证据，拒绝重复 host identity 和
  machine fingerprint，生成 schema-v4 manifest 并使用 Ed25519 离线签名。

## fail-closed 证据

每个 role 在任何重负载前先校验所有证据输入；随后记录所有普通文件的字节数和 SHA-256、stage exit
code、声明 host identity SHA-256、身份来源、外部 identity receipt 的字节数/SHA-256、机器指纹 SHA-256、运行目标、commit/source manifest/release config/migration tree/
runtime image digest、时钟来源和最大偏移、开始/完成时间。聚合器重新计算 role/artifact digest，
要求三个声明身份及三个机器指纹各自唯一、release binding 一致、三角色至少重叠 300 秒且 SUT 窗口
覆盖 load/chain 窗口；时钟最大偏移不得超过 100 ms，且时钟证据必须在 role 开始前 60 秒内或运行中采集。
identity receipt 只作为哈希绑定的外部证据，当前代码明确标为“未在 Cpredict 内做密码学验证”。

SUT telemetry 保留完整原始样本，并从原始样本重新计算 API/Node、Indexer、WS、生产 store operation
latency 和与 driver 同上限的 application admission wait。PostgreSQL 原生采集限定为 current database 的
active connections/transactions 与 cluster checkpoint counters；不再把采集器自身的 `reserve()+SELECT 1`
误标为生产 pool/query p95。链事件延迟必须由 30,000 份 receipt inventory 和 28,500 份
`PrimaryPurchased` WebSocket delivery inventory 重算 missing/duplicate/unexpected 和 p95；reorg 必须给出
共同祖先、旧/新分支 hashes、回滚前后 orphan rows、重放 counts 和最终 checkpoint hash，而不是布尔自证。

## 未验证/待环境接入

生产环境的启动命令、事件/receipt adapter、reorg 注入与数据库 inventory adapter、时钟同步证明、
容器镜像 digest 和云主机身份文件仍由部署环境提供。本地代码没有云/IaC source of truth，因此没有伪造这些值，也未将 fixture
结果写成商业 PASS。

## 本次聚焦验证

- `node --test load/distributed/commercial-evidence.test.mjs load/distributed/preflight-role-evidence.test.mjs
  load/distributed/chain-node-binding.test.mjs scripts/load/validate-production-evidence.test.mjs`：16/16 PASS。
- `npm run check:offchain --silent`：PASS。
- Indexer focused suite：6 files、22 tests PASS（仅用 loopback API/WS test server）。
- 所有新 `.mjs` `node --check` 与四个 role shell `bash -n`：PASS。
- 该结果只验证 schema/validator 行为，不生成三台真实主机、生产 PostgreSQL、k6、链或签名 bundle
  的运行时证据。
