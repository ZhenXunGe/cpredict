# 单机云主机公网体验部署手册

## 1. 目标与推荐拓扑

本手册的目标是把 Cpredict 的 **Arbitrum Sepolia 同事体验环境**部署到一台云主机，并通过公网
HTTPS + Basic Auth 访问。推荐拓扑是：

```text
同事浏览器 → 公网 443 / 宿主机 Nginx → 127.0.0.1:4177 / Docker Compose
                                          ├─ Web Demo
                                          ├─ Indexer/API/WS
                                          ├─ Metadata（钱包签名的不可变市场规则）
                                          └─ PostgreSQL（不发布宿主机端口）
```

这不是生产高可用架构，也不是主网或真钱环境。相比“云机只做反向隧道、应用仍跑在个人电脑”，完整
部署到云机不依赖笔记本在线、家庭网络和隧道进程，更适合给同事持续体验。如果仍只想让云机转发到
本机，本手册的容量、备份和重启保证不适用；不要混用本手册的 host preflight，改用
[反向隧道部署手册](./15-reverse-tunnel-deployment-runbook.md)。

最低**稳妥**规格是 Linux x86-64、2 vCPU、4 GiB 内存、50 GiB SSD、2 GiB swap、一个独享公网
IPv4。1 vCPU / 1–2 GiB 可能能转发流量，但本机 Docker build、PostgreSQL、Indexer 和 Demo 同时运行
时没有足够余量，仓库预检会失败关闭。购买前确认：

- 有 Web/VNC/串口控制台和快照能力，SSH 配错时仍能恢复；
- 公网 IPv4 不是共享 NAT，安全组允许 80/443 入站和 443 出站；
- 22 端口可以只放行管理员固定 IP/CIDR；
- 系统盘可以扩容，提供商不会过滤 ACME 所需的 80 端口；
- 选择符合公司数据与访问合规要求的地域，不把“只用 IP”当成合规规避手段。

## 2. 上机前先记录

先在密码管理器或受控工单中记录下列值，不要写进 Git、聊天或 shell history：

```text
PUBLIC_HOST=<公网 IPv4 或域名>
ACME_EMAIL=<证书通知邮箱>
ADMIN_CIDR=<SSH 管理来源>
OPERATOR=<现有非 root sudo 用户，示例 ubuntu>
REVIEWED_COMMIT=<要部署的完整 40 位 Git commit>
VM_SNAPSHOT_ID=<部署前快照>
```

部署私钥、RPC URL、数据库密码、Explorer key 和 Basic Auth 密码只进入权限为 `0600` 的服务器文件
或密码管理器。不要把秘密放到 `VITE_*`、命令行参数或截图中。

## 3. 首次登录与主机基线

以云镜像自带的非 root sudo 用户登录。保留提供商控制台，在关闭密码 SSH 前先用第二个终端验证密钥
登录。推荐 Ubuntu 24.04 LTS；使用其他发行版时不要照抄包管理命令。

```bash
sudo apt-get update
sudo apt-get full-upgrade --yes
sudo apt-get install --yes ca-certificates curl git nginx apache2-utils snapd ufw unattended-upgrades
sudo systemctl enable --now unattended-upgrades
timedatectl status
free -h
df -h /
```

若 `full-upgrade` 更新了内核，先重启并重新执行上述版本/磁盘检查，再继续部署，不要把首次内核重启留到
交付之后。

若没有 swap，先创建 2 GiB swap，并确认 `/etc/fstab` 中没有重复项：

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
grep -qF '/swapfile none swap sw 0 0' /etc/fstab || \
  printf '%s\n' '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

在云安全组和 UFW 中都只开放必要端口。启用 UFW 前必须确认 `ADMIN_CIDR` 正确且第二个 SSH 会话可用：

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from <ADMIN_CIDR> to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

SSH drop-in 至少应包含下列三项；用 `sudoedit /etc/ssh/sshd_config.d/60-cpredict.conf` 写入，先运行
`sudo sshd -t`，再 reload SSH，并从第二个终端重新登录。没有控制台或第二个会话时不要关闭密码登录。

```text
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
```

Docker 必须按 [Docker 官方 Ubuntu 安装文档](https://docs.docker.com/engine/install/ubuntu/) 安装
Engine、Compose plugin 和 Buildx。只把唯一部署操作者加入 `docker` 组；该组等价于 root 权限。重新登录后
验证：

```bash
docker --version
docker compose version
docker buildx version
docker info
docker compose up --help | grep -- --wait
```

Docker 的公网 port publishing 可能绕过单纯的 UFW 规则；本仓库因此把应用端口硬绑定到
`127.0.0.1`，并由 `stack:verify` 读取实际 publisher。若验证看到 `0.0.0.0`/`::`，立即停止交付，而不是
继续补防火墙例外。

## 4. 固定版本安装与仓库预检

建议把 checkout 放在不含空格的 `/srv/cpredict`，由 `OPERATOR` 独占。先 checkout 已评审 commit，再用
仓库脚本安装固定 Node.js 22.22.2；脚本校验 Node 官方 SHA-256，不修改 shell 配置，也不会覆盖已有的
其他 Node 安装。

```bash
sudo install -d -o "$USER" -g "$USER" -m 0750 /srv/cpredict
git clone <REVIEWED_REPOSITORY_URL> /srv/cpredict
cd /srv/cpredict
git checkout --detach <REVIEWED_COMMIT>
git status --short
sudo bash deploy/host/bootstrap-node.sh --apply
node --version
npm ci --ignore-scripts
bash scripts/bootstrap-foundry.sh
npm run stack:preflight
```

`stack:preflight` 必须全 PASS；swap 和 20–50 GiB 剩余空间只会给 WARN，但不应在首次上线时忽略。
它会检查 Linux/x64/Node 22、非 root、内存/磁盘、NTP、Docker daemon、Compose `--wait`、Buildx、
Compose 静态配置、干净 Git 和 Docker context 排除策略。

## 5. Sandbox 测试网部署（会产生链上交易）

只在明确授权后广播。复制模板、填入测试网角色/RPC/预算并限制权限；不要 `source` 文件：

```bash
cp deployments/arbitrum-sepolia/deploy.env.example .env.arbitrum-sepolia.local
chmod 600 .env.arbitrum-sepolia.local
npm run deploy:arbitrum-sepolia -- preflight --profile sandbox
npm run deploy:arbitrum-sepolia -- plan --profile sandbox
npm run deploy:arbitrum-sepolia -- deploy --profile sandbox
```

Web 演示统一使用 `sandbox`：部署脚本会新建 6 位精度 `Cpredict Test USD (ctUSD)`，它只能部署在
Arbitrum Sepolia，任何地址都可任意 mint，且不是 USDC、没有真实价值。不要把本段命令改成 `formal`；
正式清单仍只接受 canonical USDC。所有命令必须持续使用同一 `sandbox` 档位。

`deploy` 会再次 preflight、preview 和精确模拟，并在广播前确认。广播错误或连接中断后，先运行：

```bash
npm run deploy:arbitrum-sepolia -- status --profile sandbox
```

状态为 `BROADCAST_FAILED_REQUIRES_INSPECTION` 时才按工具提示使用 `--resume`。不要重新执行 `deploy`、更换
nonce 或盲发同一交易。等待一小时 Timelock 后：

```bash
npm run deploy:arbitrum-sepolia -- finalize --profile sandbox
npm run deploy:arbitrum-sepolia -- status --profile sandbox
npm run deploy:sync -- candidate \
  --pending deployments/arbitrum-sepolia/pending.json
```

同步工具从 orchestrator state 读取本次实际 Foundry receipt；不要传仓库根目录下的旧 `broadcast/`。
黄色 DEBUG 只表示测试网候选，不是正式发布、审计通过或生产可用。

## 6. Compose 配置、启动与本机验收

生成 6 个互不相同的 URL-safe 密码。`openssl rand -hex 24` 生成 48 位十六进制值，满足解析器要求。
把 RPC 和密码手工填入 `.env.compose.local`，不要把命令输出粘进 shell 命令行：

```bash
cp .env.compose.example .env.compose.local
chmod 600 .env.compose.local
openssl rand -hex 24
```

填完后执行：

```bash
npm run stack:preflight -- runtime --network
npm run stack:config
npm run stack:up
npm run stack:verify
npm run stack:status
```

`CPREDICT_METADATA_PUBLIC_BASE_URL` 必须填写浏览器实际访问的 HTTPS 公网地址加 `/metadata`，例如
`https://101.32.241.211/metadata`；它会永久写入新市场的链上 Metadata URI，不能用容器内地址或 HTTP。
`stack:verify` 不只检查容器名：它读取实际 Docker 资源限制、只读根文件系统、capability、重启策略、
loopback 端口绑定、migration exit code，并逐个确认应用镜像的
`org.opencontainers.image.revision` 与当前 checkout 的精确 Git SHA 相等；同时请求 Demo、Indexer、
Metadata `/readyz`、安全响应头、运行配置和同源 RPC chainId。任一 FAIL 都不要继续开放公网。

仅在确实配置了外部 Auth/KMS/预算 adapter 时才加 `--sponsorship`。默认同事体验环境不启用 Paymaster，
也不向浏览器暴露它。

## 7. 公网 HTTPS、认证和限流

证书建议使用域名；只有公网 IP 时也可用 IP 证书，但需要 Certbot 5.4+，证书约 6 天有效，因此续期
timer 和 deploy hook 是上线门禁。安装 Certbot：

```bash
sudo snap install core
sudo snap refresh core
sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/local/bin/certbot
certbot --version
```

如果 `/usr/local/bin/certbot` 已存在，不要覆盖；确认它指向 `/snap/bin/certbot`。创建同事账号时，
`-c` 只用于第一次创建文件，后续新增/轮换账号不能带 `-c`：

```bash
sudo htpasswd -c /etc/nginx/cpredict.htpasswd colleague
sudo chown root:www-data /etc/nginx/cpredict.htpasswd
sudo chmod 640 /etc/nginx/cpredict.htpasswd
```

域名模式：

```bash
npm run stack:proxy:render -- \
  --host preview.example.com --mode domain --email <ACME_EMAIL>
```

纯公网 IP 模式：

```bash
npm run stack:proxy:render -- \
  --host <PUBLIC_IPV4> --mode ip --email <ACME_EMAIL>
```

先运行 `sudo nginx -T` 审阅现有站点。生成的 installer 如果看到
`/etc/nginx/sites-enabled/default` 会拒绝覆盖；确认它只是 Ubuntu 默认 symlink 后再执行
`sudo unlink /etc/nginx/sites-enabled/default`。然后运行对应目录中的：

```bash
sudo bash runtime/host-proxy/<PUBLIC_HOST>/issue-certificate.sh
sudo nginx -t
sudo certbot renew --dry-run
```

外层 Nginx 强制 HTTPS、Basic Auth、CSP/安全头、连接数/请求速率/请求体/超时限制，只转发到
`127.0.0.1:4177`，并清空 `Authorization`，不会把公网 Basic Auth 凭据传给 Demo、Indexer、Metadata
或付费 RPC。
`/indexer/metrics` 对公网直接拒绝。

必须从**另一条网络**执行验收。`curl -u colleague` 会交互询问密码，避免密码进入 history：

```bash
curl -I https://<PUBLIC_HOST>/readyz
curl -u colleague https://<PUBLIC_HOST>/readyz
curl -u colleague https://<PUBLIC_HOST>/runtime-config.json
curl -u colleague https://<PUBLIC_HOST>/rpc
curl -u colleague --header 'content-type: application/json' --data '{}' \
  https://<PUBLIC_HOST>/metadata/v1/challenges
curl -u colleague --header 'content-type: application/json' --data '{}' \
  https://<PUBLIC_HOST>/metadata/v1/markets
```

预期依次为：未认证 `401`、认证后 readiness `200`、运行配置 `200`、GET RPC `403/405`、两个
Metadata 无效请求均为 JSON `400 {"error":"invalid request"}`。这两个探针在请求校验阶段停止，不会
创建 challenge 或发布市场；若返回 Nginx `403`，说明公网代理没有放行 Metadata POST。浏览器中还要
完成连接钱包、读取市场、创建一笔最小测试网操作的实际体验；静态 curl 不能替代钱包验收。

## 8. 备份、定时任务与重启演练

第一次开放公网前执行实际备份加一次性恢复演练：

```bash
npm run stack:backup:verified
npm run stack:backup:prune
```

第二条默认只打印 `WOULD_REMOVE`。只有确认保留策略后才使用 `--apply`；工具至少保留 7 份，并且最新
有效备份没有匹配的 PASS 恢复报告时拒绝删除。安装每日 systemd timer：

```bash
npm run stack:backup:render-service -- --operator <OPERATOR>
sudo install -m 0644 runtime/host-systemd/<OPERATOR>/cpredict-backup.service /etc/systemd/system/
sudo install -m 0644 runtime/host-systemd/<OPERATOR>/cpredict-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start cpredict-backup.service
sudo systemctl enable --now cpredict-backup.timer
systemctl list-timers --all | grep cpredict-backup
```

本机备份不能覆盖云盘损坏、账号失陷或整机删除。至少把最新的已恢复验证备份加密复制到另一账户/
对象存储，并保留提供商快照；仓库目前没有绑定某个云厂商的异地复制实现。

最后做一次计划内重启：

```bash
sudo reboot
```

重新登录后必须再次执行 `npm run stack:verify`、公网四个 curl、`systemctl list-timers --all`，并确认
`docker compose ps` 中 migration 是 exit 0、其余核心服务 healthy。未做重启演练，不算部署验收完成。

## 9. 升级、回滚和停机边界

每次升级前在旧 commit 的干净 checkout 上运行：

```bash
npm run stack:checkpoint
```

该命令要求当前 runtime 完整 PASS，然后创建数据库备份、执行精确 restore drill，并记录旧 Git commit、
runtime package hash、Compose process 和 image ID。随后再创建云机快照、拉取并 checkout 新的已评审 commit，
运行 `npm ci --ignore-scripts`、静态门禁、`stack:preflight runtime --network`、`stack:up` 和
`stack:verify`。

回滚不是一句 `git checkout`：

- 仅代码/镜像回退且数据库 schema 向后兼容时，checkout 检查点中的旧 commit，重新 build/up/verify；
- migration 已改变且旧代码不兼容时，先停止写入并使用升级前云机快照；不要把 restore-drill 的一次性
  数据库误认为生产恢复命令；
- Indexer 是链上投影，可以从已确认 reference block 重建；Paymaster 预算含防重放/额度状态，启用
  sponsorship 后不能盲目恢复旧预算快照；
- 合约部署交易不可通过 Docker 或数据库回滚。广播结果未知时必须先查 state/receipt/nonce，再决定
  resume，绝不能自动重发。

因此首次体验建议关闭 sponsorship，并在每次迁移前保留 VM 快照。生产数据原地恢复刻意没有自动化；
它需要明确停机窗口、恢复目标和 Paymaster 对账授权。

## 10. 最终验收清单

只有下列项目全部完成，才可以把公网地址交给同事：

- [ ] checkout 是已记录的 40 位 commit，Git 干净；
- [ ] `stack:preflight` 与 `stack:preflight runtime --network` 全 PASS；
- [ ] Debug 合约地址来自本次 orchestrator state/receipt，状态命令无未知广播；
- [ ] `stack:up` 和 `stack:verify` PASS，所有发布端口仅 loopback；
- [ ] 外网未认证 401、认证 readiness/config 200、GET RPC 拒绝；
- [ ] Certbot 5.4+、`renew --dry-run` PASS、续期 timer 存在；
- [ ] Basic Auth 密码独立保存，`Authorization` 不向上游透传，metrics 不公开；
- [ ] `stack:backup:verified` PASS，异地副本和 VM 快照已记录；
- [ ] 实际重启后 Docker、公网和 timer 再次 PASS；
- [ ] 同事只使用测试钱包和测试网资产，页面明确保持 DEBUG/非生产标识。

本地仓库当前只能对这些流程做静态/fixture 验证。真正购买云机后，Docker image build、容器 runtime、
公网 DNS/IP、证书签发、外网钱包操作、Arbitrum Sepolia 广播和重启恢复必须在目标机重新留证。
