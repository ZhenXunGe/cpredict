# Cpredict 本地负载验收报告（2026-08-08）

> **OBSOLETE / 历史候选。** 本报告保留旧 harness 的 741 drops、9,351/10,000 WS 和历史 Anvil
> 结果用于复盘，不代表当前候选。当前正式 schema-v3 结果见
> `reports/performance/production-composition-smoke-2026-08-08.md`；跨域总状态只以
> `docs/zh/00-delivery-status.md` 为准。

## 结论

完整本地档已实际执行到结束。真实协议 Anvil 50 tx/s × 10 分钟和
100 markets / 100,000 listings 的 ChainIndexer 合成摄取通过；API 延迟及错误率通过，
但出现 741 个 dropped iterations；10,000 WebSocket 升级成功率只有 93.51%。因此本地负载
总门禁为 **FAIL**，不得表述为商业容量验收通过。

本报告严格区分以下证明范围：

- API/WS 是本仓库的确定性查询参考 harness，不是生产 API；
- Indexer 使用仓库真实 `ChainIndexer`，但 RPC client 和 store 是确定性合成实现，不是
  PostgreSQL 或 Base RPC；
- 链上阶段使用本次工作区真实 Foundry artifacts，部署到全新本地 Anvil，并调用真实 Full
  Market 的 `buy`；它不证明 Base sequencer、远程 RPC 或生产 finality。

## 工具与执行环境

最终运行目录：`reports/performance/full-20260808T013000Z-final/`

- k6 `v1.8.0`, commit `23d89b9b7c`, project-local `.tools/k6/k6`；
- k6 archive SHA-256：
  `6869e9ebdf51f7450c9ba160b5d0aa0d7224186d976bc0bc8e7ead91a7104cce`；
- k6 binary SHA-256：
  `99e584cda860798dbe830f05be3f79fded7da275cd9bf669b7482cdca458423f`；
- Anvil `v1.7.1`, commit `4072e48705af9d93e3c0f6e29e93b5e9a40caed8`；
- Node `v22.22.2`；
- 10 logical CPUs、16 GiB memory、file descriptor limit 1,048,575；
- 最终启动 preflight：system memory free 25%、CPU idle 46.53%、load average
  `7.25 / 9.89 / 11.14`，安全门禁通过。

锁定信息见 `manifests/load-tools.lock`。

## 完整档结果

| 阶段 | 实际工作量 | 结果 | 关键证据 |
|---|---:|---|---|
| API steady + burst | 500 RPS × 5 min；2,000 RPS × 1 min | **FAIL** | 269,261 requests；741 dropped；0 5xx；0 transport error；p95 4.912 ms；p99 `<750 ms` threshold pass，但本次 legacy JSON 未输出精确 p99 |
| WebSocket | 10,000 concurrent connection attempts（VUs），目标 hold 60 s | **FAIL** | 9,351 upgrade pass；649 fail；success 93.51%；要求 ≥99.5%；connect p95 8,308.456 ms |
| Indexer | 100 markets + 100,000 listing events | **PASS（合成 lane）** | 100,100/100,100 events；11 batches；p95 28.625 ms；synthetic lag 0 blocks |
| Hot Full Market | 50 submitted tx/s × 600 s | **PASS（本地 Anvil lane）** | 30,000 submitted；30,000 included；28,500 success；1,500 expected revert；49.999 submitted/included TPS |

阶段退出码：

```json
{
  "api": 99,
  "websocket": 99,
  "typescript": 0,
  "indexer": 0,
  "chain": 0,
  "overall": 1
}
```

### API 解释

- 计划 arrival 总量约 270,000，实际完成 269,261，另有 741 dropped iterations；
- combined achieved rate 为 747.925 requests/s；
- HTTP error rate、5xx rate、transport error rate均为 0；
- p95 4.912 ms，max 459.892 ms；
- `p99 < 750 ms` threshold 未被触发，但此次运行发生在增加 `summaryTrendStats.p(99)` 之前，
  JSON 不含精确 p99，不能从其他分位数反推；
- `dropped_iterations == 0` 被触发，因此即使延迟和错误率良好，该阶段仍然失败。

### 10,000 WebSocket 解释

- k6 实际启动 10,000 VUs / sessions；
- 9,351 个返回预期 101 upgrade，649 个失败，失败率 6.49%；
- 连接 p50 781.867 ms、p95 8,308.456 ms、max 8,428.884 ms；
- 成功连接大部分保持约 60 秒；失败或延迟 iteration 最短约 8 秒；
- `upgrade failure rate < 0.5%` 门禁失败。

### Indexer 解释

- 实际执行仓库 `ChainIndexer.runBatch()`；
- deterministic client 按 100 events/block 流式生成数据，避免将 100k 数据一次性驻留内存；
- counting store 只验证摄取数量、checkpoint 和 batch 边界；
- 756,434 synthetic events/s 不能作为 PostgreSQL、Base RPC 或生产 Indexer 指标；
- 生产 `provisional lag <= 2 L2 blocks` 仍未验证。

### 本地链交易分类

| 分类 | 数量 |
|---|---:|
| planned | 30,000 |
| submitted | 30,000 |
| included | 30,000 |
| success | 28,500 |
| expectedRevert | 1,500 |
| rejectedSubmission | 0 |
| unexpectedRevert | 0 |
| unexpectedSuccess | 0 |
| missingReceipt | 0 |

- elapsed 600.009 s；submitted TPS 49.999；included TPS 49.999；
- submission RPC latency：p50 1.045 ms、p95 3.756 ms、p99 18.2 ms；
- inclusion latency：p50 508.65 ms、p95 957.688 ms、p99 997.657 ms；
- 每 20 笔中 1 笔故意使用无效 outcome，所有 1,500 笔都以 receipt status=reverted 正确归类；
- 该结果没有把提交量冒充链上确认量，但只证明本地 Anvil 控制链。

## 执行中发现并修复的测试基础设施问题

第一次 full 尝试保存在 `reports/performance/full-20260808T011800Z/`。动态 URL 参数进入
k6 系统 `url` tag，约一分钟生成超过 200,000 个 time series。为避免负载发生器本身耗尽内存，
该次被主动终止。修复包括：

- URL 归组为固定 `dataset / markets / listings` name；
- 从 system tags 移除动态 `url`；
- 保留 endpoint、status、method、scenario 等低基数维度；
- smoke VU 预分配按请求速率计算；
- full runner 在单阶段失败后继续收集后续阶段并写入独立 exit code。

修复后 500 RPS × 15 秒校准保存在
`reports/performance/k6-smoke-prealloc-fix-20260808T012700Z/`：7,501 requests、0 drops、
0 errors、p95 1.81 ms，并且没有高基数警告。

最终 full 中仍有 741 drops，说明共享工作站在六分钟持续档中存在调度抖动；该结果没有通过调宽
threshold、删除 drop 检查或再次重跑来掩盖。

历史 full 完成后，未来 runner 又增加了：WebSocket 完整持有 60 秒门禁、k6 version/SHA 锁定、
端口预占与子进程身份检查、独占 RUN_ID 目录，以及 schema v2 的 fail-closed 阶段清单。这些是测试
基础设施加固，**没有重跑本表的完整负载**，因此不能改变 API/WS 的 FAIL 结论；历史 schema v1
证据仍按其原始边界保留。

## 尚未验证与下一步

以下工作仍是商业上线前置条件：

1. 在独占或分布式 k6 runner 上重复 500/2,000 RPS，保持 `dropped_iterations == 0`；
2. 调整和验证生产 WebSocket accept backlog、worker/进程数、连接建立速率及 load balancer，达到
   10,000 connections、upgrade success ≥99.5%；
3. 对真实部署 API、PostgreSQL、缓存、RPC 和生产 Indexer 执行相同数据集；
4. 在 Base Sepolia 只做低速真实 smoke，不把本地 50 TPS 结果外推到 Base；
5. 对真实事件投递链路验证 event-to-client p95 `<2 s`；本次 deterministic harness 未测该指标；
6. 未来 k6 runner 已配置 p99 明确导出，并会把 stdout/stderr 保存为 `k6-api.log` 和
   `k6-websocket.log`。本次 full 的 k6 阶段在这些增强前执行，仅留有 summary JSON 和阶段退出码；
   Indexer、Anvil 和 harness 仍有各自证据文件，未伪造缺失的 k6 原始日志。

## 证据索引

- `reports/performance/full-20260808T013000Z-final/preflight.json`
- `reports/performance/full-20260808T013000Z-final/k6-api-summary.json`
- `reports/performance/full-20260808T013000Z-final/k6-websocket-summary.json`
- `reports/performance/full-20260808T013000Z-final/indexer.json`
- `reports/performance/full-20260808T013000Z-final/chain.json`
- `reports/performance/full-20260808T013000Z-final/read-api.log`
- `reports/performance/full-20260808T013000Z-final/anvil.log`（包含 1,500 条预期 revert 的原始节点日志）
- `reports/performance/full-20260808T013000Z-final/stage-exit-codes.json`
- `reports/performance/k6-toolchain.json`
- `manifests/load-tools.lock`

`anvil.log` 原始文件含 PTY 产生的 NUL padding，仍按 13,764,695 bytes、SHA-256
`57cfc5dcf04555326a20e9b5f98375193fefa0848fe48b801ca0b36c5bf968e3` 原样保留。
`manifests/binary-evidence.lock` 只允许对该精确 path/size/hash 移除 NUL 后做严格 UTF-8 secret scan；
任何字节漂移、其他二进制或未扫描文件都会失败关闭。
