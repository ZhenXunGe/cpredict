# 云机仅反代、本机运行 Compose：反向隧道部署手册

## 1. 适用范围与完成标准

本模式只用于低并发、短期的 Arbitrum Sepolia 同事体验环境：Docker Compose、Indexer 和 PostgreSQL
继续运行在一台始终在线的 Mac，最低档 Ubuntu 云机只运行 Nginx、Certbot 和 OpenSSH。

```text
同事浏览器 → HTTPS + Basic Auth / 云机 Nginx
           → 云机 127.0.0.1:4177
           → 受限 SSH reverse forwarding
           → Mac 127.0.0.1:4177 / Docker Compose
```

完成标准不是“SSH 进程存在”，而是两侧 `verify` 均通过，并完成本机重启、云机重启和断网恢复演练。
本模式不提供高可用、云端数据库备份或本机离线容错，不得承载主网或真实资金。

## 2. 购买与网络前提

云机建议 Ubuntu 24.04 x86-64、1 vCPU、1 GiB 内存、10–20 GiB 磁盘和独立公网 IPv4。安全组只开放：

- TCP 80/443：同事访问和 ACME；
- SSH 端口：管理员来源和运行 Mac 的公网出口 IP/CIDR；
- **不得开放 4177**，它只能由 SSH 在云机 `127.0.0.1` 上监听。

如果 Mac 的公网出口 IP 经常变化，SSH 安全组规则也会失效。应使用固定出口/VPN、及时更新安全组，或
接受短期中断；不要为了省事永久向全网开放密码 SSH。生成器支持非 22 SSH 端口，但不会替你修改云机
现有 sshd 监听端口，必须先从云厂商控制台验证该端口真实可用。

安装器不会修改云厂商安全组或 UFW：它无法可靠猜测管理员和 Mac 的出口 CIDR，自动修改可能直接导致
SSH 锁死。购买后必须先在控制台完成上述规则，并保留 Web/VNC/串口恢复入口。

Mac 必须接电并关闭其他会覆盖休眠策略的软件；worker 运行时使用 `caffeinate -s` 防止 AC 供电下系统
休眠。合盖、断电、系统更新重启和网络故障仍会中断体验，必须通过演练验证恢复。

## 3. 固定云机 SSH 身份

先从云厂商 Web/VNC/串口控制台登录，不要把一次未经验证的 SSH 首连本身当成信任来源。读取云机
Ed25519 host key 指纹：

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

记录完整 `SHA256:...`。本地安装器会用 `ssh-keyscan` 取得当前公钥并逐字比较该指纹；不匹配时拒绝
启动无人值守隧道。云机重装或 host key 合法轮换后必须重新生成包，不能关闭 StrictHostKeyChecking。

## 4. 生成自包含包

本步骤在当前仓库执行，不需要云机安装 Node 或 Docker。公网 IP 示例：

```bash
npm run stack:tunnel:render -- \
  --host <PUBLIC_IPV4> \
  --mode ip \
  --email <ACME_EMAIL> \
  --ssh-host <PUBLIC_IPV4> \
  --ssh-port 22 \
  --host-key-sha256 'SHA256:<ED25519_FINGERPRINT>'
```

域名模式把 `--host` 改为已解析到云机的域名并使用 `--mode domain`；`--ssh-host` 仍可填写公网 IP。
输出位于 `runtime/reverse-tunnel/<PUBLIC_HOST>/`，其中包含：

- `cloud/cpredict-tunnel-cloud`：云端 `install/status/verify/logs/restart/uninstall`；
- `macos/cpredict-tunnel`：本机对应命令；
- `macos/cpredict-tunnel-worker` 与 launchd 模板；
- Nginx、证书签发/续期、受限 sshd 配置；
- `SHA256SUMS` 和 `verify-package.sh`。

先在本机执行：

```bash
bash runtime/reverse-tunnel/<PUBLIC_HOST>/verify-package.sh
```

生成器拒绝覆盖已有输出；参数改变时保留旧包作审阅证据，选择新的显式 `--output`，或人工确认后删除
旧的 `runtime/` 生成物再生成。包里没有 SSH 私钥、Basic Auth 密码或 RPC 密钥。

## 5. 推荐：Mac 一条命令上传、安装并验收

准备一个非 root 云机管理员账号（Ubuntu 镜像通常为 `ubuntu`）及其本地私钥绝对路径。私钥权限必须为
`0400` 或 `0600`。在 Mac 执行：

```bash
bash runtime/reverse-tunnel/<PUBLIC_HOST>/macos/cpredict-tunnel deploy-cloud \
  --admin-user ubuntu \
  --admin-key /Users/<LOCAL_USER>/.ssh/<CLOUD_ADMIN_KEY> \
  --basic-auth-user colleague \
  --install-autossh \
  --disable-default-site
```

该命令按固定顺序自动执行：

1. 校验生成包和云机 Ed25519 host key；
2. 检查/安装 autossh，生成专用 tunnel key，安装但暂不启动 launchd；
3. 用固定 host key 和指定管理员私钥创建云端 `0700` 临时目录；
4. SCP 上传完整包和**公钥**，再在云机重新验证 `SHA256SUMS`；
5. 通过带 TTY 的 SSH 运行云端 sudo installer；
6. 启动本机 launchd，执行本机 verify；
7. 最长等待 60 秒执行云端 verify；
8. 全部通过后删除云端临时上传目录并输出公网 URL。

管理员私钥可以有口令；SSH、sudo 和 Basic Auth 密码提示都发生在当前终端，不进入参数、包或日志。成功
标志必须是：

```text
CPREDICT REVERSE TUNNEL DEPLOY PASS
```

上传、安装或验收失败时脚本不会打印成功，也不会删除云端 `/tmp/cpredict-reverse-tunnel.*` 临时目录；
它会输出精确路径供排查。修复网络、证书、安全组或本机 readiness 后可重跑同一条命令。脚本不会自动
修改云安全组、UFW、DNS，也不会启动本地 Compose，这三项必须在前置步骤完成。

以下第 6–8 节是自动流程的展开说明，也是某个阶段失败后的手工恢复路径。

## 6. 手工恢复：本机先生成专用密钥，不启动

确认完整 Compose 已经在 Mac 上通过：

```bash
npm run stack:status
npm run stack:verify
curl --fail http://127.0.0.1:4177/readyz
```

然后准备本机服务：

```bash
bash runtime/reverse-tunnel/<PUBLIC_HOST>/macos/cpredict-tunnel \
  install --install-autossh --defer-start
```

`--install-autossh` 是显式 Homebrew 写操作；若已经安装则不会重复安装。脚本生成独立 Ed25519 无口令
密钥，私钥权限固定为 `0600`，路径为 `~/.cpredict/reverse-tunnel/id_ed25519`。无口令仅用于无人值守
重连，风险由云端 authorized_keys 和 sshd 双重限制：只能建立远程转发、只能监听
`127.0.0.1:4177`，不能 Shell 登录、TTY、Agent/X11、用户 rc 或其他端口转发。

不要把私钥复制、截图或上传到云机。只传输 `.pub` 公钥。

## 7. 手工恢复：安装云端入口

通过已验证的管理员 SSH/SCP 通道，把整个生成包和以下公钥复制到云机临时目录：

```text
~/.cpredict/reverse-tunnel/id_ed25519.pub
```

先在云机验证包：

```bash
bash <PACKAGE_DIR>/verify-package.sh
```

然后安装。全新 Ubuntu 默认站点必须显式允许关闭；脚本只会移除指向
`/etc/nginx/sites-available/default` 的标准 symlink，其他文件一律拒绝覆盖：

```bash
sudo bash <PACKAGE_DIR>/cloud/cpredict-tunnel-cloud install \
  --public-key-file ./id_ed25519.pub \
  --basic-auth-user colleague \
  --disable-default-site
```

脚本会安装 Nginx、OpenSSH、Certbot 和检查工具，交互式请求 Basic Auth 密码，创建
`cpredict-tunnel` 专用用户，验证 `sshd -t`/`nginx -t`，签发证书并启用续期 timer。密码不能通过参数
传入。已有 `/etc/nginx/cpredict.htpasswd` 时默认拒绝；确认要复用且文件中已经存在指定用户名后才加
`--reuse-htpasswd`，脚本不会向其他站点拥有的认证文件静默新增账号。

公网 IP 模式要求实际安装到的 Certbot 支持 IP short-lived profile；不满足时安装失败关闭，不会降级成
HTTP。安装过程中断时可修复外部原因后重跑同一命令；状态保留为 `installing`，不会伪装成成功。

## 8. 手工恢复：启动与验收

回到 Mac 启动 launchd：

```bash
~/.cpredict/reverse-tunnel/cpredict-tunnel restart
~/.cpredict/reverse-tunnel/cpredict-tunnel status
~/.cpredict/reverse-tunnel/cpredict-tunnel verify
```

Mac 的 `verify` 固定 host key、确认私钥权限、本地 `/readyz`、launchd 和公网未认证 `401`。随后在云机
执行真正的隧道验收：

```bash
sudo cpredict-tunnel-cloud status
sudo cpredict-tunnel-cloud verify
```

云端 `verify` 必须确认：SSH/Nginx 正常、4177 只有 `127.0.0.1:4177` listener、隧道后的
`/readyz` 为 2xx、HTTPS 未认证为 401。最后从同事的另一条网络执行：

```bash
curl -I https://<PUBLIC_HOST>/readyz
curl -u colleague https://<PUBLIC_HOST>/readyz
```

预期依次为 401 和 200。第二条命令交互输入密码，不把密码写入命令或 shell history。浏览器还应完成
钱包连接、市场读取和最小测试网操作；curl 不能替代业务验收。

## 9. 日常操作和故障定位

Mac：

```bash
~/.cpredict/reverse-tunnel/cpredict-tunnel status
~/.cpredict/reverse-tunnel/cpredict-tunnel verify
~/.cpredict/reverse-tunnel/cpredict-tunnel logs
~/.cpredict/reverse-tunnel/cpredict-tunnel restart
```

云机：

```bash
sudo cpredict-tunnel-cloud status
sudo cpredict-tunnel-cloud verify
sudo cpredict-tunnel-cloud logs
sudo cpredict-tunnel-cloud restart
```

Mac worker 使用 `ServerAliveInterval=30`、`ServerAliveCountMax=3` 和 `ExitOnForwardFailure=yes`；失效连接
会退出，由 launchd/AutoSSH 重建。日志超过 1 MiB 后在下一次 worker 启动时轮换为一份 `.1`，不无限
增长。云端 `restart` 会安全 reload SSH/Nginx 并终止专用 tunnel 会话，验证 Mac 能否自动重连。

## 10. 必须执行的恢复演练

开放给同事前依次执行并在每一步重新跑两侧 `verify`：

1. Mac 关闭 Wi-Fi 60 秒再恢复，确认隧道自动重连；
2. 终止 autossh worker，确认 launchd 拉起；
3. 本机重启并登录，确认 Compose 和 launchd 都恢复；
4. 云机重启，确认 Nginx/SSH 启动且 Mac 自动重连；
5. 临时停止本地 Web Demo，确认公网不出现旧的成功页面，恢复后 readiness 回到 200；
6. `sudo certbot renew --dry-run`；
7. 从非管理员网络验证 4177 无法连接、80 只跳转 HTTPS、443 要求认证。

如果本机断网后公网返回 502，这是预期的 fail-closed 状态；不能把 502 当成隧道恢复成功。

## 11. 卸载与保留边界

先在 Mac 停止隧道并保留密钥：

```bash
~/.cpredict/reverse-tunnel/cpredict-tunnel uninstall
```

再在云机卸载：

```bash
sudo cpredict-tunnel-cloud uninstall
```

云端只删除带管理标记的 Nginx/sshd 文件、Basic Auth 文件（仅当本包创建）、续期 hook 和专用用户；
保留 Nginx/Certbot 软件包及已签发证书。若文件失去管理标记或 tunnel 用户 home 被修改，卸载会拒绝
继续，避免误删用户配置。

确认云端 authorized key 和专用用户已经删除后，才在 Mac 删除私钥：

```bash
bash runtime/reverse-tunnel/<PUBLIC_HOST>/macos/cpredict-tunnel uninstall --delete-key
```

若第一步已删除已安装 CLI，可从原生成包再次运行同一 `uninstall --delete-key` 命令。日志默认保留在
`~/.cpredict/reverse-tunnel/logs/`，便于复盘。
