# Cpredict 公开测试站运行与验收

2026-09-11：默认关闭的 USDC 免 Gas 入金代码、迁移与本地测试见 [USDC 入金实现及验收](usdc-gasless-deposit.md)。按最新范围，独立 USDC 部署和真实钱包代付仍后移；下文 ctUSD 部署顺序继续适用。

本轮先交付可更新部署的源码，再在现有 ctUSD 环境完成 PC 全流程验收。独立 USDC 部署和验收后移；iOS、Android 和移动钱包实机暂缓，均标记“尚未验收”，不作为本轮前置条件。两个供应商项目已有只读连接和 Privy 服务端认证记录；这些记录不证明实际代付和交易已通过。

交付顺序为：**完成本地检查并提交 → 用户在另一台机器更新部署 → ctUSD 的 PC 真实钱包、零 ETH 代付、资金进出和恢复实测 → 公开开放**。服务器控制权、USDC 资金和用户手动登录不阻塞本地源码提交。下面保留未来双环境操作说明；本轮不添加 `--usdc`，不改变已有账户派生配置。

## 从 main 更新部署

用户确认部署机器以 **`origin/main`** 为源码入口。本次将用户站交付 `6e7e76c` 合入 `main`，同时保留 `main` 上 `0f45547` 的部署 Factory 与运行包挂载校验；部署机器无需切到 `dev`。在目标仓库保留现有配置和本地工作后执行：

```sh
git switch main
git pull --ff-only origin main
git rev-parse HEAD
```

将取得的完整提交号记录到本次部署证据，随后按下文完成配置核对、备份和增量升级。私有配置不随 Git 同步。供应商项目 `cpredict-dev` 仍用于 ctUSD；该名称与 Git 部署分支分别管理，不因此更换供应商项目、账户版本或派生 index。

## 代码与构建

- `examples/user-site` 是唯一用户站入口；旧 Demo 网页、专属代码、构建及静态挂载已移除。
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
```

浏览器及完整依赖声明均保持严格类型检查。Privy 发布包内部已复现的声明错误通过 4 个固定包的最小声明补丁修复，`site:check` 与 `site:check:dependencies` 均通过。`npm ci --ignore-scripts` 后，类型检查和构建会显式运行 `site:patches`，版本、integrity 或运行 JavaScript 摘要不匹配即停止。具体版本由 package-lock 锁定，Kernel 0.3.1 / EntryPoint 0.7 与账户 index 不随前端升级变化。

依赖安全补丁将旧 WalletConnect 分支统一到已有的 2.22.4，将 UUID 统一到保留 CommonJS/ESM 的 11.1.1；Vitest 使用 4.1.11。版本覆盖范围包括替换后的版本，使 npm 能正确移除旧嵌套副本。Vite/Vitest 的覆盖值与直接依赖保持一致，避免可选 DevTools peer 解析时引入另一套测试工具；升级时须同步核对这两处。不要删除锁文件、跳过 peer 校验或手改 `node_modules` 来消除冲突。执行 `npm ls --all`、`site:test:dependencies` 和完整依赖审计，分别确认安装树、实际模块兼容性和已知漏洞。

## 本轮 ctUSD 配置与后续 USDC 配置

本轮仅配置 `deploy/public-site/ctusd.runtime.example.json` 对应的私有运行文件，核验并沿用现有部署，不能拿模板覆盖已有运行文件。模板中的 `CONFIGURE_` 是必填占位符，不能启动。`runtimeCodeHashes` 须包含当前环境 Factory、Marketplace、BondEscrow、FeeVault、支付资产五个地址的小写键和实际 keccak256 runtime code hash。应用启动时核对链 ID、字节码、依赖连接与 decimals。后续启用 USDC 时另用其模板和独立协议部署，并核对 Circle Arbitrum Sepolia 测试代币；本轮无需准备该环境。

各环境必须使用独立：数据库或 schema、部署 ID/manifest、Privy 项目、ZeroDev 项目、固定账户 index、路由前缀、预算与缓存。运行配置不接受只靠相同 chainId 区分环境。连接字符串和供应商凭据通过服务环境注入，不写入 JSON、前端或日志。

2026-09-09 用户确认的供应商映射如下；`prod` 是供应商项目名，两个环境都只连接 Arbitrum Sepolia 421614。

| 供应商项目名 | 产品环境 | 本地服务端变量文件 | 私有运行草稿 | 固定账户 index |
| --- | --- | --- | --- | --- |
| cpredict-dev | ctUSD 公开测试 | runtime/public-site/.env.cpredict-dev | runtime/public-site/ctusd.runtime.json | 1001 |
| cpredict-prod | USDC 验收（后移） | runtime/public-site/.env.cpredict-prod | runtime/public-site/usdc.runtime.json | 1002 |

这些本地文件被 Git 忽略、权限为 0600，Vite 拒绝访问 runtime 目录。凭据文件只供 Node 服务端加载，不复制进站点构建。运行草稿仍保留尚未核实的部署占位符，所有交易功能开关保持关闭。不要将供应商连接成功等同于运行配置完整。

Bundler 和 Paymaster 可以使用同一条官方 ZeroDev RPC；服务器启动会检查 URL 中的 projectId 与 chainId 是否与该环境一致。[ZeroDev 官方示例](https://docs.zerodev.app/get-started/quickstart)。`walletConnectProjectId` 现在可省略：Privy 3.40.0 的配置顺序为显式值、Privy 应用配置、SDK 默认值；不把 SDK 默认 ID 固化进本项目。外部钱包使用 MetaMask、官方检测入口和 WalletConnect 列表，Rabby 桌面通过检测入口验收，不使用已弃用的 `rabby_wallet` 标识。[Privy 官方连接说明](https://docs.privy.io/wallets/connectors/setup/configuring-external-connector-wallets)。手机真实连接仍未验收。

`CPREDICT_APP_RPC_URL` 是独立的完整链读取服务，必须验证指定区块的 `eth_getStorageAt`，不能仅检查链 ID 或自动复用 Bundler URL。本次提供的 ZeroDev 端点在该方法的历史区块参数上返回 HTTP 400；两个本地草稿已使用 `https://sepolia-rollup.arbitrum.io/rpc` 做低量联调。[Arbitrum 官方链信息](https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info)。索引、规则验证及维护服务也必须使用经验证的链读取配置；公共节点不是生产可用性、容量或全历史覆盖承诺，发布前仍需独立验收读取服务。

应用进程使用 `.env.example` 中的 `CPREDICT_APP_*`；索引器使用已有变量，并设置 `CPREDICT_INDEXER_PUBLIC_CONFIG_FILE` 指向同一环境的运行文件、`CPREDICT_INDEXER_METADATA_URL` 指向对应规则服务。应用与该环境索引器共享同一个隔离 schema；ctUSD 与 USDC 禁止共享。先迁移，再启动服务；不同环境使用不同端口或容器地址。

```sh
npm run site:maintain -- validate-site runtime/public-site/ctusd.runtime.json --output runtime/public-site/site-config.json
```

命令支持一份或多份运行配置，生成的浏览器配置只含公开 environment 字段，文件权限为 0644，供非特权 nginx 读取。`--output` 使用独占创建，避免覆盖已有配置；文件已存在时先生成不同文件名，审核差异后再替换。Compose 挂载该文件；直接静态托管则放入 `dist/user-site/site-config.json`，保持 `Cache-Control: no-store`。本轮浏览器配置仅列 ctUSD，不要求 USDC 凭据或部署。旧配置中的 `legacyUrl` 仍可读取但不再用于页面；新配置无需该字段。旧 EOA 资产退出已由用户明确移出本轮范围，智能账户的独立恢复入口继续保留。

开启 sponsorship 之前，补齐 sponsor：独立 projectId、供应商原生币硬预算 `providerHardLimitWei` 与 `providerHardLimitPeriodSeconds`（或独立的 `providerHardLimitUsd`）、`policyOperator: "and"`、`passOnError: false`、单笔最大 Wei、60–300 秒授权有效期、exposure/exit 两条每日项目/账户/主体 Wei 与次数、每方法每日次数以及 weekly 配置。不得将 ETH 额度自动换算成已批准的美元账单预算。配置中的金额不是供应商后台已生效的证据；必须保留后台硬上限、AND、超时拒绝和域名配置验收。未核实前保持开关关闭。

用户确认每环境每周各 `100000000000000000` wei（0.1 ETH），按 Asia/Shanghai 周一 00:00 的 `[start,end)` 自然周计算，0.08 ETH 用于新增交易、0.02 ETH 专留退出。两个环境各自计额，不共享 0.2 ETH 总池。对应 sponsor 字段：

2026-09-11，用户将本轮 ctUSD 的单笔上限确定为 `5000000000000000` wei（0.005 ETH）。设置 `sponsor.maxCostPerOperation`，周总额及退出预留不变；这不代表运行配置已经更新。切换时必须核查账户、主体及项目的每日限额，避免另一层低上限阻止领币后的创建。独立 USDC 验收仍后移。

```json
{
  "maxCostPerOperation": "5000000000000000",
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

上例只是 sponsor 的预算字段片段。每环境周总额保持 0.1 ETH，其中 0.02 ETH 专留退出。现有每日代付金额及次数限制按 UTC 重置，与周限额同时生效。

登记代付操作时在数据库事务内预留单笔 Gas 上限；有完整链上回执并达到 `finalized` 后，成功及回滚交易均按 `actualGasCost` 结算。应用确认数尚未达到最终确认、结果未知、回执缺失时继续保留上限。取消操作仅在服务原子确认从未申请代付，或同账户同部署的相同 nonce 已有另一次最终确认执行时释放；可能已发出的代付授权、无证据的旧取消记录不会按零费用处理。跨周未决负债继续占额，迟到的最终结算计入结算周；日常轮询不会重复移动结算时间。新增操作不能借用退出专用额度。

达到代付限额后，用户可以在同一业务确认页选择“自行支付 ETH Gas”。该模式仍核验身份、账户派生、交易调用、nonce、单笔 Gas 上限和领币冷却；不占代付金额或代付次数，且服务端拒绝其 Paymaster 请求与代付回调。用户可显式从控制钱包向智能账户补充 Arbitrum Sepolia ETH（这笔转账也由用户支付 Gas），在估算后再次确认最大费用才签名。结果未知或已提交的旧操作只能查询，不能自动改为自付重发。

`005_gas_accounting.sql` 只增加默认空的记账列并扩展额度视图，原操作 JSON 保持旧版可读，数据库原数据保留。首次启动会把无取消证明的历史“未申请代付”标记视为未知，避免曾运行旧版时遗漏授权记录；已证实释放的取消记录保持释放。运营报表和准入使用同一费用计算，自付 ETH 与供应商账单分别统计。

ZeroDev 控制台为各项目设置独立 Project Gas Policy，核对原生 ETH 的 Amount 上限与 7 天周期，以及其窗口起点；供应商窗口不自动假定与本地自然周对齐。Custom Policy 的回调路径为当前环境 app 服务下的 `/v1/sponsorship/policy`，需使用已确认的 HTTPS 域名；关闭 Policy Pass on Error，回调返回 AND。URL 尚未确定前不启用公开赞助。[Gas Policies](https://docs.zerodev.app/api-and-toolings/infrastructure/gas-policies)、[Custom Gas Policies](https://docs.zerodev.app/api-and-toolings/infrastructure/custom-gas-policies)。

沿用旧公网入口及其 Basic Auth 时，外层 Nginx 和原 Compose 网关均需增加精确路径 `/ctusd/app/v1/sponsorship/policy` 的 POST 代理；仅该路径免 Basic Auth，根页面和其他鉴权规则沿用现有设置。部署模板已包含此规则。先启用错误即拒绝的 webhook，再保存链预算，避免限额已生效但回调尚未启用的间隙。使用空请求及未登记操作验证公网返回 HTTP 200、`proceed:false`、`logicalOperator:"and"`；403、401、502 或网页 HTML 都不算回调连通。后台 Week 选项只证明供应商周周期，上海周一重置与退出预留仍由本地预算执行；不得声称后台周窗口已经与上海时间对齐。

只读凭据与 RPC 检查可重复执行，每次使用新的输出文件名：

```sh
node scripts/public-site/check-providers.mjs --env-file runtime/public-site/.env.cpredict-dev --output runtime/public-site/ctusd-provider-readonly-new.json
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

旧库如果没有从部署开始保留原始区块/日志，先列出缺失的部署、合约集合和区块区间，在现有库按该范围回补并重建新增投影。沿用现有 ChainIndexer 的采集和写入逻辑，不建立影子数据库、不重新扫描已完整历史；某类缺口尚无可靠回补证据时保持未完成。保留已验证账户关系和旧读取服务，账户资产流仅定向采集，不全链扫描 USDC，也不手工篡改 coverage。

切换时暂停该环境索引写入，等待所有已验证账户的回补达到同一区块，执行只读链上对账。对账比较物理份额、totalSupply、托管、支付资产余额、早鸟分数与剩余资金池、押金/费用余额和领取后的余额；允许合约收到额外转入，但负债必须被覆盖。结果保存到 DB 和指定文件。容量超过 200,000 事实或 20,000 链上检查时显式停止，不能静默截断；扩容前须测算实际部署数据和 RPC 能力。

只有 passed 的对账、完全相同的代码摘要、epoch 与索引区块才可 activate。激活还会核对链上区块 hash。若索引推进或代码改变，重新对账。恢复索引后比较 `/public/v2/sync-status`、余额和首批事件。现有 `shadow` 命令只暂停同库新投影的榜单发布并标注未激活状态，不代表新建数据库；旧表、操作提交记录与已有榜单快照保留。

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

只读管理员可从报表页查询 `/v1/ops/feedback`，按反馈编号检索、分页并查看关联操作；页面按文本显示原始内容。游标绑定环境、筛选和首次查询上界，并保留 PostgreSQL 微秒时间精度。

自动供应商读取使用私有环境文件中的 `CPREDICT_APP_ZERODEV_MANAGEMENT_API_KEY` 与 `CPREDICT_APP_ZERODEV_TEAM_ID`，必须一起配置；项目和链沿用本环境已有 sponsor 配置。只调用 ZeroDev 官方的项目 statistics、链 policies、webhooks 与团队 project-spend 四个 GET 接口，后者显式包含测试网。每 5 分钟读取，单请求 8 秒超时，15 分钟无成功记录标过期；不开放通用管理代理。当前只映射读取状态及查询窗口，金额、币种、余额与策略仍未知／未验证，需脱敏真实响应后再增加字段契约，不能按样例猜测。凭据不进入 JSON、浏览器、日志或业务表。

## 站点、监控和恢复验收

原地升级使用现有 Compose，追加 `--public-site`；USDC 配置就绪后再追加 `--usdc`。先运行 `npm run build:offchain`，将 `.env.compose.example` 中对应私有文件路径填入 `.env.compose.local`。ctUSD 的服务与应用账户表共用原索引数据库；USDC 使用同一 PostgreSQL 实例的独立数据库和角色。配置加载器核对旧 ctUSD 合约、部署区块、浏览器和服务端环境、固定账户 index 及供应商项目，配置不一致则停止。

`npm run stack:proxy:render -- --public-site --host <目标域名> --mode domain --email <ACME联系邮箱>` 只生成主机配置与安装脚本，不执行发布。主机代理转发到原 loopback 网关，新用户站位于根路径；`/demo` 和 `/demo/` 下的旧页面跳转根路径，`/demo/assets/` 返回 404。原 `/runtime-config.json`、`/deployment/`、`/indexer/`、`/metadata/`、`/rpc` 和 relay 路径保留。新应用路由转发 Privy Bearer，页面与 OAuth 不受旧 Basic Auth 拦截。`deploy/public-site/nginx.conf.template` 是直接托管新站静态文件的备选模板。模板不声称完成供应商 CSP 或真实 HTTPS 验收。

删除旧网页不意味着停掉 `web-demo` 容器：该服务名及 `Dockerfile.demo` 的兼容构建目标继续使用，镜像仅包含新站。更新现有网关时撤下旧 `compose.public-site.legacy.yaml` 覆盖文件和 `/usr/share/nginx/html/demo` 挂载；`stack:up -- --public-site` 已不再添加此覆盖文件或要求旧构建目录，旧私有变量可暂留但不会使用。无需停掉或重建数据库、indexer 等后端来删除页面。已有云端静态副本也需同步撤下 `/demo/assets/` 直出规则或添加上述 `^~` 拒绝规则，避免新网关上线后云端继续提供旧文件。保留新站 `/assets/` 的同版本资源及现有代理配置。

若反向 SSH 隧道传输静态模块时超时，先比较源站的完整 GET 与云端隧道 GET，检查重传、拥塞窗口和 macOS 隧道任务的后台调度。不要只用 HEAD 或增加代理超时判断修复成功。可以从正在运行的网关导出公开静态资产，供云端运营核验后本地托管：

```sh
node scripts/stack/export-public-static-assets.mjs --container cpredict-web-demo-1
```

该命令直接复制当前容器的新站 `assets/`，不重建镜像，拒绝链接和非普通文件，排除源码映射，检查归档成员，并输出文件数、原始与压缩大小、SHA256 和逐文件清单。归档中不包含首页、配置或 API 数据。输出位于 `runtime/public-site/static-handoff/`，属于有意公开的静态文件，权限为目录 755、文件 644；运行密钥和运行配置仍为 600，不能放入此目录。

将 `compose.static-handoff.yaml` 作为现有已核验 Compose 配置的最后一个覆盖文件，仅给网关增加只读挂载；保留当前镜像和其他服务。临时下载路径为 `/_static-handoff/<归档名>`，可从云端现有 `http://127.0.0.1:4177` 隧道读取。导出仅包含新站 `/assets/`。先完整下载并核对 SHA256，再核对归档路径没有越界、链接及源码映射；云端是否启用本地 `/assets/` 由负责云端配置的任务处理，页面、运行配置与 API 继续使用原代理。切勿在一次传输过程中重启隧道。交接完成后可撤掉临时挂载，并与云端资产回退保持协调。

已有 Mac 部署栈与云端静态托管的固定更新入口为 `npm run stack:update:public`。该命令拉取 `origin/main` 后，按每个组件已部署的源码、依赖和配置指纹输出执行范围，再只构建、更新受影响的服务。仅前端变化时只发布资源和更新 `web-demo`；仅后端变化时保留前端版本。只有实际存在待执行 SQL 时，才备份对应数据库并暂停其写入服务，不在每次发布时执行完整恢复演练。文档、测试、部署工具或无运行变化的提交不触发服务更新。`npm run stack:update:public -- plan` 只预览当前已提交源码相对运行部署的范围，不拉取或切换服务。失败时只回退本次涉及的服务，保留数据库中新操作。合约发布、历史投影重算及不兼容迁移单独处理。详细安装、恢复、首次接管与验收边界见 [固定更新流程](../deploy/public-site/README.md)。`stack:up` 仍是整套 Compose 管理命令，以下首次升级步骤也不代替日常按需更新入口。

云端使用只追加的带哈希资源目录，旧文件供缓存页面和已打开的浏览器继续加载。首页、配置和 API 仍由部署机提供；云端不接收应用源码、数据库或 Privy/ZeroDev 私有配置。初次安装和真实发布尚未执行时，必须明确标记对应验收未完成。

模板应包含在 nginx 的 http 上下文；渲染只替换 `${UPPERCASE_VARIABLE}`，保留 `$uri`、`$remote_addr`、`$scheme`、`$host` 等 nginx 变量。应用/公开索引器运行文件的 `trustedProxies` 与规则服务的 `CPREDICT_METADATA_TRUSTED_PROXIES` 只填写实际反向代理的精确 IP；默认均不信任转发头。模板覆盖客户端传入的 X-Forwarded-For，后端端口须仅供代理和内部服务访问。实际代理拓扑确认后才启用，避免所有访问者共享代理 IP 限额或信任伪造 IP。

监控至少包括：服务 `/healthz`/内部 `/readyz`、数据库备份与恢复、已索引/确认/安全高度、未知操作积压、RPC/Privy/ZeroDev 错误、代付拒绝、业务预留与供应商实际预算。现有指标和 `/v1/ops/reports` 可接到现有监控；不新建外部通知系统。容量与报警阈值由实际测试流量和预算确定，不能用本地空库健康检查代替容量验收。

应用内部 `/metrics` 已提供请求耗时、依赖可用性、代付拒绝、恢复查询、未知操作、索引延迟、周预算和内存指标；未采集值不伪装成零。使用 `monitoring/prometheus/public-site-scrape.example.yml` 与 `cpredict-public-site-alerts.yml` 接入既有 Prometheus；所有公网代理均屏蔽 metrics/readyz。RPC 业务拒绝不等同于网络服务不可达。真实断网、断库和告警恢复仍需在目标环境留证。

持续页面回归运行 `npm run site:test:browser`：构建新站后，使用现有 Playwright/Chrome 验证实际静态入口、旧 URL 跳转、旧资源不可访问与不会签名的业务夹具。PC 与窄视口分别记录；失败 trace、截图和 JSON 报告写入 `reports/generated/public-site/`。测试服务器只监听 loopback；它不能替代真实 nginx/HTTPS 或钱包验收。CI 的 `npm run test:postgres -- --public-site` 必须执行全部 31 项新旧数据库测试，跳过任何一项都会失败。

容量准备执行 `npm run site:test:capacity -- --prepare`（30 秒）；正式本地检查执行 `npm run site:test:capacity`（30 分钟）。使用项目已锁定 PostgreSQL/k6、一次性 loopback 数据库和实际 public indexer 查询接口，种入 100 个市场、50 个账户、10,400 条原始事件。50 个虚拟读者以总计约 10 次/秒查询，保存耗时、错误、连接、队列和应用 RSS/heap；不调用实际代付或扫描真实链。报告写入 `reports/generated/public-site/capacity-*/`，只有正式运行达标才能记录本地容量通过；不代表目标主机、真实浏览器或供应商容量。

`npm run site:measure:pc -- <记录标签>` 测量既有构建在本地 Chrome 的三次冷加载，分别记录未配置入口和独立恢复页、资源字节与时间；不测真实登录/交易。构建自动生成 `/third-party/index.html` 和许可副本，入口与帮助页可访问。许可状态仍以[逐项核对](public-test-site-license-review.md)为准。

开发期升级按：本地检查并提交 → 用户在部署机器取得该提交、保留原私有配置 → 停止写库服务并备份 → 同库增量 SQL、更新原服务和增加应用服务 → 必要回补与同区块对账 → PC 双钱包真实 ctUSD 验收 → 限流观察并开放。允许短暂停机，不引入新影子数据库或双读切换。源码交付与实际站点验收分别记录；本地 Git 提交本身不会把代码传到另一台机器。

部署机器在已有配置中补齐 `.env.compose.example` 的 ctUSD 路径，核对实际部署信息，并完成上文单环境 `validate-site`。使用 Node 22、项目已有 Docker 和 Compose 2.30 或更新版本；保留 `.env.compose.local`、供应商文件、原数据库卷和旧部署运行包。私有运行 JSON 挂载给容器内 `node` 用户，需核对其文件所有者与容器 UID 对应、0600 下仍可读；供应商变量文件由 Compose 读取，保持 0600，不挂到网页目录。不要通过公开私有配置修复文件权限。检查命令：

```sh
npm ci --ignore-scripts
npm run build:offchain
npm run stack:config -- --public-site
```

配置检查通过后，按现有运行方式停止写库进程，执行 `npm run stack:backup:verified`；备份恢复成功后才运行以下更新命令。`up` 自动构建镜像并按依赖执行增量迁移，保留原数据。此时交易开关继续关闭，待回补、对账和实际供应商配置验证后再开启对应能力。

```sh
npm run stack:up -- --public-site
npm run stack:status -- --public-site
```

`stack:backup:verified` 备份现有三个数据库并恢复到一次性容器；未来已启用 USDC 时加 `-- --usdc`，同时覆盖其两个独立数据库。备份保存实际表/列清单与内容摘要，包括新增财务、账户、未知操作和反馈；写库未停止而数据变化时拒绝生成成功证据。恢复先对比原数据，再验证增量 SQL 不破坏旧列和记录。新资金操作发生后，只回退前端/服务读取版本并保留操作数据，不能把旧备份覆盖到现有数据库。

真实验收记录每条需：源码摘要、environment/deployment、账户版本/controller/asset、设备/钱包、前后余额、operation ID、UserOperation hash、transaction hash、区块/最终性及结果。本轮在 PC 的 ctUSD 环境分别覆盖邮箱/Google/外部钱包、首次零 ETH 部署与领币、购买/C2C/创建/终局领取/转出、断网/响应丢失/换设备、ERC-1155 单笔和批量接收、导出控制者后独立退出。已有 `.env.test-wallets.local` 中三个测试角色私钥，权限 0600，无需重新提供，可用于授权范围内的程序化 ctUSD 验证；凭据仅在测试进程内读取，不进入源码、报告或日志。程序化链上记录与 Privy 登录、MetaMask/Rabby 弹窗和官方导出分开留证。iOS Safari、Android Chrome、移动钱包实机及独立 USDC 验收后移，明确标记“尚未验收”；浏览器手机视口只证明页面夹具回归。

## 本地验证入口

本机调试前端、沿用已部署的后端时，在仓库根目录的 `.env.local` 配置
`CPREDICT_SITE_REMOTE_ORIGIN=https://现有测试站地址`，执行 `npm run site:dev`，
打开 `http://127.0.0.1:4198`。Vite 同时代理公开的 `/site-config.json` 和 API；
页面及源码仍从本地加载。兼容已有 `CPREDICT_DEMO_REMOTE_ORIGIN`，新变量优先。
Node 需要通过本机网络代理访问公网时，可配置
`CPREDICT_SITE_HTTPS_PROXY=http://127.0.0.1:实际代理端口`；保持 TLS 证书校验。
这两个变量只用于开发服务器，生产构建仍使用部署时的公开配置和网关。
后端 `allowedOrigins` 应允许该本地地址；收到 `origin_not_allowed` 时检查运行配置，
不要在代理中伪造 Origin。未设置远端地址时，仍使用本机后端和默认空环境配置。

```sh
npm run check:offchain
npm run site:check
npm run site:test:dependencies
npm run test:offchain
npm run site:test:postgres
npm run site:contracts:check
npm run site:build
npm run check:artifacts
```

`site:test:postgres` 只使用已锁定的项目 PostgreSQL 二进制，新建本机一次性数据库，要求公开站全部 22 个测试实际运行且通过，随后执行既有 13 项 PostgreSQL gate（其中 4 项索引器用例重叠），退出时关闭并移除。也可执行 `npm run test:postgres -- --public-site`，联合运行全部 31 项且拒绝跳过。普通 Vitest 在未设 TEST_DATABASE_URL 时跳过数据库测试，必须另看这些专用结果。

官方 Kernel SDK 的本地分叉集成测试：

```sh
npm run site:test:kernel-fork -- --rpc-url https://sepolia-rollup.arbitrum.io/rpc --block 307080287 --output reports/generated/public-site/kernel-fork-new.json
```

也可用 `--env-file runtime/public-site/.env.cpredict-dev` 替代 `--rpc-url`；只能二选一。脚本只读取其中的链 RPC，不调用 Bundler 或 Paymaster。省略 `--block` 时先固定一次实际链头并记录其 hash，不在流程中切换区块。输出采用独占创建，每次指定新文件。命令自动构建服务端及本地 ERC-1155 / MockUSDC 夹具，核对已锁定 Anvil 二进制，使用临时缓存和较低请求速率。先验证回环节点及固定区块，再生成临时密钥；Gas 只由本地 relayer 的 EntryPoint 存款支付，没有测试网广播或托管赞助。该命令支持账户与合约集成回归，不能替代真实钱包、USDC 或整个协议业务流程验收。

公共 RPC 的历史状态读取并不稳定：2026-09-09 重跑上述旧区块时返回 `metadata is not found`，更换存储 slot 编码仍失败。需要重现旧快照时，应使用验证过的历史 RPC；另选当前固定区块只能证明新的快照下通过，不能作为旧区块回放成功。失败记录必须保留，不能自动退回 `latest` 或将此节点预检解释为长期历史覆盖保证。

开发服务器 `npm run site:dev` 的 `/test/browser/fixture.html` 是带显著标记的页面夹具，不能签名或发送交易；该入口不在生产构建输入中。实际根入口没有运行配置时保持交易关闭。当前验收状态见 [验收记录](public-test-site-acceptance.md)，逐项工程、配置、真实环境与发布待办见 [剩余清单](public-test-site-remaining.md)。

## Existing ctUSD deployments using the original ABI

The current public-site release is moving to a separate **time-v2** protocol
deployment while reusing ctUSD and the existing account derivation. Follow the
[ctUSD time-v2 cutover](ctusd-time-v2-upgrade.md). Legacy contracts and market
history remain archived and are not the new site's catalog or creation target.
The compatibility details below apply only to that retained old deployment.

Set `environment.deployment.protocolVersion` to `legacy-v1` only after verifying the original deployment manifest and runtime code hashes. Omission retains the time-v2 model. This selects the original initialization/metadata event signatures, legacy rules commitments, and explicit terminal-state translation at the public-site boundary. Original database state values and stored event JSON remain unchanged. Migration `007_legacy_deployment.sql` adds missing fields; unknown new time commitments stay null. The metadata service serves both immutable rules formats.

The retired Demo is no longer built or mounted. `CPREDICT_STACK_LEGACY_DEMO_DIR` is no longer required or used. Original-ABI market reading and indexing remain available for archival maintenance; the creation page explicitly rejects this deployment. The public site uses time-v2 rather than introducing a separate original-ABI creation form. Never submit the time-v2 create tuple to the old factory.

Rehearse against restored database backups before switching services. Verify original market/position values after migration and reorg replay, and preserve the original runtime package and container images for rollback. Replaying historical financial facts does not establish full scanner coverage, payment-token coverage, or reconciled PnL. Keep sponsorship disabled until the supplier's actual hard cap and policy composition are verified.
