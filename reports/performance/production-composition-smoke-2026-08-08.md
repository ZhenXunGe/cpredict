# Cpredict 真实生产组合 API/WS Smoke 报告（2026-08-08）

> 2026-08-12 更新：已补 preflight CPU fallback、真实 10k simultaneous WS peak 证据和
> k6 phase 边界误判修复；两次短校准的服务指标达标但 runner 均非零，最终 profile 未执行正式 full，
> 因此 commercial gate 仍为 **FAIL**。详见
> `reports/performance/commercial-load-remediation-2026-08-12.md`。
>
> 2026-08-08 23:20 CST 更新：focused smoke 仍为 PASS；商用时长 API/WS 门禁为 **FAIL**。
> 不得再引用本报告早期的“full 尚未执行”描述。

## 商用门禁结论

唯一正式 schema-v3 full 运行是
`reports/performance/full-production-schema3-20260808T1450Z/`，结果 **FAIL / aborted**：

| API 指标 | 结果 | 门槛 |
|---|---:|---:|
| completed / scheduled | 269,682 / 270,001 | 270,000（executor 边界最多 +2） |
| 2xx | 269,682 / 269,682 | error `<0.5%` |
| 5xx / transport | 0 / 0 | 各 `<0.5%` |
| dropped | 319 | `0` |
| p95 | 332.99 ms | `<300 ms` |
| p99 | 751.55 ms | `<750 ms` |

API summary 和独立 validator 均失败。正式运行时的 runner 还暴露了一个阶段短路缺陷：API
失败后错误启动了 WS；人工终止并保留原始证据，最终 manifest 为 `runStatus=aborted`、
`runnerExit=76`，链上阶段 `not_run`。此后 runner 已改为任何 API/WS/synthetic/chain 阶段或其
证据验证非零便立即退出，由统一 `EXIT` trap 清理 API、PostgreSQL、Anvil 和临时目录；
`scripts/load/run-full-fail-closed.test.sh` 的 API 非零 fixture 已证明 WS 及后续阶段保持
`not_run` 且三个子进程和 PostgreSQL 临时目录均被清理。

因此 10,000 WS × 60 秒并未取得有效正式结果，不能标记为 PASS；该 full 不重跑、不覆盖、
不降阈值。

## 性能分诊与短校准

正式 full 的 SQL 计划正常：markets/listings 热查询均命中目标索引，代表执行时间约
`0.013 ms`；HTTP 总延迟主要来自 waiting，而不是 receiving。原始 PostgreSQL 日志同时显示，
100k seed 产生的 10,293 个脏 buffer 在默认五分钟 checkpoint 中集中写盘 `103.944 s`，开始
时间恰好早于 2,000 RPS 阶段约三秒。为消除一次性 fixture seed 对读容量测量的污染，本地
验收 harness 仅做以下改动：

- PostgreSQL `checkpoint_timeout=10min`；
- seed 事务和 `ANALYZE` 完成后显式 `CHECKPOINT` 并等待成功；
- seed evidence 记录 timeout、完成时间和阈值；
- k6 summary 增加 500/2,000 RPS 分阶段延迟、错误和执行数，不改变正式请求量、VU 上限或
  p95/p99/error/drops 门槛。

短校准
`reports/performance/production-smoke-checkpoint10m-calibration-20260808T1516Z/` 仍然 **FAIL**：

| 阶段 | completed | error | p95 | p99 |
|---|---:|---:|---:|---:|
| 500 RPS × 30s | 15,001 | 0% | 336.34 ms | 615.86 ms |
| 2,000 RPS × 30s | 31,171 / 60,000 | 31.25% transport | 2.39 s | 4.69 s |
| 聚合 | 46,172 | 21.09% transport | 2.11 s | 4.16 s |

聚合 dropped 为 28,844。该次 seed checkpoint 在计时前仅用 `0.253 s` 完成，测试期间没有
定时 checkpoint，证明 checkpoint 对齐并非唯一问题。k6 默认允许 keep-alive，但连接池按 VU
隔离；2,000 RPS 新 scenario 会冷启大量连接。本机 fd 上限为 1,048,575、临时端口约 16,384，
但 macOS `kern.ipc.somaxconn=128`，使 Fastify 申请的 16,384 listen backlog 在 OS 层被限制；
校准的 connect/blocked p95 约 `3.94 s`、p99 约 `10.35 s`，出现大量 `dial: i/o timeout`。
运行后 full preflight 也为 `safeToStartFullProfile=false`（load average
`8.62 / 12.01 / 11.23`，CPU idle 无法采集）。

现有证据无法把“同机负载生成器/冷连接/OS backlog 饱和”与“单进程 Fastify accept-loop
容量”严格分离；不得把短校准直接归因为 PostgreSQL pool 或业务 API 缺陷，也不得把它当作
生产部署容量结论。下一次候选 full 必须先在独占、preflight PASS、网络接纳能力明确的环境中
完成短校准，并同时满足聚合和分阶段 p95/p99、错误率与零 drops；当前不批准再次 full。

## 修复后候选 profile（仅静态验证，未再次压测）

为避免旧版两个 scenario 在 burst 边界冷启独立 VU/连接池，API full 现改为单一
`ramping-arrival-rate` scenario：同一组 VU 先运行 500 RPS × 5 分 1 秒，再用 2 秒从 500 线性切换
到 2,000 RPS，最后保持 2,000 RPS × 1 分 1 秒；`preAllocatedVUs=2500`、`maxVUs=7000`，未降低
容量上限。请求目标按 `scenario.iterationInTest` 全局分布，不会因新 VU 的局部迭代号从零开始
而集中打向同一 endpoint。

门禁使用低基数 `phase=steady|transition|burst`：最低数仍分别为 150,000、1,250、120,000，
aggregate 被限制在 271,250–275,002，`dropped_iterations` 仍必须
为零；aggregate 以及三个 phase 的 p95 `<300 ms`、p99 `<750 ms` 和 response/5xx/transport
error `<0.5%` 均保持不变。`k6 inspect` 的 full/calibration 输出已由独立 parser 和 fixture
验证单 scenario、阶段、VU 上限、连接复用、计数与阈值；runner API 非零的 fail-closed fixture
也已通过。以上是 source/fixture 证据，不是运行时容量证据；修复后未运行第三次负载，不能改变
当前 commercial gate 的 **FAIL** 结论。

## 结论

真实生产组合 focused smoke **PASS**。本次不再使用确定性 HTTP/WS mock harness，而是实际启动：

- 项目锁定并本地编译的 PostgreSQL 17.10；
- 三个 Indexer migration；
- 精确 100 markets / 100,000 listings；
- 真实 `PostgresEventStore`；
- 真实 Fastify API、Indexer scheduler 和 WebSocket stream 的 production entrypoint；
- 新鲜本地 Anvil RPC；
- 项目锁定 k6 1.8.0。

最终证据目录：
`reports/performance/production-smoke-real-pg-ws-smoke-20260808-r3/`。

这是低强度、短时 smoke，不是 500/2,000 RPS、10,000 WS 或 50 tx/s × 10 分钟的商业负载
验收。正式 schema-v3 full 已执行但失败；修复后候选 full 未执行，不得写成 commercial
load PASS。

## PostgreSQL 与数据身份

- PostgreSQL：`17.10`；
- 仅监听 `127.0.0.1:19432`；
- postmaster 启动时间晚于本次 `RUN_ID` 开始时间；
- 记录本次独立 system identifier 和 data directory；
- migration：`001_indexer.sql`、`002_settlement_evidence.sql`、
  `003_read_api_indexes.sql`，每项均记录 SHA-256；
- seed：100 markets、100,000 listings、每市场 1,000 listings；
- 五个必需读索引存在；
- 100k listing 代表性查询实际采用 `listings_vault_active_idx`；
- 原始 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 已保留；
- 完成后 `pg_ctl status=3`、`pg_isready=2`，三个测试端口均重新验证为空闲，临时 PG/build
  目录已删除。

## API 结果

production API 自检：

- `/healthz` PASS；
- `/readyz` PASS，且同时检查 PostgreSQL schema/index、RPC chain ID 和 scheduler health；
- markets page 返回 20 条；
- market detail 返回 seed 对象；
- 单市场 active listings page 返回 20 条；
- Prometheus 必需 Indexer/WS metrics 存在。

k6 低强度档：20 RPS × 3 秒。

| 指标 | 结果 |
|---|---:|
| planned/completed | 60 / 60 |
| 2xx | 60 / 60 |
| dropped | 0 |
| response / 5xx / transport error | 0 / 0 / 0 |
| p95 | 14.07 ms |
| p99 | 21.11 ms |
| max | 21.68 ms |

API smoke 的所有严格阈值均通过；样本规模不足以外推 500/2,000 RPS。

## WebSocket 结果

服务端实现并实际覆盖：

- `/v1/stream` 严格 chain/market subscription；
- versioned `ready` envelope；
- committed checkpoint fan-out；
- client message policy close；
- max payload / max connections / max buffered bytes；
- ping/pong heartbeat 与 timeout eviction；
- per-message compression disabled；
- current/accepted/rejected/closed/outbound metrics；
- shutdown close code 1001 和有界 drain。

production API 自检的 WS upgrade + protocol-ready latency 为 `3.314 ms`。

k6 低强度档：20 sessions，每条完整持有 3 秒。

| 指标 | 结果 |
|---|---:|
| sessions | 20 / 20 |
| 101 upgrade | 20 / 20 |
| protocol ready | 20 / 20 |
| full hold | 20 / 20 |
| upgrade / ready / hold failure | 0 / 0 / 0 |
| connect p95 | 5.35 ms |

该结果只证明 focused smoke；10,000 sessions × 60 秒尚无有效正式 PASS，仍必须由合格环境下
的新 schema-v3 full runner 实测。

## 执行中 fail-closed 记录

历史 smoke 目录没有覆盖或删除：

- `production-smoke-real-pg-ws-smoke-20260808/`：seed 自检要求 100 行小表也必须由 planner
  选择 Index Scan，校验过度严格，运行在 seed 阶段失败；修复为“五个必需索引存在，且 100k
  listing 热点查询必须实际走索引”，没有放宽任何商业负载阈值；
- `production-smoke-real-pg-ws-smoke-20260808-r2/`：60 个 API 请求中 3 个非 2xx，定位为 seed
  小写十六进制地址与 API EIP-55 标准化比较不一致；修正 seed 数据，并新增独立
  `cpredict_response_errors < 0.5%` 强制阈值，防止 4xx 被 5xx/transport 指标漏掉；
- `production-smoke-real-pg-ws-smoke-20260808-r3/`：上述两个问题关闭，真实组合 smoke PASS。

这些失败不能删除或重分类为 PASS。

## Full runner 状态（历史段落，已由顶部商用结论取代）

`scripts/load/run-full.sh` 已改为 schema-v3 production composition runner，具备：

- 独占 `RUN_ID`；
- k6/Anvil/Cast/PostgreSQL 版本与 SHA-256 锁定；
- API/PG/Anvil 端口占用和 PID 身份检查；
- 新鲜 PG data directory、system identifier、启动时间和精确 seed 证明；
- API/WS raw log、summary、validator exit 分离；
- `dropped_iterations == 0`；
- 2xx、5xx、transport 三类错误分别检查；
- 10k WS upgrade、protocol-ready、完整 hold 分别检查；
- PostgreSQL 和 API 优雅关闭；
- schema-v3 原子 stage manifest，aborted/running 默认失败关闭；
- synthetic Indexer 只作为 supplemental lane；
- 本地真实合约 chain lane 独立分类 submitted/included/outcome。

完整 full 已执行并失败；具体结果、runner 修复和证据边界以本报告顶部“商用门禁结论”为准。

## 证据索引

- `production-seed.json`
- `production-seed.json.query-plans.json`
- `production-seed.log`
- `production-api-smoke.json`
- `production-api-smoke.log`
- `k6-api-summary.json`
- `k6-api.log`
- `k6-websocket-summary.json`
- `k6-websocket.log`
- `postgres-initdb.log`
- `postgres.log`
- `postgres-shutdown.log`
- `anvil.log`
