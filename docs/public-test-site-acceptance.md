# Cpredict 公开用户测试站验收记录

运行证据日期：2026-09-09；交付清单复核日期：2026-09-10。结论：**本地实现与验证已形成可审阅版本，公开发布尚未验收。** 本轮运行与开发依赖审计均归零，完整单元、数据库、浏览器和新的固定区块 Kernel 分叉检查通过。两个 Privy / ZeroDev 项目已分别通过 9 项只读预检；每环境 0.1 ETH 自然周预算已确认并实现。旧区块重跑暴露公共 RPC 历史状态缺失，另有供应商声明错误、后台硬上限、实际部署清单、USDC 验收资金和真实设备仍待解决；公开入口继续关闭。没有推送、发布、购买服务或向远端链广播交易。完整待办见 [剩余清单](public-test-site-remaining.md)。

本次实现在 `dev` 分支基线 `8d35cfa7fc5c6db12381c6d827b6c02cc316e202` 之后形成，测试证明对应文件摘要，不是该基线 HEAD 自身的通过证明。源码文件清单由 `manifests/source-manifest.json` 记录；本地报告、构建摘要与交付提交绑定在 `reports/generated/public-site/acceptance.json`，交付提交以 Git 历史为准。9 月 10 日复核未改变应用运行代码，提交准备仅更新交付文档和对应生成清单，保留前一日运行证据的日期。实际部署验收必须重新绑定配置与最终版本。

## 批次状态

| 批次 | 当前已有实现 | 尚未满足的完成条件 |
| --- | --- | --- |
| B0 | 独立用户站、冻结 SDK / Kernel 3.1 / EntryPoint 0.7、Zod 契约、双环境供应商配置与只读连接 | 实际部署与源码关系、完整运行配置及允许域名核对 |
| B1 | Privy 登录与官方钱包组件、ZeroDev 账户与交易、智能账户规则签名、严格代付准入、持久化操作与查询恢复、独立退出工具；本地分叉账户与回执集成通过 | 真钱包零 ETH 全流程、供应商回调实测、真钱包下 ERC-1155 单笔/批量收发、导出后独立控制 |
| B2 | 原索引器增量投影、权益并集、整数平均成本、费用与净收益、重放/重组、定向回补、链上对账与激活门槛 | 实际部署历史缺口回补、固定区块全额对账与激活 |
| B3 | 市场、资产、持仓权益、历史、创作者、排行、报表、帮助和反馈页面；本地桌面/手机视口检查 | 两类真钱包在桌面、iOS Safari、Android Chrome 的完整流程 |
| B4 | 固定市场名单、共同区块与版本化榜单、创作者控制关系排除、只读角色报表、原始供应商账期与单 UserOperation Gas | 实际名单、管理员与账单；供应商实际支出/策略证据接入与真实数据可追溯核对 |
| B5 | 构建、契约、迁移/回补/恢复命令、配置模板、反向代理模板、运行手册与本地验证 | 实际 USDC / ctUSD 联调、容量、监控、备份恢复、域名/HTTPS、明确发布授权 |

## 本地证据

| 验证 | 结果与范围 | 证据 |
| --- | --- | --- |
| 服务端与 SDK TypeScript | 通过，根项目维持完整库声明检查 | `offchain-build.log` |
| 用户站 TypeScript 与生产构建 | 通过；应用代码严格检查，第三方声明例外见下文 | `site-build.log` |
| 原开发者 Demo 构建 | 通过；旧入口仍独立构建 | `demo-build.log` |
| 全量 Vitest | 334 项通过、0 失败；30 项数据库测试在该命令中跳过 | `unit-full.json` |
| 公开站 PostgreSQL | 21 / 21 实际运行通过、无跳过 | `postgres.json` |
| 既有 PostgreSQL gate | 13 / 13 实际运行通过、无跳过；与上一行重叠 4 个索引器用例 | `legacy-postgres.json` |
| Kernel / EntryPoint 本地分叉 | 新固定区块 21 / 21 通过；官方 SDK、真实 EVM 执行、本地资金及代币夹具；旧区块重跑受 RPC 阻塞 | `kernel-fork-current-dependencies.json`、`kernel-fork-dependencies.json` |
| 回执修复回归 | 新增 2 项先失败后通过；回执及恢复共 11 项通过 | `receipt-before.log`、`receipt-after.log` |
| 共享契约 | `site:contracts:check` 核对 Zod 生成结果 | `generated/public-site/contracts.json` |
| 双环境配置 CLI | 本地夹具通过；拒绝环境混用、输出覆盖，不接触网络与数据库 | `config-cli.json` |
| 依赖安全检查 | 运行依赖和全量依赖审计均为 0 个已知告警 | `npm-audit.json`、`npm-audit-all.json` |
| 钱包依赖兼容性 | 5 / 5 通过；10 个实际 UUID 消费路径、ESM/CJS、安全边界和 WalletConnect 解析及共享 provider | `dependency-compatibility.log`、`dependency-tree-after.json` |
| 第三方声明诊断 | **失败，35 处上游声明错误**，不能记为全依赖类型通过 | `dependency-types.log` |
| 生成清单 | 使用既有 SBOM / artifacts 生成与校验命令；结果绑定当前文件摘要 | `artifacts.log`、`acceptance.json` |
| 提交范围空白检查（9 月 10 日） | 完整 `git diff --cached --check` 返回 7 处供应商许可原文尾随空格；归档与 3 个锁定包原文逐字节 hash 相同，故原样保留。除许可归档外的提交文件检查通过；不记为完整检查通过 | `commit-whitespace-review.json` |

上述报告路径相对 `reports/generated/public-site/`，除另行指定的生成契约。数据库两条通道合计覆盖全部 30 个不同数据库用例，不能把 21 + 13 当成 34 个不同用例。临时 PostgreSQL 使用已锁定的项目二进制，测试后已关闭并删除。

单元和数据库用例覆盖：严格业务白名单/授权对象/首次部署工厂、限额与身份隔离、重复提交与响应丢失、原操作恢复和重组、EOA/智能账户签名验证调用契约、完整 ABI 事件归一化、成本未知、托管、一次性败方损失、费用不重复扣、榜单并列/排除/更正、分页与快照失效。数值用例包括先实现 8、领取后累计 43，以及折价买入作废退款。金额全程整数；这些证明不代替真实合约执行。

新增恢复用例区分普通 RPC 故障与已知重组：网络故障保留已确认结果；回执缺失或区块不再规范时回到结果未知，保留原 UserOperation hash，仅查询、不重发。过期且从未提交的操作才可取消。

新增配置与预算用例覆盖：未填写 WalletConnect ID 时使用 Privy 默认；同一 ZeroDev RPC 可用于 Bundler/Paymaster，但错误项目或链被拒绝；缺少硬预算不启用代付；无效整数返回 Zod 校验结果，不抛 BigInt 转换异常。自然周测试包含精确边界、跨年、跨日累计、并发预留、双环境隔离、退出专用额度、每日限制继续生效和跨周未决预留。数据库报表与准入使用相同周统计口径。

## 供应商配置与只读实测

`cpredict-dev` 对应 ctUSD，`cpredict-prod` 对应 USDC，均为 Arbitrum Sepolia 421614。已确认每环境每周各 0.1 ETH，北京时间周一 00:00 重置，分为 0.08 ETH 新增操作与 0.02 ETH 退出。该决定与服务器预算实现不等于供应商后台硬上限已配置。

两个环境分别通过 9 项只读检查：Bundler 链 ID、EntryPoint 0.7、Paymaster RPC 链 ID、Privy 服务端认证、Privy 公开签名密钥，以及链读取节点的链 ID、区块、固定区块存储和 EntryPoint 字节码。最新报告位于 Git 忽略的 `runtime/public-site/{ctusd,usdc}-provider-readonly-v2.json`，原 5 项检查报告保留。Bundler 与 Paymaster 共用各自项目的官方 RPC；预检没有请求赞助、签名或发送交易。

直接 RPC 请求和 Anvil 均复现：已提供的 ZeroDev 端点对 `latest` 存储读取成功，对指定历史区块的 `eth_getStorageAt` 返回 HTTP 400，错误将区块号识别为 chain ID。增强预检在修正前明确失败，见 `runtime/public-site/ctusd-chain-preflight-before.json`；不能把原来的 5/5 解释为完整链读取兼容。两个本地运行草稿只将 `CPREDICT_APP_RPC_URL` 改为 Arbitrum 官方公共读取节点，供应商项目、认证、预算及开关不变。公共节点用于当前低量联调，持续运行的可用性、容量和历史覆盖仍需另行验收。

凭据已保存为 `runtime/public-site/.env.cpredict-dev` 和 `.env.cpredict-prod`，权限 0600；精确值扫描未在 Git 交付文件中发现匹配。Vite 私有文件路径实测返回 HTTP 403。`walletConnectProjectId` 改为可省略，使用 Privy 应用配置或 SDK 默认值；手机外部钱包入口保留，真实连接仍待验收。

## 固定区块本地 Kernel 集成

分叉源为 Arbitrum Sepolia 区块 `307080287`，hash 为 `0x20a266e487f1ab3d8adc8a092a34582143a34b6608c46e70de067c6fd7425f60`。使用锁定的 Anvil、Kernel 0.3.1 / EntryPoint 0.7 与官方账户 SDK；报告绑定测试脚本、锁文件、所执行 JavaScript 和 Solidity 夹具产物的 SHA-256。上游只读，签名和交易仅发生在临时回环节点；退出后移除节点与临时缓存。

上述为回执修复批次的首次通过证据。本轮在最终依赖下重跑该旧区块，公共 RPC 返回 `metadata is not found, 307045197`；短 slot 与 32 字节 slot 都复现，记录在 `pinned-storage-diagnosis.json`，尚未进入本地交易阶段。随后另取并固定区块 `307102737`、hash `0xea49a8a53179edb9c069ac68f8d74c0099eea573dc88f89d26003002b6449c15`，21 项全部通过，记录为 `kernel-fork-current-dependencies.json`。这是新快照的当前依赖验证，旧快照重放仍被阻塞，不能解释为公共节点拥有可靠历史覆盖。

覆盖固定 index 1001 / 1002 的稳定派生和隔离、未部署 ERC-6492 与已部署 ERC-1271 通过实际规则发布接口、规则哈希错误与 challenge 重放拒绝、首次部署、实现/validator/hook/控制者校验、ERC-1155 单笔/批量接收及转出、6 位整数支付资产转出、相同 UserOperation 以 AA25 明确拒绝、失败操作与成功 bundle 区分及失败后余额不变。

分叉首次暴露的应用问题已修复：viem 按事件 topic 解码完整 ABI，传入 `eventName` 不能过滤运行时结果。`AccountDeployed` 和 `UserOperationRevertReason` 也带同一 userOpHash，原逻辑误计为重复结果，导致成功的首次部署或实际回滚无法归类。现在明确要求解码名称为 `UserOperationEvent`，同时保留精确 hash / sender / nonce / 唯一事件校验。两个新增用例修复前失败，修复后通过；最终分叉分别实证成功和回滚路径。服务端恢复及独立恢复页面共用该修复。

控制者与应用账户的 ETH 余额均为零，但 Gas 来自本地 relayer 注入的 EntryPoint 存款，**不证明 ZeroDev 托管代付**。ERC-20 为本地 `MockUSDC`，不是 Circle 测试 USDC；临时密钥也不替代 Privy、真实浏览器钱包、移动设备或导出恢复验收。最终 21 项通过报告为 `kernel-fork-verified.json`。前序 429、固定区块 RPC 不兼容、回执误判以及一次复跑前的读取内部错误记录均保留；后者的上游具体原因未证实，不把复跑成功称为公共 RPC 可用性保证。

本轮使用 Vitest 4.1.11 重新运行全量 334 项单元和两条实际数据库通道（21 / 21、13 / 13，覆盖 30 个不同用例），没有数据库跳过；普通全量命令中的 30 项跳过与专用数据库报告分别记录。服务端、用户站、开发者 Demo 构建及共享契约检查均通过。

## 浏览器实际检查

首次工具为本机 Codex 内嵌浏览器。本轮使用现有 Playwright / Chrome 进行独立临时会话复验：生产构建的根入口与 `recovery.html`，以及开发服务单独的 `/test/browser/fixture.html`。业务夹具带显著标记，钱包与 API 为测试上下文，不能签名或发送交易，该 HTML 未纳入生产构建。以下均为**页面验收，不是真钱包验收**；本轮临时自动化检查也不等于完整的持续浏览器回归套件。

新一轮桌面 1280 × 900 与手机视口 390 × 844 共 14 项通过：关闭的真实公开入口、独立恢复页、市场跳转和空池、确认金额与资产归属、取消后焦点恢复、账户切换关闭旧确认、规则失败阻止购买、无横向溢出及运行异常。已检查两种视口截图。初跑流程通过，但发现缺少 favicon 导致 3 个 404；补齐图标并纳入源码清单后复跑，console error/warn 均为 0。报告为 `dependency-browser.json`，原失败及请求定位记录保留为 `dependency-browser-before-favicon.json` 和 `dependency-browser-404.json`。临时浏览器及服务均已关闭。其余首次页面观察如下：

- 桌面 1280 × 720：市场列表、搜索空结果及键盘清除、市场深链接、空池不展示赔率；创建表单、资产、历史、权益、排行等待、后台无权限、帮助与反馈表单正常呈现。
- 购买 10 ctUSD 的确认展示结果、最多支付、最少份额、控制钱包/资产账户、费用与待代付状态；未点击实际签名。
- 规则查询失败后新增购买禁用，并明确保留领取、撤单与终局份额取回；未实际执行退出。
- 零持仓早鸟权益关联未知操作，可进入原操作详情；详情没有重发按钮。关闭后焦点回到“查询原操作”。
- 在确认弹窗打开后切换夹具账户，旧确认自动关闭。资产地址与余额随账户切换，慢响应期间先显示未知，随后显示新账户余额，不保留旧余额。
- 手机视口 390 × 844：检查确认弹窗、资产与反馈页面、菜单打开与切页关闭；读到 documentWidth = viewportWidth = 390，无横向溢出，焦点回到主要内容。已直接检查截图。
- 刷新后台深链接后显示中文权限提示；最终刷新检查未出现新增 console error/warn。开发中发现的 HMR 重复 createRoot 与旧上下文错误经入口修复和刷新后消失；历史日志仍保留，不能称整个开发会话没有错误。
- 未提供配置的真实首页显示“公开测试站尚未开放”，没有可交易环境；独立恢复页面可读说明及输入恢复配置，未连接真实钱包。

未验证：手机实体设备、外部钱包跳转返回、OAuth 回调、钱包导出、真实交易确认/资金到账、浏览器压力和各钱包兼容性。手机视口不能覆盖这些条件。

## 上游依赖与发布阻塞

固定采用 Privy 3.40.0、ZeroDev SDK 5.5.10、ECDSA validator 5.4.5。账户派生参数与依赖版本分开固定。没有改写供应商内部实现、伪造 SDK 声明或自研账户协议。

Privy 发布的声明引用缺失名称，相关 ofetch/x402 声明也不能在严格依赖检查中通过。本轮额外下载并校验官方 3.41.0 包的 SHA-512，仅隔离检查发布文件，仍发现 `SOLANA_CHAINS`、`EmbeddedSVG`、`RecoveryMethod` 等缺失引用及不存在的配置字段，因此保留 3.40.0；没有将 3.41.0 安装或称其完整类型测试通过。记录为 `privy-3.41-review.json`。独立浏览器项目的 `skipLibCheck` 只影响第三方声明；服务器与应用源代码仍检查。`site:check:dependencies` 重新执行仍失败 35 处，需供应商修复或经验证的兼容正式版本才能关闭此项。

此前限定更新 Fastify 5.12.3、axios 1.18.0、fast-uri 3.1.6 / 4.1.3、ws 8.x 到 8.21.0。本轮继续解决剩余运行依赖告警，运行与全量 npm 审计均归零；没有执行 `npm audit fix --force` 或回退钱包 SDK：

1. WalletConnect 的旧分支通过版本覆盖统一使用已存在的 2.22.4，移除旧 query-string / decode-uri-component；没有将 ESM 解码包直接塞入 CommonJS 调用方。[原问题公告](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr)。配对字段、编码内容及畸形编码在实际 CJS 和浏览器 ESM 模块上通过测试。
2. UUID 8/9 统一到保留 Node/浏览器 CJS 与 ESM 的 11.1.1。[修复版本](https://github.com/uuidjs/uuid/releases/tag/v11.1.1)。测试从 10 个实际消费包分别解析 UUID，验证 v4/校验/字节往返及 v3/v5/v6 输出 buffer 的边界拒绝和数据不被修改。
3. 全量审计另发现 Vitest 开发依赖的文件读取问题，已升级到 4.1.11，并重新执行全量单元和两条数据库测试通道。[官方安全公告](https://github.com/advisories/GHSA-82fw-gwwq-j7x9)。Vite 仍为 8.2.1，未引入 DevTools 或额外浏览器工具。

npm 10.9.7 初次覆盖保留了旧嵌套副本，后续更新 Vitest 又在可选 peer 循环中报内部错误。经隔离锁文件和现有解析器源码检查，覆盖规则同时包含旧版与替换版，并把 Vite/Vitest peer 约束到项目既定版本后，安装树校验通过。锁文件均由 npm 生成，没有清库式重建或手工篡改依赖内容。WalletConnect/UUID 改动共移除 81 个旧或重复包，Vitest 补丁同时更新其组件及源码映射依赖；主钱包 SDK、账户版本及派生 index 不变。

依赖审计归零只覆盖当次公告数据库中的已知问题，严格声明失败仍是**公开启用前未关闭的工程问题**。另有用户站 SDK chunk 与既有 Demo 大于 500 kB 的构建提示；没有通过提高警告阈值消除提示，真实移动网络性能仍待测量。

首次 SBOM 生成因 SDK 包缺少标准 license 字段而失败。已归档锁定包随附的声明文本，以版本、integrity 和文本 SHA-256 绑定 `manifests/npm-license-evidence.json`：33 个包保留原自定义 LicenseRef；Privy api-base 的 Apache-2.0 与 XMLHttpRequest 的 MIT 来自随包声明；`@metamask/eth-json-rpc-provider@1.0.1` 没有可用声明，保持 `NOASSERTION` / `missing-license`，没有代填 MIT。后续版本或证据变化必须重新核对，不能沿用旧条目。SBOM 结构及来源校验与发布许可判断分开；自定义条款及缺失声明的分发适用性仍须在公开发布前解决，不代表已接受供应商条款。

## 真实环境的下一步

仍有明确工程和运行接入工作：供应商实际支出/预算与策略核验未接入（当前 `providerSpendUsd` 为未知、`providerPolicyVerified` 为 false）；新服务的实际编排/监控、持续浏览器回归及移动性能验收尚未完成。RPC、链头和索引延迟已由报表路由实际查询，不属于固定占位字段。以上与 35 处上游声明及许可问题分别记录，不能将剩余工作概括为“只差填写配置”。

Privy / ZeroDev 凭据与周预算已经提供，无需重复索取，也无需先创建自有 WalletConnect 项目。仍需要本次应使用的协议部署 manifest / code hash、允许域名与 OAuth、隔离数据库、供应商硬上限与 Custom Policy 验证、USDC 测试资金、管理员和榜单市场。本地现有旧 sandbox 部署记录不能自动视为本次双环境的完整清单；运行草稿中的未核实字段保持占位符。修复或经验证地解决上述依赖阻塞后，按运行手册继续联调。

每个环境分别保留：邮箱/Google/外部钱包 → 两个地址均无 ETH 的首次部署与测试资产准备 → 授权和购买 → 挂单/部分成交/撤单/终局取回 → 创建/结算/作废 → 赢家/早鸟/退款/超时补偿/押金/费用领取 → 转出 → 应用/供应商中断时独立退出的证据。每条记录源码、部署、设备钱包、账户、前后余额、业务 ID、UserOperation、交易 hash 与确认区块。USDC 不开放 ctUSD 铸币入口，需独立测试资产来源。

链上对账、容量、监控、真实备份恢复、nginx 渲染及 HTTPS 尚未执行。代理模板仅供目标确定后渲染，旧 Demo 跳转原站以保留原资源/API。先完成真实验收和发布准备，再取得明确目标的发布授权；当前没有公开 URL 或已上线交付物。
