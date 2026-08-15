# Cpredict 商业负载门禁修复记录（2026-08-12）

## 结论

保留的同机 schema-v3 商业负载结果仍为 **FAIL / NOT RE-RUN AFTER FINAL HARNESS FIX**。当前正式
闭合方式已升级为 schema-v4 三机证据，状态为 **NOT RUN**。本次没有执行正式 full，不能把
短校准写成 500 RPS × 5 分钟、2,000 RPS × 1 分钟、10,000 WS × 60 秒或 50 tx/s × 10 分钟
的商业验收 PASS。

新的 SUT/load/chain 拆分、host identity/fingerprint、生产 telemetry、事件延迟、reorg 和 Ed25519
聚合边界见[分布式商业负载系统实现记录](distributed-commercial-load-system-2026-08-12.md)。该系统的
静态/fixture 验证不会改写本报告的历史失败，也不会替代尚未执行的正式三机验收。

本次关闭了三个会导致错误结论的基础设施问题：

1. macOS sandbox 无法执行 `top` 时，preflight 以前退化为瞬时 load-average 判断；现在使用
   `os.cpus()` 两次采样计算 250ms CPU idle，原有 CPU ≥30% idle 门槛不变。
2. 旧 WebSocket 证据只证明 10,000 次客户端 iteration 各自 upgrade/ready/hold，不能证明曾经
   **同时**存在 10,000 条连接；现在服务端暴露进程生命周期内 peak gauge，full runner 在 k6 前后
   采集 accepted/rejected/current/peak counter，并要求 `peak=10,000`、accepted delta=10,000、
   rejected delta=0、最终 current=0。
3. k6 `ramping-arrival-rate` 在阶段边界按离散时间桶调度，墙钟 phase tag 会把少量请求移动到相邻
   阶段。最终 profile 不放宽负载：各稳定阶段额外运行 1 秒、transition 运行 2 秒；运行时要求总请求
   至少达到原始 271,250（短校准 76,250），每阶段仍至少达到原始
   150,000/1,250/120,000（短校准 15,000/1,250/60,000），并保留 0 drops、延迟和错误率原门槛。
   上界在 aggregate 施加，避免 phase 标签跨界造成假失败；`k6 inspect` 独立锁定完整 profile。

## 诊断短校准

两次短校准都由 preflight 判定安全，均使用真实 Fastify + `PostgresEventStore` + 新鲜
PostgreSQL 17.10 + 100 markets/100,000 listings + 新鲜 Anvil。两次 runner 都因当时的阶段计数
规则以非零退出，必须保留为诊断 FAIL，不能改名为 PASS。

| 运行 | 请求 | drops | 2xx 失败 | transport | p95 | p99 | runner |
|---|---:|---:|---:|---:|---:|---:|---:|
| `calibration-fix-20260812T0120Z` | 76,223 | 0 | 0 | 0 | 24.89ms | 89.29ms | FAIL (`99`) |
| `calibration-overprovisioned-20260812T0124Z` | 79,975 | 0 | 0 | 0 | 176.13ms | 367.13ms | FAIL (`99`) |

原始 k6 summary SHA-256：

- 第一次：`eef46e3109209a66c31d98a3e9f247908a465401a71cca0e03234af52e5d822a`；
- 第二次：`7effe98fce5ac0aefd02276a318fdd270227376125a8de0f1208251edc78deb1`。

第一次失败是 1 秒 transition 的离散调度使总量少 27；第二次已经超过原始最低总量 3,725，
但 14 个跨边界请求被归到 burst，触发当时的 per-phase upper bound。第二次的实际服务指标全部满足：

- steady 15,459（最低 15,000）；
- transition 2,502（最低 1,250）；
- burst 62,014（最低 60,000）；
- aggregate 79,975（最低 76,250）；
- 0 dropped iterations；
- 0 response/server/transport error；
- aggregate p95 176.13ms `<300ms`；
- aggregate p99 367.13ms `<750ms`。

最终 aggregate-upper-bound 修复后没有第三次重跑，遵守同类失败最多一次 materially-different retry
的 stop-loss。服务容量趋势明显好于 2026-08-08 的正式 FAIL，但不能替代 formal full。

## 历史同机 schema-v3 profile 和证据门禁

API full：

- 500 RPS 运行 5 分 1 秒，至少完成 150,000 请求；
- 500→2,000 RPS 线性 transition 运行 2 秒，至少完成 1,250 请求；
- 2,000 RPS 运行 1 分 1 秒，至少完成 120,000 请求；
- aggregate 在 `[271,250, 275,002]`；
- zero drops；aggregate 和所有 phase 的 p95 `<300ms`、p99 `<750ms`；
- response/5xx/transport error 均 `<0.5%`。

WebSocket full：

- 客户端恰好 10,000 iterations/sessions；
- upgrade、protocol-ready、完整 60 秒 hold 各自失败率 `<0.5%`；
- 服务端 before/after 证据必须同时证明 accepted delta=10,000、rejected delta=0、
  current=0、peak=10,000。

完整 full 还必须继续执行 100/100k synthetic Indexer lane 和本地真实合约 50 tx/s × 600 秒 lane。
任何阶段或 evidence validator 非零，后续阶段保持 `not_run`，runner 输出 `aborted/overall=1`。

## 验证

- `npm run check:offchain`：PASS。
- load validator/profile tests：10/10 PASS。
- `scripts/load/run-full-fail-closed.test.sh`：PASS。
- `bash -n`（full/smoke runner）：PASS。
- 真实 `k6 inspect` full/calibration profile parser：PASS。
- Fastify/WebSocket focused tests：7/7 PASS（需要允许本机 loopback bind）。
- 两次诊断运行完成后 19080/19432/19545 均可重新绑定：PASS。

## 未验证

- 最终 profile 的第三次短校准：按 stop-loss 未运行。
- 商业 full：未运行。
- 10,000 simultaneous WS：未运行；新增证据逻辑仅 static/focused verified。
- 50 tx/s × 10 分钟当前 schema-v3 lane：未运行。
- 分离负载发生器、生产 load balancer、多进程 API、远程 PostgreSQL/Base RPC：未运行。

以上未验证项现在必须由 schema-v4 分布式门禁关闭；再次执行本报告中的同机 runner 仍只能产生
诊断证据，不能生成正式商业 PASS。
