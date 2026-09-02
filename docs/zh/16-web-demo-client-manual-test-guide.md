# Cpredict Web Demo 甲方手测体验指南

## 1. 这份指南测什么

本指南面向甲方体验验收人员，用于通过 Web Demo 手工体验 Cpredict 在 Arbitrum Sepolia Sandbox 上的
主要用户流程：连接钱包、领取测试币、查看市场、购买、查看持仓、C2C 转让、结算/退款/领取以及查看
链上回执。

本次体验使用可任意增发、没有真实价值的 `ctUSD` 和 Arbitrum Sepolia 测试 ETH。请勿转入真实资产，
也不要把页面中的 `DEBUG` 或 `TEST ONLY` 状态理解为生产发布。

本指南不要求甲方：

- 接触或提供私钥；
- 填写合约 ABI、calldata、部署地址包或 transaction hash；
- 自行生成 rules hash、IPFS CID、Listing ID 或结算证据；
- 验证源码、Timelock、Safe、Paymaster、gas budget 等工程门禁；
- 测试主网、真实 USDC 或生产资金。

## 2. 当前版本的体验边界

当前 Web Demo 是“合约验证与交互控制台”，不是完整消费者预测市场产品。甲方开始测试前，应了解：

- “市场”页通过只读 Indexer 提供市场目录，“结算与作废”页会列出已到 `closeAt`、尚未终局的市场；
- Indexer 未启用、未同步或目标市场尚未出现时，仍需交付方提供已知 Market Vault 作为回退；
- 创建市场页面只支持 `1–90 天`期限，不能从 UI 创建 15 分钟开放期市场；
- 15 分钟快速验收市场必须由交付方提前创建并提供 Vault；
- C2C 创建成功后会从链上回执自动提取 Listing ID；选择活跃挂单会自动加载对应 Vault、价格和剩余数量；
- C2C 页面仅开放 allowance fill，Permit2 fill 只存在于 SDK；
- settlement evidence uploader 当前关闭，体验时不填写 evidence URI/summary；
- Paymaster 仅只读展示，所有钱包交易仍需要测试 ETH 支付 gas；
- 本会话事件记录在刷新页面后清空，交易事实以 Arbiscan receipt 为准；
- C2C 和内嵌 Creator 结算只在各自卡片内显示 block/hash，不会同步到全局“回执与事件”；
- 移动端底部仅有概览、部署验证、市场、创建市场、持仓；没有 C2C、结算和回执入口；
- 甲方完整主流程以桌面端为准，移动端只能验收已暴露页面。

如果以上任一项与本轮商务验收范围冲突，应先调整产品或测试环境，不要让甲方在现场用技术方式绕过。

## 3. 交付方必须提前准备

以下工作由交付方完成，不交给甲方：

- 提供可访问的 Web Demo URL；
- 把当前 Sandbox 地址包和 `ctUSD` runtime 配置部署到该 URL；
- 确认页面顶部显示 `DEBUG`，并持续显示 `TEST ONLY：ctUSD 可由任何人任意增发，无真实价值`；
- 确认页面不是 `LOCKED` 或 `BLOCKED_NOT_DEPLOYED`；
- 准备三个没有真实资产的测试钱包/浏览器档案；
- 为三个钱包准备足够的 Arbitrum Sepolia 测试 ETH；
- 提供至少一个 OPEN 市场、一个可结算市场、一个作废/退款市场和一个 timeout 市场；
- 提供每个市场的 Vault 地址、题目、结果含义、正确结算结果和可操作时间；
- 为 C2C 场景准备卖方持仓和至少一个可供买方选择的活跃挂单；
- 明确本轮哪些步骤必须执行、哪些是可选项、哪些是当前已知限制。

当前仓库默认 runtime 仍会显示 `LOCKED / BLOCKED_NOT_DEPLOYED`。如果交付方没有先发布准备好的
Sandbox runtime，甲方不得开始测试，也不应自行在“部署验证”页面填写多个合约地址。

## 4. 测试物料表

交付方在测试前填写以下公开信息，不填写任何私钥：

| 项目 | 测试值 |
| --- | --- |
| Web Demo URL |  |
| 甲方测试日期/时区 |  |
| 浏览器与版本 |  |
| A / Creator 钱包公开地址 |  |
| B / Trader 钱包公开地址 |  |
| C / Counterparty 钱包公开地址 |  |
| OPEN 市场 Vault |  |
| C2C 市场 Vault |  |
| Resolve 市场 Vault / 正确 outcome |  |
| Creator void 市场 Vault |  |
| Timeout 市场 Vault / 可执行时间 |  |
| 预置活跃挂单或创建方式 |  |
| 问题反馈联系人 |  |

建议为 A/B/C 使用三个独立浏览器 Profile。不要把三个钱包的助记词或私钥写入本表、截图、聊天或测试
报告。

## 5. 开始测试前的 Go / No-Go

打开 Web Demo 后先检查：

| 检查项 | 可以开始 | 必须停止 |
| --- | --- | --- |
| 页面标题 | `Cpredict 合约验证控制台` | 页面无法打开、白屏或持续报错 |
| 网络 | `Arbitrum Sepolia / 421614` | 主网、其他测试网或网络未知 |
| 顶部状态 | `DEBUG` | `LOCKED` |
| 支付币 | `ctUSD`、`TEST TOKEN`、明确无真实价值 | 显示真实资产但交付方没有书面确认 |
| 钱包 | 能发现已安装钱包并连接 | `未发现钱包` 或连接后地址不符 |
| 写入门禁 | `DEBUG enabled` | `LOCKED` |
| 测试物料 | Vault、角色、正确 outcome、时间点齐全 | 要求甲方自行寻找地址、Hash、CID 或 Listing ID |

任何 No-Go 出现时，记录截图和时间后停止。不要反复点击交易按钮，也不要尝试切换到主网解决。

## 6. 核心体验流程

### 场景 1：首次进入和信任状态

1. 用桌面 Chrome 打开交付方提供的 URL。
2. 查看顶部状态、网络、支付币和右侧地址检查器。
3. 打开“部署验证”，只查看检查结果，不填写“自定义调试地址”。
4. 返回“概览”。

预期体验：

- 页面明确显示 `DEBUG` 和 `TEST ONLY`；
- 网络固定为 Arbitrum Sepolia；
- Factory、Marketplace、ctUSD、Permit2 地址已由环境自动加载；
- 不出现让甲方复制粘贴多个合约地址才能继续的步骤；
- 如果任一链上检查失败，写操作保持锁定并给出可理解原因。

### 场景 2：连接钱包和切换网络

1. 在顶部选择本场景指定的钱包。
2. 点击“连接钱包”。
3. 如果钱包不在 Arbitrum Sepolia，点击“切换网络”。
4. 在钱包中确认连接，不签署任何无关消息或交易。

预期体验：

- 页面显示的短地址与测试物料表一致；
- 钱包网络显示 `Arbitrum Sepolia`；
- 切换钱包账户后，页面主动断开并要求重新连接，避免角色混淆；
- 拒绝连接或拒绝切换网络时，不出现假成功或自动重试。

### 场景 3：领取 Sandbox 测试币

1. 使用 A/B/C 中当前指定的钱包进入“概览”。
2. 找到“Sandbox 测试币”。
3. 记录领取前余额。
4. 点击“领取 ctUSD”，在钱包中确认一次测试网交易。
5. 等待页面出现 included block/receipt，并记录领取后余额。

预期体验：

- 页面持续提示 ctUSD 可任意增发、没有真实价值；
- 只产生一笔 mint 交易；
- 交易确认后余额增加；
- 拒签、失败或 RPC 异常时不显示成功，也不自动重发；
- 甲方只需要测试 ETH 支付 gas，不需要真实 USDC。

### 场景 4：加载并理解市场

1. 进入“市场”。
2. 粘贴交付方提供的 OPEN Market Vault。
3. 点击“读取链上状态”。
4. 核对市场状态、outcome 数量、Pool、Close at、Market cap、Creator bond、Permit2 和 Early bird。

预期体验：

- 页面读取真实链上数据，不显示伪造示例市场；
- 市场状态为 `OPEN`；
- Close at 和测试物料一致；
- 支付币为 ctUSD；
- 用户能理解自己将购买哪个 outcome、多少份额以及最大支付金额。

如果甲方必须离开页面去猜测 Vault、outcome 含义或题目内容，应记录为“市场发现/内容展示缺失”，而
不是让甲方自行解释地址和 outcome 编号。

### 场景 5：Allowance 购买

1. 使用 B / Trader 加载 OPEN 市场。
2. 保持 `Allowance` 标签。
3. 选择交付方指定的 Outcome，Shares 输入 `1`，Max slippage 输入 `0`。
4. 点击“精确授权”，确认一次授权交易。
5. 授权成功后点击“模拟并购买”，确认一次购买交易。
6. 等待 receipt，再打开“我的持仓”。

预期体验：

- 授权金额与本次购买额度一致；
- 购买前先 simulation，失败时不发送交易；
- 快速双击不会发送两笔购买；
- receipt 成功后，所选 Outcome 持仓增加 1 份；
- 钱包 ctUSD 减少量、Pool 增加量与本次购买一致；
- 交易失败或用户拒签后不显示持仓增加。

### 场景 6：Permit2 购买

1. 使用 C / Counterparty 加载同一 OPEN 市场。
2. 切换到 `Permit2` 标签。
3. 选择另一个 Outcome，Shares 输入 `1`，Max slippage 输入 `0`。
4. 点击“精确授权 ctUSD → Permit2”，确认授权交易。
5. 点击“签名并购买”，先检查钱包签名请求，再完成购买交易。
6. 打开“我的持仓”检查对应 Outcome。

预期体验：

- 签名请求明确绑定当前网络、Vault、Outcome、金额、nonce 和 deadline；
- 页面不保存或展示完整签名；
- 签名本身不产生链上交易，购买只产生一笔交易；
- 拒绝签名后不自动发交易；
- 成功后 C 的对应持仓增加。

### 场景 7：查看持仓和切换角色

1. 分别用 B、C 钱包加载同一个 Vault。
2. 每次切换账户后重新连接。
3. 打开“我的持仓”。

预期体验：

- 页面只显示当前连接钱包的 ERC-1155 Outcome 持仓；
- B/C 的持仓互不混淆；
- 切换账户不会沿用前一个钱包的余额或操作权限；
- 如果数据未刷新，重新进入“市场”并读取同一 Vault 后应更新。

### 场景 8：C2C 转让

该场景只在桌面端执行。

卖方步骤：

1. 使用有持仓的钱包加载 C2C Market Vault。
2. 进入“C2C 市场”。
3. 点击 `Step 1: approve share escrow`。
4. 输入交付方指定的 Outcome、Shares 和每份 ctUSD 价格。
5. 点击 `Step 2: create listing`。
6. 确认页面从 receipt 自动显示并选中新创建的 Listing ID，同时保存 receipt。

买方步骤：

1. 切换到另一个测试钱包并重新连接。
2. 进入“C2C 市场”，在活跃挂单中点击 `选择此挂单`。
3. 确认页面自动加载相同 Vault、Listing ID、Outcome、固定价格和剩余数量。
4. 只填写要购买的 Shares，确认页面自动计算总额。
5. 点击 `Approve exact ctUSD for fill`。
6. 点击 `Fill exact amount`。
7. 双方重新加载市场和持仓。

预期体验：

- 卖方持仓减少、买方持仓增加；
- ctUSD 从买方转给卖方；
- C2C 不改变 Market Pool 和最终 payout 规则；
- 每个写操作只有一次钱包确认和一条最终结果；
- 无效/已取消 Listing 不应成交；
- 成交授权和提交前都应重新读取链上挂单；失效、过期或剩余数量不足时不得继续签名。

如需测试 cancel，使用仍有剩余数量的卖单，由原卖方选择该挂单后点击 `Cancel selected listing`。

### 场景 9：Creator 结算

仅使用交付方提供的专用 Resolve 市场，且必须已到 `closeAt`。不要拿同一个市场同时测试 resolve、void
和 timeout。

1. 使用 A / Creator 加载 Resolve 市场。
2. 打开“结算与作废”。
3. 核对交付方提供的正确 Outcome 和锁定规则。
4. 当前 Sandbox 不启用 evidence uploader，因此 Evidence source URI 和 summary 均保持为空。
5. 勾选 `I verified the locked rules and understand settlement is final.`。
6. 输入正确 Winning outcome，点击 `Resolve` 并确认交易。

预期体验：

- 非 Creator 看不到 Creator resolve/creator void 表单；
- Creator 未勾选确认前不能 Resolve；
- closeAt 前不能结算；
- 结算成功后状态不可逆；
- 页面不会替 Creator 自动选择结果；
- 结算结果和测试物料表一致。

### 场景 10：退款与领取

按交付方提供的独立市场分别测试：

| 市场结果 | 测试钱包 | 操作 |
| --- | --- | --- |
| Resolved 且持有 winning outcome | B 或 C | `Claim winnings` |
| Resolved 且满足 early-bird | 指定钱包 | `Claim early bird` |
| Creator void | 有 principal 的钱包 | `Refund principal` |
| Timeout void | 有 principal 的钱包 | `Refund principal` |
| Timeout bonus eligible | 指定钱包 | `Claim timeout bonus` |

Timeout 市场到交付方提供的 `resolutionDeadline` 后，任意钱包可先点击
`Permissionless timeout void`，再由各自钱包领取适用款项。

预期体验：

- 钱只支付给固定持有人，调用人不能修改收款地址；
- 不适用或重复领取应明确失败，不产生假成功；
- 领取成功后余额变化与交付方提供的预期一致；
- 页面不会因为一次失败自动重复领取。

### 场景 11：回执与事件

1. 打开“回执与事件”。
2. 对购买、领取等全局记录核对 action、时间、included block 和 tx hash。
3. C2C 和内嵌 Creator 结算在各自卡片内保存 included block/hash；它们当前不会进入全局列表。
4. 对可点击的记录打开 Arbiscan；其他记录复制 tx hash 到 Arbiscan，确认 receipt 为 success。
5. 在刷新或离开相关卡片前保存必要的 tx hash 和截图。

预期体验：

- 成功操作有链上 hash，不仅是 Toast；
- rejected、simulation revert 或本地校验失败没有成功 hash；
- 页面刷新后本地 Activity 清空属于当前设计，Arbiscan receipt 仍可查询。
- C2C/内嵌结算未进入全局回执列表属于当前已知体验缺口。

## 7. 失败与恢复体验

至少手测以下失败场景，每个场景只触发一次，不重复发送经济交易：

| 场景 | 预期表现 |
| --- | --- |
| 页面为 LOCKED | 所有经济写按钮不可用，说明失败原因 |
| 钱包在错误网络 | 显示 Wrong chain，并提供“切换网络” |
| 用户拒绝连接/签名/交易 | 不显示成功、不产生 hash、不自动重试 |
| 快速双击购买或领取 | 最多发送一笔交易 |
| 输入 0、负数、越界 Outcome 或过高滑点 | 页面校验或 simulation 阻止发送 |
| 市场已关闭 | buy 不发送或链上明确拒绝 |
| 账户在测试中切换 | 页面主动断开并要求重新连接 |
| RPC 暂时失败 | 显示失败，不把未知结果当成功 |
| 测试 ETH 不足 | 清楚提示 gas/余额问题，不建议切换真实资产网络 |

若钱包已经弹出交易并可能发送，但页面结果未知，停止操作，保存钱包中的 tx hash 并联系交付方核对
receipt。不要再次点击同一按钮。

## 8. 移动端体验

使用窄屏或手机浏览器只检查：

- 概览；
- 部署验证；
- 市场；
- 创建市场；
- 持仓；
- 顶部状态、钱包连接、表单布局、滚动和安全提示。

当前移动端底部导航没有 C2C、结算与作废、回执与事件，因此不能把移动端完整 E2E 标为通过。
如果本轮验收要求手机完成交易全链路，应先补齐导航和页面入口，再交甲方测试。

## 9. 当前不作为甲方 PASS 项的能力

以下能力当前保持 `未提供 / 不适用 / 已知限制`，不能让甲方通过技术操作补齐：

- 市场全文搜索和高级筛选；
- 通过 UI 创建 15 分钟开放期市场；
- 一键分享 Listing ID；
- C2C Permit2 fill；
- settlement evidence 上传；
- Paymaster/UserOperation 免 gas 体验；
- 移动端 C2C、结算和回执入口；
- 刷新后持久化本会话 Activity；
- C2C 和 Creator 结算写入自动汇总到全局回执列表；
- 完整消费者产品的信息架构、内容展示和非技术化创建市场流程。

如果甲方认为上述能力属于本轮验收目标，应记录为产品缺口，而不是测试失败后改成“操作不当”。

## 10. 通过标准

本轮甲方手测可以标记为通过，需要同时满足：

- Go / No-Go 检查全部通过；
- A/B/C 三个角色能正确连接，切换账户不会串角色；
- ctUSD 领取、Allowance buy、Permit2 buy 和持仓变化符合预期；
- C2C allowance listing/fill/cancel 的实际资产变化正确；
- Resolve、void、timeout 和适用 claim/refund 使用独立市场完成；
- 每笔成功写入都有保存的 tx hash 和可查询的 Arbiscan receipt；
- 拒签、错误网络、无效输入、重复点击和 RPC 失败不会产生假成功或自动重试；
- 所有已知限制已提前告知，测试中没有要求甲方处理私钥、地址包、Hash、CID 或 ABI；
- 没有未解释的资产变化、重复交易或未知结果。

仅完成页面浏览、源码测试、私钥 runner 或后台交易，不能替代甲方手测体验通过。

## 11. 问题记录模板

```md
### 问题标题

- 测试日期/时区：
- 环境 URL：
- 浏览器/设备：
- 钱包角色：A Creator / B Trader / C Counterparty
- 钱包公开地址：
- 页面：
- Market Vault：
- 操作前状态：
- 操作步骤：
- 预期结果：
- 实际结果：
- 是否弹出钱包：是 / 否
- tx hash（如有）：
- Arbiscan receipt：success / reverted / pending / unknown / 无交易
- 截图或录屏：
- 是否可重复：总是 / 偶发 / 未重试
- 严重程度：阻断 / 高 / 中 / 低
- 备注：
```

问题报告只记录公开地址和 tx hash，不记录助记词、私钥、签名、RPC credential 或其他秘密。
