# Arbitrum Sepolia 合约验证与交互 Web Demo

面向甲方体验验收的操作步骤、测试物料、已知限制和问题记录模板见
[Web Demo 甲方手测体验指南](16-web-demo-client-manual-test-guide.md)。本文件继续说明技术集成、信任门禁
和证明边界。

## 1. 交付结论

Demo 位于 `examples/web-demo`，面向接入合约的前端、后端、QA、审计和甲方技术人员。它固定使用
Arbitrum Sepolia（chainId `421614`），不允许切换到主网或其他测试网。它是验证/交互工具，不是
消费者预测市场产品、治理后台、部署证明或密钥托管服务。

当前仓库没有 Arbitrum Sepolia 的 `FINALIZED_VERIFIED` 部署清单，因此默认页面必须显示
`BLOCKED_NOT_DEPLOYED / LOCKED`。只有真实部署、双 RPC 核验和 24 小时 canary 完成后，运维才能把
final manifest 置于同源 `/deployment/final.json`。

## 2. 本地运行

```bash
npm ci --ignore-scripts
npm run demo:dev
```

访问 `http://127.0.0.1:4177`。Vite 开发代理：

| Browser path             | 开发目标                       | 生产要求                                             |
| ------------------------ | ------------------------------ | ---------------------------------------------------- |
| `/rpc`                   | 官方 Arbitrum Sepolia HTTP RPC | 同源反向代理到受控 RPC；限速和超时                   |
| `/indexer`               | `127.0.0.1:8787`               | 同源只读 Indexer/API                                 |
| `/evidence`              | `127.0.0.1:8790`               | 可选 canonical bytes 上传适配器；浏览器不携带 cookie |
| `/deployment/final.json` | 默认不存在                     | 受控发布产生的最终清单                               |

生产构建：

```bash
npm run demo:test
npm run demo:build
```

产物在被 Git 忽略的 `dist/web-demo`。生产边缘必须应用
`examples/web-demo/security-headers.conf`，然后从真实 HTTPS 响应验证 CSP、frame-ancestors、
nosniff、Referrer-Policy、Permissions-Policy、COOP/CORP。仓库中的配置文本本身不等于运行时保护。

## 3. 写操作信任门禁

```text
runtime-config schema PASS
  → final-manifest schema PASS
  → RPC chainId=421614
  → manifest finalized reference block hash PASS
  → reference block 每个 runtime codehash PASS
  → Factory active/fingerprint/全部 dependency wiring PASS
  → Marketplace Factory/Emergency/FeeVault/payment-token/Permit2 wiring PASS
  → payment token decimals=6
  → sandbox 时 name=Cpredict Test USD、symbol=ctUSD、marker=true
  → EIP-6963/injected wallet connected
  → wallet chainId=421614
  → economic write enabled
```

状态语义：

- `VERIFIED`：正式清单和全部链上检查通过。
- `DEBUG`：runtime 地址包或当前会话手工输入的 11 个协议合约和 payment-token/Permit2/EntryPoint
  全部有代码且关键 wiring 通过；没有正式 codehash 清单，仍非发布证明，页面持续警告。
- `TEST TOKEN`：DEBUG 的子类型。runtime 必须显式绑定 `sandbox-test-token`；链上 ctUSD 的名称、符号、
  6 位精度和 sandbox marker 全部通过后，页面才显示领取按钮并允许用同一 ctUSD 创建/购买/C2C。
- `LOCKED`：任何先决条件失败；所有写按钮禁用。

调试地址不进入 localStorage/sessionStorage，刷新即丢失。钱包 account 变化会清空连接并强制重新连接，
避免 Creator/Trader 角色静默混淆。页面不读取 private key、seed、RPC secret、API key、cookie 或
Paymaster signer；任何浏览器 runtime config 都视为公开数据。

押金操作仅将公开的链/钱包/市场/creator/托管身份及操作类型、交易哈希、起始区块保存在本标签页
`sessionStorage` 的专用白名单记录中，用于刷新后查询原回执；不恢复部署配置、钱包控制权或签名。
不存储私钥、签名、授权、规则正文或错误原文。存储不可用时保留当前页操作和哈希提示，但不承诺刷新恢复。

## 4. 已接调用面

| 页面       | 读                                                                   | 写                                                                            |
| ---------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 部署验证   | schema、chainId、codehash、Factory/Marketplace/payment-token wiring  | 无治理写                                                                      |
| 概览       | payment token 类型、钱包余额、Sandbox 警告                           | sandbox mint 10,000 ctUSD                                                     |
| 市场       | Vault 状态、cap、bond、flags、pool、ERC-1155/payment-token/allowance | exact allowance、buy、Permit2 buy                                             |
| 创建市场   | Config fee、不可变参数、rules/source hash、Full/Clone 风险           | fee+bond approval、createMarket                                               |
| 我的持仓   | ERC-1155 outcomes、累计一级购买、early score                         | 领取入口在结算页                                                              |
| C2C        | Marketplace/Vault 地址与状态                                         | ERC-1155 approval、listing、allowance fill、cancel                            |
| 结算与作废 | Creator/状态/deadline                                                | evidence-backed resolve/creatorVoid、timeout void、四类 claim、押金释放与领取 |
| 回执与事件 | 本会话 simulate/receipt/error                                        | 无                                                                            |

所有 SDK 写操作统一 `validate → simulate → send once → receipt.status`，不自动重发经济交易。Allowance
只授权本次精确额度；Permit2 witness 绑定 owner/spender/selector/market/outcome/amount/nonce/deadline/
chainId。C2C 页面当前可运行路径为 allowance fill；SDK 的 Permit2 fill 仍可由接入方按同一 witness
规范调用，但尚未在该页面暴露按钮。

## 5. 结算证据

Creator 同时填写 `https:`/`ipfs:` source URI 和 summary 时，页面使用 SDK 生成固定字段顺序、NFC、
UTF-8 canonical JSON，计算 SHA-256 和 deterministic CIDv1。只有当注入的同源 uploader 返回 URI
与预期 CID 完全一致时才提交 evidenceHash。`evidence.uploadEnabled=false` 时不注入 uploader；页面可
提交显式 zero evidence，但这不代表甲方接受无证据结算。

上传接口接收 exact bytes，媒体类型：

```text
application/vnd.cpredict.settlement-evidence+json;version=1
```

请求不携带浏览器 cookie，服务端必须用自身部署策略完成鉴权、内容寻址存储和审计留痕；不得在浏览器
配置长期 secret。

## 6. 三钱包完整验收

准备三个没有真实资产的一次性账户。每个账户仍需领取 Arbitrum Sepolia 测试 ETH 支付钱包 gas；
在 Sandbox runtime 中，从概览页领取 ctUSD，不需要外部 USDC faucet：

1. `A / Creator`：连接、验证网络、创建 Full 市场，保存 MarketCreated receipt 和 Vault 地址。
2. `B / Trader`：普通 allowance 购买 outcome 0；批准 ERC-1155 托管并创建部分卖单。
3. `C / Counterparty`：Permit2 购买 outcome 1；allowance fill B 的卖单；检查 C2C 不改变 pool。
4. 回到 `A`：锁定规则/来源核验后上传 canonical evidence 并 resolve；另建市场覆盖 creator void。
5. `B/C`：winner、early-bird、refund、timeout bonus 按适用终局分别领取。
6. 独立 timeout canary：等待真实 24 小时后 permissionless void、principal refund、bond settle/fund、
   bonus conservation；不能用本地改时间冒充测试链验收。

每次切换账户都重新连接。对每个交易保存：钱包角色、chainId、输入摘要、simulation 结论、tx hash、
block/hash、status、gasUsed、关键 event、Arbiscan 链接。Toast 和本地 Activity Log 不是单独验收证据。

## 7. 测试与证明边界

```bash
npm run check:offchain
npm run demo:test
npm run demo:build
```

上述门禁证明 TypeScript、纯函数/SSR 安全不变量和生产构建，不证明真实钱包、RPC、Indexer、Uploader、
浏览器响应头或测试链交易。浏览器 QA 必须分别覆盖桌面与移动视口、错误网络、拒签、simulate revert、
receipt revert、account change、manifest/codehash/wiring 任一失败锁定，以及 metadata/XSS 字符串只按纯文本
显示。

本次本地生产构建的桌面/移动浏览器证据与视觉 fidelity ledger 位于
`reports/web-demo/QA.md`。它证明页面运行和 LOCKED fail-closed 状态，不证明测试链交易。

## 8. 设计验收

本地视觉 QA 可把概念图放在以下被 Git 忽略的路径：

- `docs/assets/web-demo/overview-desktop.png`
- `docs/assets/web-demo/market-desktop.png`
- `docs/assets/web-demo/mobile.png`

这些二进制图只作为本机人工比对，不进入凭据扫描后的源码交付，也不构成运行时依赖；可持续交付的
验收结果记录在 `reports/web-demo/QA.md`。视觉保真点：白底/深蓝文本/蓝色主操作/琥珀调试/绿色验证；桌面左侧栏与右侧 Inspector；四张紧凑状态
卡；底部 event/receipt；市场 Allowance/Permit2 tabs；移动双列状态卡和底部导航。概念图只用于 QA，
禁止作为页面背景或伪造运行时数据。

## 9. 尚未关闭

- 未部署 Arbitrum Sepolia，因此没有 `VERIFIED` 状态或真实交易 E2E。
- 没有仓库内 Playwright 钱包模拟/浏览器自动化门禁；本地使用 SSR/纯函数测试，真实 EIP-6963 钱包需
  浏览器人工/受控自动化验收。
- Indexer discovery/WS 仍是可选后端；当前 UI 以手工 Vault 地址 + RPC 读取为确定性 fallback。
- AA/Paymaster 只读，Demo 不发送 UserOperation。
- C2C Permit2 fill、terminal listing return、BondEscrow settle、Guard sync 尚未暴露 UI 按钮，但 SDK 已有
  固定入口；接入方可按 `07-sdk-integration.md` 调用。
- 正式外审、bug bounty、商业负载、商业经济阈值和法律/地区审查仍是发布阻断，不因 Demo 存在而关闭。
