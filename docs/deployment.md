# 自托管部署与维护

部署前准备一台 Ubuntu ARM64 主机、自己的域名和 TLS 证书。示例入口使用 `https://workspace.example.com:28443`；请替换为你管理的域名。网关、CloudCLI、FileBrowser 和 Caddy 管理接口应仅监听回环。

## Ubuntu + systemd 部署

安装脚本保留 `COMPILEVERSE_ROOT` 作为既有部署目录的兼容变量；新安装可指定自己的根目录。四个数据根目录 `project`、`inputs`、`outputs`、`logs` 应位于 `STUDIO_BASE` 下。

默认服务名为 `compileverse-studio`、`compileverse-cloudcli`、`compileverse-filebrowser`、`compileverse-https`。Android 包标识当前为 `xyz.leechyi.compileverse`；已有安装升级时需使用相同签名，以保留登录和 Keystore。

服务器需要 Node ≥24、构建工具和 tmux；AI 客户端按 `upstream/package-lock.json` 安装。`install-server.sh` / `publish-https.sh` 适配 Ubuntu + systemd；部署前检查脚本中的根目录、服务用户和反代端口，并按自己的环境调整。

```bash
npm ci
npm run build
rsync -az --exclude .git --exclude node_modules --exclude .runtime \
  --exclude .state --exclude private --exclude artifacts --exclude android \
  ./ USER@YOUR_SERVER:STUDIO_ROOT/app/
```

运行中的服务保留状态。需要更新网关时先检查活动会话/任务，再重启 `compileverse-studio`。纯静态界面更新无需重启网关。APK 单独复制至服务器 `studio/app/dist/downloads/`。

```bash
sudo systemctl status compileverse-studio compileverse-cloudcli compileverse-filebrowser compileverse-https
journalctl -u compileverse-studio -n 80 --no-pager
```

## 凭据和备份

初始工作台密码位于 mode-600 `studio/access.json`，仅保存在服务器；不要提交到 Git 或复制到公开目录。AI 账号由每位用户本人在终端授权。

备份 `studio/state/`、用户工作目录和 AI 用户配置；这些内容不提交 Git、不放入公开下载目录。tmux 支持断线续接；主机重启后原进程不保证恢复。网关重启后原运行队列项会标记中断。

代码回滚恢复对应提交的源码/静态文件后重启网关；停止四个新增服务可停用工作台，保留状态与工程。

## HTTPS 维护

证书应存放在 `studio/state/tls/fullchain.pem` / `privkey.pem`，并设置自动续签与到期提醒。DNS-01 的 TXT 记录按证书服务商说明配置；DNS 凭据和私钥不得提交到仓库。部署脚本优先保留已有证书文件。

```bash
studio="${STUDIO_ROOT:?Set STUDIO_ROOT to the server's RoamDeck directory}"
domain="${STUDIO_DOMAIN:?Set STUDIO_DOMAIN to a DNS name you control}"
"$studio/acme-source/acme.sh" --home "$studio/state/acme" --config-home "$studio/state/acme" \
  --renew -d "$domain" --ecc --server letsencrypt \
  --yes-I-know-dns-manual-mode-enough-go-ahead-please
"$studio/acme-source/acme.sh" --home "$studio/state/acme" --config-home "$studio/state/acme" \
  --install-cert -d "$domain" --ecc \
  --key-file "$studio/state/tls/privkey.pem" --fullchain-file "$studio/state/tls/fullchain.pem" \
  --reloadcmd 'sudo systemctl reload compileverse-https'
```

Android 默认仅信任系统 CA，不随仓库分发实例专用 CA 或私钥。

## 0.2 升级

保留 state、账号、签名与包标识。首次启动沿用四个旧文件根；用户首次修改模块后写入 state/file-modules.json。Android 旧 token 一次迁移到按 origin 分项的加密存储，不复制到新服务器。

模块目录边界默认 home 与 STUDIO_BASE。若要绑定 `/srv/projects`，在网关服务环境配置 `STUDIO_BROWSE_ROOTS=/home/YOUR_USER:/srv/projects`。网页跨服务器使用时配置目标服务的 `STUDIO_CLIENT_ORIGINS` 为客户端网页的精确 scheme/host/port；Android 不需要额外开放来源。

升级前检查 CloudCLI 运行会话、网关 Codex processing 和任务队列。只有全部空闲才重启网关。新接口要求前后端一并升级；备份原 app 源码/dist 与模块配置后发布，保留旧 APK。原生升级由相同 debug 签名验证。


## 0.3 升级

沿用包标识、签名与按服务器保存的 Keystore。Android versionCode 为 5。前后端需一起升级，保留原 state；新增的 notifications.json 与 token-usage.json 均为私有状态，不公开或提交。旧会话没有快照时显示尚未报告，不扫描历史文稿估算 Token。

升级后在 Android 提醒中心主动开启后台监听并授权。FGS 类型 specialUse 的用途已写入 manifest；如以后发布到 Google Play，需另按商店审核要求申报该用途。当前交付为同签名 APK。服务器登录有效期仍为七天，过期需本人登录；不在后台自动保存密码或给 AI 授权。

## Android 构建入口

源码默认使用示例域名。自托管打包时设置 `VITE_STUDIO_ORIGIN=https://你的域名:28443 npm run android:build`，无需把实例域名改回共享源码。已有安装中的服务器列表不受默认值变更影响。

0.3.1 增加“工作台设置 → Claude / Codex 配置文件”。编辑的是服务用户的全局 `config.toml` / `settings.json`，遵循 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`。保存只校验格式；运行中的代理不会被自动重启。

## 0.4 扩展配置与备份

Skills 默认写入服务用户 ~/.agents/skills（Codex）或 ~/.claude/skills（Claude）。MCP 使用各代理原生用户配置；Claude 全局关闭的连接暂存于工作台 state/claude-mcp-disabled.json，备份时保留它以便恢复开关。原配置文件与暂存文件均可能包含连接密钥，不能放进静态目录或 Git。

插件管理调用 PATH 中固定的 codex/claude 命令，默认在服务用户 home 中运行；服务必须具备正常的 CLI、市场配置及所需账号权限。只设置用户级插件，不覆盖项目级配置。支持 CODEX_HOME / CLAUDE_CONFIG_DIR；配置变更不会自动终止已有轮次。

可在服务运行环境执行 `node --import tsx scripts/check-extension-cli.mjs` 验证 CLI 兼容性。该脚本使用临时 CLI 配置目录与空测试插件，结束后清理，不修改正式账号目录。
