# Cpredict Web Demo 浏览器验收记录

日期：2026-08-17

目标：本地 production build / Vite preview

网络配置：Arbitrum Sepolia，chainId `421614`

## 结论

桌面与移动端的生产构建浏览器验收通过；当前页面正确显示
`BLOCKED_NOT_DEPLOYED / LOCKED`，不会在缺少 `FINALIZED_VERIFIED` 部署清单和钱包时开放写交易。
本记录不等于 Arbitrum Sepolia 部署、真实钱包交易或边缘响应头验收。

## 运行证据

- 桌面视口：`1440×900`；本机截图 `overview-desktop-runtime.png`（Git 忽略，不是源码证据）。
- 移动视口：`390×844`；本机截图 `mobile-runtime.png`（Git 忽略，不是源码证据）。
- 生产页面控制台：本次导航后 0 条 error/warning entry。
- 部署验证页：显示完整调试地址表单和 LOCKED 写门禁。
- 市场页：显示手工 Vault 输入与链上读取入口；无 Vault/钱包时不渲染伪造市场。
- 生产 CSP：`script-src 'self'`、`style-src 'self'`，无 `unsafe-inline`、无 `unsafe-eval`。
- 开发态仅为 Vite CSS 注入临时增加 `style-src 'unsafe-inline'`；生产 HTML 和边缘配置不包含该值。

## 视觉保真 ledger

| 验收点 | 结果 | 说明 |
| --- | --- | --- |
| 白/深蓝/蓝/琥珀/绿色状态体系 | PASS | 保留 trust-first 状态层级，不使用概念图作为背景 |
| 桌面固定左侧导航 | PASS | 八个协议工作区入口完整 |
| 顶部 trust/wallet 状态 | PASS | LOCKED 与未发现钱包状态清晰 |
| 四张紧凑状态卡 | PASS | 部署、钱包、市场、Paymaster 均不伪造数据 |
| 右侧地址检查器 | PASS | Chain/Wallet/Factory/Marketplace/USDC/Permit2/Market |
| 会话事件与回执 | PASS | 明确区分本地状态与链上 receipt |
| 移动双列状态卡 | PASS | 390px 下无横向溢出 |
| 移动底部导航 | PASS | 概览、验证、市场、创建、持仓可达 |

## 未验证边界

- 仓库尚无 Arbitrum Sepolia 正式部署清单，因此未出现 `VERIFIED`。
- 本机浏览器未安装/注入测试钱包，未执行签名和链上交易。
- `/rpc`、`/indexer`、`/evidence` 的生产反向代理、TLS 和真实响应头未部署。
- 三钱包 Full/Clone、Allowance/Permit2、C2C、resolve/void/claim/refund E2E 尚待测试链部署后执行。
