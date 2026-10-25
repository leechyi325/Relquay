# 当前部署与维护

当前实例为 Ubuntu ARM64，入口 `https://safe.leechyi.xyz:28443`；TCP 28080 只跳转。网关、CloudCLI、FileBrowser 和 Caddy 管理接口仅监听回环。

## 兼容已有实例

显示名称改为 RoamDeck，现有目录仍为 `/home/ubuntu/compileverse/studio/`，四个数据根仍在其父目录。这些是既有安装的兼容路径，不代表工具只适用于某类项目。

已有服务为 `compileverse-studio`、`compileverse-cloudcli`、`compileverse-filebrowser`、`compileverse-https`。Android 包标识沿用 `xyz.leechyi.compileverse`；升级使用相同签名，保留登录和 Keystore。

服务器需要 Node ≥24、构建工具和 tmux；AI 客户端按 `upstream/package-lock.json` 安装。环境脚本 `/home/ubuntu/compileverse/env.sh` 提供基础工具 PATH。`install-server.sh` / `publish-https.sh` 当前适配这套 Ubuntu 布局；其他部署可通过 `.env.example` 的网关参数与自己的进程管理器配置。

```bash
npm ci
npm run build
rsync -az --exclude .git --exclude node_modules --exclude .runtime \
  --exclude .state --exclude private --exclude artifacts --exclude android \
  ./ ubuntu@safe.leechyi.xyz:/home/ubuntu/compileverse/studio/app/
```

运行中的服务保留状态。需要更新网关时先检查活动会话/任务，再重启 `compileverse-studio`。纯静态界面更新无需重启网关。APK 单独复制至服务器 `studio/app/dist/downloads/`。

```bash
sudo systemctl status compileverse-studio compileverse-cloudcli compileverse-filebrowser compileverse-https
journalctl -u compileverse-studio -n 80 --no-pager
```

## 凭据和备份

初始工作台密码位于 mode-600 `studio/access.json`，本机副本为 ignored `private/access.json`。AI 账号由本人在终端授权，不能把其他设备凭据直接复制过去。

备份 `studio/state/`、用户工作目录和 AI 用户配置；这些内容不提交 Git、不放入公开下载目录。tmux 支持断线续接；主机重启后原进程不保证恢复。网关重启后原运行队列项会标记中断。

代码回滚恢复对应提交的源码/静态文件后重启网关；停止四个新增服务可停用工作台，保留状态与工程。

## HTTPS 维护

当前 Let's Encrypt 证书通过 Spaceship 手动 DNS-01 签发，**北京时间 2027-01-23 12:15 到期**；尚未配置自动续签，建议在 2026 年 12 月续签。当前 TXT 不属于永久续签凭据。

证书存放在 `studio/state/tls/fullchain.pem` / `privkey.pem`；部署脚本优先保留它们。ACME 程序位于 `studio/acme-source/acme.sh`，配置在 `studio/state/acme/`。执行 renew 后按输出更新 Spaceship TXT，再运行验证；成功后安装并重载。

```bash
studio=/home/ubuntu/compileverse/studio
"$studio/acme-source/acme.sh" --home "$studio/state/acme" --config-home "$studio/state/acme" \
  --renew -d safe.leechyi.xyz --ecc --server letsencrypt \
  --yes-I-know-dns-manual-mode-enough-go-ahead-please
"$studio/acme-source/acme.sh" --home "$studio/state/acme" --config-home "$studio/state/acme" \
  --install-cert -d safe.leechyi.xyz --ecc \
  --key-file "$studio/state/tls/privkey.pem" --fullchain-file "$studio/state/tls/fullchain.pem" \
  --reloadcmd 'sudo systemctl reload compileverse-https'
```

Android 默认仅信任系统 CA，不随仓库分发实例专用 CA 或私钥。

## 0.2 升级

保留 state、账号、签名与包标识。首次启动沿用四个旧文件根；用户首次修改模块后写入 state/file-modules.json。Android 旧 token 一次迁移到按 origin 分项的加密存储，不复制到新服务器。

模块目录边界默认 home 与 STUDIO_BASE。若要绑定 `/srv/projects`，在网关服务环境配置 `STUDIO_BROWSE_ROOTS=/home/ubuntu:/srv/projects`。网页跨服务器使用时配置目标服务的 `STUDIO_CLIENT_ORIGINS` 为客户端网页的精确 scheme/host/port；Android 不需要额外开放来源。

升级前检查 CloudCLI 运行会话、网关 Codex processing 和任务队列。只有全部空闲才重启网关。新接口要求前后端一并升级；备份原 app 源码/dist 与模块配置后发布，保留旧 APK。原生升级由相同 debug 签名验证。


## 0.3 升级

沿用包标识、签名与按服务器保存的 Keystore。Android versionCode 为 5。前后端需一起升级，保留原 state；新增的 notifications.json 与 token-usage.json 均为私有状态，不公开或提交。旧会话没有快照时显示尚未报告，不扫描历史文稿估算 Token。

升级后在 Android 提醒中心主动开启后台监听并授权。FGS 类型 specialUse 的用途已写入 manifest；如以后发布到 Google Play，需另按商店审核要求申报该用途。当前交付为同签名 APK。服务器登录有效期仍为七天，过期需本人登录；不在后台自动保存密码或给 AI 授权。
