# Solidity Coverage 发布门禁报告

日期：2026-08-08  
工具：Foundry `1.7.1` (`4072e48705af9d93e3c0f6e29e93b5e9a40caed8`)  
结论：无 suite/path 排除的正式 runner 通过；`src/**` lines/functions/branches 分别为
`1017/1017`、`151/151`、`227/229`，满足 `100%/100%/>=95%`。

## 1. 正式命令和编译 lane

```bash
bash scripts/coverage-full.sh
```

runner 固定执行：

```bash
FOUNDRY_PROFILE=non_ir bash scripts/forge.sh coverage \
  --report summary \
  --report lcov \
  --report-file reports/coverage/full.lcov
```

runner 为每次正式执行创建完整的临时项目副本，并确认副本内不存在 `out/` 或 `cache/`；
Pinned `lib/**` 依赖复制进副本以保持 Foundry auto-remapping 语义，固定工具链从原仓库
挂载，但不读取原仓库已有 artifact/cache。coverage 前显式构建仅由 `vm.getCode` 引用的
pinned Permit2 0.8.17 artifact，避免缓存偶然存在时假通过；
退出时只清理经过路径前缀校验的本轮临时副本。

该命令未使用 `--match-*`、`--no-match-*`、`--exclude-tests`、
`--no-match-coverage`、LCOV remove 或 `coverage-ignore`。Foundry coverage 会禁用 optimizer
和 viaIR，以生成更准确的 source map；全项目的 scripts、src、tests、invariant、Echidna 和
SMT harness 均进入同一编译与原始 LCOV 分母。

生产构建仍固定使用 `foundry.toml` 的 `via_ir = true`、optimizer runs 200；它与 coverage
证据是两个独立门禁。正式 runner 在 coverage 通过后执行
`bash scripts/forge.sh build --force`，随后显式构建仅由 `vm.getCode` 引用的 pinned Permit2
0.8.17 artifact；原始日志保存在 `production-viair-forced-build.log`，同时确保协议
临时副本的 `out/**` 恢复为生产编译配置并保留 Permit2 集成测试所需 artifact。

随后同一 isolated artifact 集执行 `bash scripts/forge.sh test --match-test '^testGasGate'`；
10/10 production-context gas/size tests 通过，证明 coverage context guard 没有关闭普通
production-viaIR 测试中的硬断言。

## 2. 测试结果

- 20 个 Foundry test suites；
- 121/121 tests passed，0 failed，0 skipped；
- 117 个 deterministic tests；
- 4 个 invariant properties，各 1,000 runs、128,000 calls、0 reverts；
- runner exit code：`0`。

gas 测试在 coverage context 中仍执行完整目标交易并记录测量值。因为 coverage 使用的
unoptimized bytecode 不代表生产 gas/size，测试通过 Forge 原生
`vm.isContext(VmSafe.ForgeContext.Coverage)` 仅关闭 optimizer-sensitive 数值断言；独立
production-viaIR gas runner 继续对原硬阈值 fail closed。没有跳过 gas suite 或目标调用。

## 3. 最终覆盖率

| 范围 | Lines | Functions | Branches |
|---|---:|---:|---:|
| raw/unfiltered | 1,210/1,507 (80.29%) | 197/243 (81.07%) | 242/315 (76.83%) |
| `src/**`，来自同一 LCOV | 1,017/1,017 (100.00%) | 151/151 (100.00%) | 227/229 (99.13%) |

raw 数值如实包含不会由 Foundry 单元测试执行的部署脚本、Echidna/SMT harness 和测试辅助
合约；发布门禁只读取同一份未改写 LCOV 的 `SF:src/**` 记录，不删除 raw 分母。

## 4. 补齐的真实行为证据

`test/unit/CoverageCompleteness.t.sol` 增加三个直接行为测试：

1. 直接从 public ABI 调用 `MarketFactoryV1.dependencyFingerprintFor`，并与当前 wiring 的
   `dependencyFingerprint()` 对照；
2. 通过 ALICE 的 low-level call 触发 Factory `onlyGovernance`，核对完整
   `Unauthorized(ALICE)` revert data 和状态不变；
3. 通过 ALICE 的 low-level call 触发 Config `onlyGovernance`，核对完整 revert data 和
   creation fee 不变。

最终 LCOV 没有未命中的 `src/**` line 或 function。仅剩的两个 branch record 是
`MarketFactoryV1.sol:118` 和 `ProtocolConfigV1.sol:63` 的 modifier revert branch；上述
low-level tests 已直接证明两条 revert 路径执行，但 Foundry 仍将 modifier/revert source-map
记录为 0。该工具限制没有被伪造成命中；`227/229 = 99.13%` 仍高于既定 95% 门槛。

## 5. non-IR 可重复性修复

`DeployBaseSepolia.run()` 原先在 coverage 的 unoptimized non-IR 编译中发生 stack-too-deep。
部署 Factory 和调度 bootstrap 被拆为两个 internal helper，保持：

- 合约部署顺序不变；
- 所有 constructor arguments 不变；
- fingerprint 计算、require 和 Timelock schedule batch 不变；
- broadcast 边界、manifest 字段、事件和日志不变。

该调整随后通过 unoptimized non-IR 全路径 coverage 编译和 forced production-viaIR build。

## 6. 原始证据和 SHA-256

- `reports/coverage/full.lcov`：原始未过滤 LCOV；
- `reports/coverage/full.summary.txt`：完整编译、suite、原始表、`src/**` 表和 exit code；
- `reports/coverage/production-viair-forced-build.log`：coverage 后的 production-viaIR
  forced build 原始日志；
- `reports/coverage/production-gas-assertion-check.log`：同一 isolated artifact 集的
  production-context gas/size assertion 原始日志；
- `reports/coverage/full.sha256`：以上证据及本报告的 SHA-256 清单。

runner 在写入最终 exit code 后生成 `full.sha256`；使用
`shasum -a 256 -c reports/coverage/full.sha256` 可复核全部证据。

只有 coverage、forced production build、production gas assertions 和 SHA 自校验全部通过
后，runner 才把完整证据集 staged 到原仓库，并最后移动 `full.sha256` 作为发布完成标记；
失败运行不会用半成品覆盖上一次正式证据。

## 7. 证明边界

本报告证明当前本地候选的 Foundry coverage 门禁和 forced production-viaIR build；不据此
推导静态分析、形式化验证、mutation、外部审计、Base Sepolia 或主网运行时已经通过。
