# Cpredict 公开测试站运行与验收

本次交付包含本地实现和运行工具。两个供应商项目已完成只读连接和 Privy 服务端认证检查；没有操作现有部署或发布站点。真实钱包、代付、USDC、移动设备及域名验收必须绑定最终源码与实际环境，不能用浏览器夹具代替。

## 代码与构建

- `examples/user-site` 是独立 React/Vite 入口；开发者 Demo 继续使用原构建。
- `offchain/app-core` 是账户、业务调用、账本、报表和前后端 Zod 契约。
- `offchain/app-service` 使用 Privy 身份验证、ZeroDev 官方 SDK、持久化操作登记、准入、恢复和只读报表。
- `offchain/indexer` 继续负责原始事件摄取；第 006 号迁移提供影子财务投影、账户定向回补、榜单和对账证据。
- `recovery.html` 可独立保留和托管；通过外部控制钱包、独立 RPC/Bundler 与固定账户版本退出。应用账户需要 ETH 自付网络费用，每笔重新确认，不扣 USDC 作为 Gas。

使用现有 Node 22/npm 工具链，在仓库根目录运行：

```sh
npm ci --ignore-scripts
npm run build:offchain
npm run site:contracts
npm run site:contracts:check
npm run site:build
npm run demo:build
```

浏览器代码保持严格类型检查；Privy 发布包内部声明存在已复现的上游错误，`site:check:dependencies` 当前失败。`site:check` 仅跳过第三方声明检查；不使用自定义钱包实现或伪造 SDK 声明。具体版本由 package-lock 锁定，Kernel 0.3.1 / EntryPoint 0.7 与账户 index 不随前端升级变化。

依赖安全补丁将旧 WalletConnect 分支统一到已有的 2.22.4，将 UUID 统一到保留 CommonJS/ESM 的 11.1.1；Vitest 使用 4.1.11。版本覆盖范围包括替换后的版本，使 npm 能正确移除旧嵌套副本。Vite/Vitest 的覆盖值与直接依赖保持一致，避免可选 DevTools peer 解析时引入另一套测试工具；升级时须同步核对这两处。不要删除锁文件、跳过 peer 校验或手改 `node_modules` 来消除冲突。执行 `npm ls --all`、`site:test:dependencies` 和完整依赖审计，分别确认安装树、实际模块兼容性和已知漏洞。

## 双环境配置

从 `deploy/public-site/{ctusd,usdc}.runtime.example.json` 分别创建私有运行文件。模板中的 `CONFIGURE_` 是必填占位符，不能启动。`runtimeCodeHashes` 须包含当前环境 Factory、Marketplace、BondEscrow、FeeVault、支付资产五个地址的小写键和实际 keccak256 runtime code hash。应用启动时核对链 ID、字节码、依赖连接与 decimals；USDC 地址必须与 Circle Arbitrum Sepolia 测试代币一致。

各环境必须使用独立：数据库或 schema、部署 ID/manifest、Privy 项目、ZeroDev 项目、固定账户 index、路由前缀、预算与缓存。运行配置不接受只靠相同 chainId 区分环境。连接字符串和供应商凭据通过服务环境注入，不写入 JSON、前端或日志。

2026-09-09 用户确认的供应商映射如下；`prod` 是供应商项目名，两个环境都只连接 Arbitrum Sepolia 421614。

| 供应商项目名 | 产品环境 | 本地服务端变量文件 | 私有运行草稿 | 固定账户 index |
| --- | --- | --- | --- | --- |
| cpredict-dev | ctUSD 公开测试 | runtime/public-site/.env.cpredict-dev | runtime/public-site/ctusd.runtime.json | 1001 |
| cpredict-prod | USDC 验收 | runtime/public-site/.env.cpredict-prod | runtime/public-site/usdc.runtime.json | 1002 |

这些本地文件被 Git 忽略、权限为 0600，Vite 拒绝访问 runtime 目录。凭据文件只供 Node 服务端加载，不复制进站点构建。运行草稿仍保留尚未核实的部署占位符，所有交易功能开关保持关闭。不要将供应商连接成功等同于运行配置完整。

Bundler 和 Paymaster 可以使用同一条官方 ZeroDev RPC；服务器启动会检查 URL 中的 projectId 与 chainId 是否与该环境一致。[ZeroDev 官方示例](https://docs.zerodev.app/get-started/quickstart)。`walletConnectProjectId` 现在可省略：Privy 3.40.0 的配置顺序为显式值、Privy 应用配置、SDK 默认值；不把 SDK 默认 ID 固化进本项目。外部钱包使用 MetaMask、官方检测入口和 WalletConnect 列表，Rabby 桌面通过检测入口验收，不使用已弃用的 `rabby_wallet` 标识。[Privy 官方连接说明](https://docs.privy.io/wallets/connectors/setup/configuring-external-connector-wallets)。手机真实连接仍未验收。

`CPREDICT_APP_RPC_URL` 是独立的完整链读取服务，必须验证指定区块的 `eth_getStorageAt`，不能仅检查链 ID 或自动复用 Bundler URL。本次提供的 ZeroDev 端点在该方法的历史区块参数上返回 HTTP 400；两个本地草稿已使用 `https://sepolia-rollup.arbitrum.io/rpc` 做低量联调。[Arbitrum 官方链信息](https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info)。索引、规则验证及维护服务也必须使用经验证的链读取配置；公共节点不是生产可用性、容量或全历史覆盖承诺，发布前仍需独立验收读取服务。

应用进程使用 `.env.example` 中的 `CPREDICT_APP_*`；索引器使用已有变量，并设置 `CPREDICT_INDEXER_PUBLIC_CONFIG_FILE` 指向同一环境的运行文件、`CPREDICT_INDEXER_METADATA_URL` 指向对应规则服务。应用与该环境索引器共享同一个隔离 schema；ctUSD 与 USDC 禁止共享。先迁移，再启动服务；不同环境使用不同端口或容器地址。

```sh
npm run site:maintain -- validate-site /secure/ctusd.runtime.json /secure/usdc.runtime.json --output /staging/site-config.json
```

命令生成的浏览器配置只含公开 environment 字段。`--output` 使用独占创建，避免覆盖已有配置；将审核后的文件放在构建产物 `dist/user-site/site-config.json`，保持 `Cache-Control: no-store`。原 `/demo/` 和旧部署资产退出入口必须验证可访问。

开启 sponsorship 之前，补齐 sponsor：独立 projectId、供应商原生币硬预算 `providerHardLimitWei` 与 `providerHardLimitPeriodSeconds`（或独立的 `providerHardLimitUsd`）、`policyOperator: "and"`、`passOnError: false`、单笔最大 Wei、60–300 秒授权有效期、exposure/exit 两条每日项目/账户/主体 Wei 与次数、每方法每日次数以及 weekly 配置。不得将 ETH 额度自动换算成已批准的美元账单预算。配置中的金额不是供应商后台已生效的证据；必须保留后台硬上限、AND、超时拒绝和域名配置验收。未核实前保持开关关闭。

用户确认每环境每周各 `100000000000000000` wei（0.1 ETH），按 Asia/Shanghai 周一 00:00 的 `[start,end)` 自然周计算，0.08 ETH 用于新增交易、0.02 ETH 专留退出。两个环境各自计额，不共享 0.2 ETH 总池。对应 sponsor 字段：

```json
{
  "providerHardLimitUsd": null,
  "providerHardLimitWei": "100000000000000000",
  "providerHardLimitPeriodSeconds": 604800,
  "weekly": {
    "window": "shanghai-monday",
    "projectWei": "100000000000000000",
    "exitReserveWei": "20000000000000000"
  }
}
```

上例只是 sponsor 的预算字段片段。现有每日防滥用限额继续按 UTC 重置，与周限额同时生效。每次登记在数据库事务内按最大 Gas 费用预留；本周的取消、回滚、未知状态不自动释放额度。跨周未决操作、以及本周才恢复结果的旧操作，继续保守占用本周预留。实际 Gas 费用由回执单独统计，因此预留额度可能高于已花费费用。新增操作不能借用退出专用额度。

ZeroDev 控制台为各项目设置独立 Project Gas Policy，核对原生 ETH 的 Amount 上限与 7 天周期，以及其窗口起点；供应商窗口不自动假定与本地自然周对齐。Custom Policy 的回调路径为当前环境 app 服务下的 `/v1/sponsorship/policy`，需使用已确认的 HTTPS 域名；关闭 Policy Pass on Error，回调返回 AND。URL 尚未确定前不启用公开赞助。[Gas Policies](https://docs.zerodev.app/api-and-toolings/infrastructure/gas-policies)、[Custom Gas Policies](https://docs.zerodev.app/api-and-toolings/infrastructure/custom-gas-policies)。

只读凭据与 RPC 检查可重复执行，每次使用新的输出文件名：

```sh
node scripts/public-site/check-providers.mjs --env-file runtime/public-site/.env.cpredict-dev --output runtime/public-site/ctusd-provider-readonly-new.json
node scripts/public-site/check-providers.mjs --env-file runtime/public-site/.env.cpredict-prod --output runtime/public-site/usdc-provider-readonly-new.json
```

命令执行 9 项只读检查，包括独立链节点的区块、固定区块存储和 EntryPoint 字节码。链 ID 或头区块不符合时依赖检查明确失败，不退回 `latest` 掩盖问题。不请求代付、不返回用户资料、不签名或广播，不证明供应商策略或真实登录已通过。

ctUSD 领币为每应用账户 24 小时一次、1,000 ctUSD 的赞助规则；代币本身任意铸造能力未被改变。USDC 无铸币入口。不得把预算不足自动切成 USDC 扣费。

## 迁移、历史回补、对账和回退

所有维护命令要求 `--config` 和显式匹配的 `--environment`。仅在批准的环境设置 `CPREDICT_MAINTENANCE_DATABASE_URL` 与 `CPREDICT_MAINTENANCE_RPC_URL`。连接串远端要求 TLS。命令不输出凭据，不发送链上交易。

```sh
npm run site:maintain -- migrate --config /secure/ctusd.runtime.json --environment ctusd-public-test
npm run site:maintain -- status --config /secure/ctusd.runtime.json --environment ctusd-public-test
npm run site:maintain -- replay --config /secure/ctusd.runtime.json --environment ctusd-public-test --from 100 --to 200
npm run site:maintain -- backfill --config /secure/ctusd.runtime.json --environment ctusd-public-test --batches 10
npm run site:maintain -- reconcile --config /secure/ctusd.runtime.json --environment ctusd-public-test --output /evidence/reconciliation.json
npm run site:maintain -- activate --config /secure/ctusd.runtime.json --environment ctusd-public-test --id REVIEWED_RECONCILIATION_UUID
```

示例区块 100–200 必须替换为实际部署范围。迁移是增量方式并记录文件校验和；重复应用不清库、不转移资产。重放每次最多 100,001 个区块，内部按 500 个区块处理；它重算保留的原始事件，不能凭重放把历史缺口标成完整。定向回补只按已验证账户的支付资产 from/to 和 EntryPoint sender 查询，每批至多 10 个账户、500 个区块。

旧库如果没有从部署开始保留原始区块/日志，先用现有 ChainIndexer 在独立影子数据库从部署区块扫描，配置相同注册合约与市场发现规则，再迁移验证过的账户关系并执行定向回补。不要篡改 coverage 标记、覆盖旧库或全链扫描 USDC。旧读取服务与退出入口继续保留，完成比较和备份后再选择读版本。

切换时暂停该环境索引写入，等待所有已验证账户的回补达到同一区块，执行只读链上对账。对账比较物理份额、totalSupply、托管、支付资产余额、早鸟分数与剩余资金池、押金/费用余额和领取后的余额；允许合约收到额外转入，但负债必须被覆盖。结果保存到 DB 和指定文件。容量超过 200,000 事实或 20,000 链上检查时显式停止，不能静默截断；扩容前须测算实际部署数据和 RPC 能力。

只有 passed 的对账、完全相同的代码摘要、epoch 与索引区块才可 activate。激活还会核对链上区块 hash。若索引推进或代码改变，重新对账。恢复索引后比较 `/v2/sync-status`、余额和首批事件。`shadow` 命令可立即暂停新榜单发布并标注影子数据；旧表、操作提交记录与已有榜单快照保留。

重组会撤销对应投影、失效游标并记录更正；从未回补的账户继续保持未知。已提交或结果未知的操作只查询原 UserOperation/transaction hash，任何恢复、回退和服务重启都不能重发。

## 排行榜、报表与反馈

首期使用预先公布的 30 天半开区间。注册输入 JSON 只有 `id`、`startsAt`、`endsAt`、`markets: [{market, startsAt}]`，时间是 Unix 秒字符串。实际 publishedAt 由维护命令写入；注册时必须早于统计开始，市场必须已注册。名单不可更新，改期另建明确的新统计期。

```sh
npm run site:maintain -- register-period --config /secure/ctusd.runtime.json --environment ctusd-public-test --input /reviewed/period.json
npm run site:maintain -- publish-period --config /secure/ctusd.runtime.json --environment ctusd-public-test --id first-period
```

完整且已对账的索引才发布榜单；按共同区块计算，期末固定在结束前最后一个区块。创作者及已验证同控制者账户不参与自己市场；未知成本不按零成本；并列名次用地址稳定分页；修正保留旧版本。没有指定市场或缺少完整数据时显示等待状态，不造排行榜。测试币和关联账户限制需要在页面保留，不宣称投资能力。

运营管理员由运行文件 `adminSubjects` 指定，接口服务端鉴权；没有用户资金操作入口。报表访问、登录、账户、全部交易地址分别统计，日期按 Asia/Shanghai `[start,end)` 事件发生时间归属。余额、待处理与预算是查询时快照，页面单独说明。业务预算每日 UTC 重置，与供应商重置规则分开展示。

供应商账单输入 `{reference,start,end,amount,currency}`（时间 ISO UTC、金额十进制字符串），使用 `import-invoice --input ...`。唯一 reference 防重复，内容冲突拒绝，保留原账期，不伪装为日报费用。UserOperation 成本来自每个 EntryPoint 事件，不把整个 bundle Gas 重复分摊。未导入账单显示未知。

反馈只保存明确提交的文本及可选账户/操作编号；拒绝访问令牌、可执行签名等模式，重试使用同一 ID。反馈没有邮件或外部通知发送。

## 站点、监控和恢复验收

`deploy/public-site/nginx.conf.template` 仅供已授权主机渲染；不会改当前 nginx。替换域名、证书、六个环境独立上游、站点路径和 `LEGACY_DEMO_URL`（现有旧站的完整 HTTPS 地址）。`/demo/` 跳转到原站，保留旧站根路径下的资源、runtime config 与 API；不要将旧 Demo 直接 alias 到新站子目录，其绝对资源路径会与新站冲突。限制请求体、保护内部 metrics/readyz、关闭配置缓存，设置 HTTPS 与基本安全头。Privy/OAuth/WalletConnect 所需 CSP 域名须在真实联调中核验；模板不声称完成供应商 CSP 审计。

模板应包含在 nginx 的 http 上下文；渲染只替换 `${UPPERCASE_VARIABLE}`，保留 `$uri`、`$remote_addr`、`$scheme`、`$host` 等 nginx 变量。应用/公开索引器运行文件的 `trustedProxies` 与规则服务的 `CPREDICT_METADATA_TRUSTED_PROXIES` 只填写实际反向代理的精确 IP；默认均不信任转发头。模板覆盖客户端传入的 X-Forwarded-For，后端端口须仅供代理和内部服务访问。实际代理拓扑确认后才启用，避免所有访问者共享代理 IP 限额或信任伪造 IP。

监控至少包括：服务 `/healthz`/内部 `/readyz`、数据库备份与恢复、已索引/确认/安全高度、未知操作积压、RPC/Privy/ZeroDev 错误、代付拒绝、业务预留与供应商实际预算。现有指标和 `/v1/ops/reports` 可接到现有监控；不新建外部通知系统。容量与报警阈值由实际测试流量和预算确定，不能用本地空库健康检查代替容量验收。

发布按：准备源码和构建摘要 → 配置审查 → 影子迁移和回补 → 双钱包真实 ctUSD 与 USDC 验收 → 备份/恢复演练 → 明确授权目标 → 限流观察 → 公开入口。回退前端或读取版本时保留 operation journal、账户配置和独立恢复工具。不会清理旧资产、不重放未知资金操作。

真实验收记录每条需：源码摘要、environment/deployment、账户版本/controller/asset、设备/钱包、前后余额、operation ID、UserOperation hash、transaction hash、区块/最终性及结果。分别覆盖邮箱/Google/外部钱包、首次零 ETH 部署与领币、购买/C2C/创建/终局领取/转出、断网/响应丢失/换设备、ERC-1155 单笔和批量接收、导出控制者后独立退出。iOS Safari、Android Chrome 和实际移动钱包切换要逐一执行；浏览器手机视口只是页面测试。

## 本地验证入口

```sh
npm run check:offchain
npm run site:check
npm run site:test:dependencies
npm run test:offchain
npm run site:test:postgres
npm run site:contracts:check
npm run site:build
npm run demo:build
npm run check:artifacts
```

`site:test:postgres` 只使用已锁定的项目 PostgreSQL 二进制，新建本机一次性数据库，要求公开站全部 21 个测试实际运行且通过，随后执行既有 13 项 PostgreSQL gate（其中 4 项索引器用例重叠），退出时关闭并移除。普通 Vitest 在未设 TEST_DATABASE_URL 时跳过数据库测试，必须另看这些专用结果。

官方 Kernel SDK 的本地分叉集成测试：

```sh
npm run site:test:kernel-fork -- --rpc-url https://sepolia-rollup.arbitrum.io/rpc --block 307080287 --output reports/generated/public-site/kernel-fork-new.json
```

也可用 `--env-file runtime/public-site/.env.cpredict-dev` 替代 `--rpc-url`；只能二选一。脚本只读取其中的链 RPC，不调用 Bundler 或 Paymaster。省略 `--block` 时先固定一次实际链头并记录其 hash，不在流程中切换区块。输出采用独占创建，每次指定新文件。命令自动构建服务端及本地 ERC-1155 / MockUSDC 夹具，核对已锁定 Anvil 二进制，使用临时缓存和较低请求速率。先验证回环节点及固定区块，再生成临时密钥；Gas 只由本地 relayer 的 EntryPoint 存款支付，没有测试网广播或托管赞助。该命令支持账户与合约集成回归，不能替代真实钱包、USDC 或整个协议业务流程验收。

公共 RPC 的历史状态读取并不稳定：2026-09-09 重跑上述旧区块时返回 `metadata is not found`，更换存储 slot 编码仍失败。需要重现旧快照时，应使用验证过的历史 RPC；另选当前固定区块只能证明新的快照下通过，不能作为旧区块回放成功。失败记录必须保留，不能自动退回 `latest` 或将此节点预检解释为长期历史覆盖保证。

开发服务器 `npm run site:dev` 的 `/test/browser/fixture.html` 是带显著标记的页面夹具，不能签名或发送交易；该入口不在生产构建输入中。实际根入口没有运行配置时保持交易关闭。当前验收状态见 [验收记录](public-test-site-acceptance.md)，逐项工程、配置、真实环境与发布待办见 [剩余清单](public-test-site-remaining.md)。
