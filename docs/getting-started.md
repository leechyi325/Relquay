# 安装与首次连接

[返回首页](../README.md) · [使用指南](user-guide.md) · [部署维护](deployment.md)


以下步骤面向全新服务器。已有实例请先看[升级流程](deployment.md#升级既有实例)，不要直接覆盖生产目录。手机 App 是操作入口，服务器上的 RoamDeck、CloudCLI 和 AI 客户端才负责实际运行；无须安装 Claude 手机 App。

## 1. 准备一台服务器

当前实际验证环境是 Ubuntu ARM64；源码和轻量服务端包都不捆绑机器架构相关的 node_modules，目标机按锁文件安装。准备：

- 普通用户账号、**Node.js ≥24 和 npm**，用 `node -v` / `npm -v` 检查；系统包仓库的旧 Node 可能不满足要求。
- `git`（从源码安装时）、`tmux`、`python3`、`make`、`g++`、CA 证书。Ubuntu 可运行 `sudo apt-get update`，再 `sudo apt-get install -y git tmux python3 make g++ ca-certificates`；Node.js 另外安装到满足版本。
- 公网使用的域名、可信 HTTPS 和云/主机防火墙规则；先在回环验证，再开放反代入口。

不要以 root 身份运行代理；项目、账号和配置归运行工作台的普通用户所有。

## 2. 获取源码，或使用服务端包

源码安装：

```bash
git clone https://github.com/leechyi325/RoamDeck.git "$HOME/roamdeck/app"
cd "$HOME/roamdeck/app"
npm ci --include=dev
npm ci --prefix upstream
npm run build
```

`upstream` 安装锁定的 CloudCLI、Codex 和 Claude Code，不要求全局 npm 安装。网关通过 tsx 启动，所以应用依赖目前需要包含 devDependencies。

也可以在已有完整 Git 源码和依赖的电脑上运行：

```bash
npm run server:package
```

生成 `artifacts/roamdeck-server-0.4.5.tar.gz` 及同名 `.sha256`，上传到服务器的私有目录。包内有预构建网页、服务端及相关源码、锁文件和文档，**不含依赖、AI 账号、工作台账号、AGENTS.md、项目文件或 APK**。它是联网安装包，不是离线单文件程序；当前不自动发布到 GitHub Releases。

收到包与校验文件后，在两者所在目录执行：

```bash
sha256sum -c roamdeck-server-0.4.5.tar.gz.sha256
mkdir -p "$HOME/roamdeck/app"
tar -xzf roamdeck-server-0.4.5.tar.gz --strip-components=1 -C "$HOME/roamdeck/app"
cd "$HOME/roamdeck/app"
npm ci --include=dev
npm ci --prefix upstream
```

已有预构建网页，不再需要 `npm run build`。这两条路线后续步骤相同；安装目录应为空，新服务器不要套用到已有生产目录。

## 3. 写入运行环境

下面将程序、数据和账号分开，路径不依赖旧实例的 `/home/ubuntu/compileverse`。先把示例 `STUDIO_ORIGIN` 改成你将使用的 HTTPS 域名与端口：

```bash
mkdir -p "$HOME/roamdeck"
cat > "$HOME/roamdeck/env.sh" <<'SH'
export ROAMDECK_APP="$HOME/roamdeck/app"
export PATH="$ROAMDECK_APP/upstream/node_modules/.bin:$PATH"
export STUDIO_BASE="$HOME/roamdeck/workspace"
export STUDIO_STATE="$HOME/roamdeck/state"
export STUDIO_ACCESS_FILE="$HOME/roamdeck/access.json"
export STUDIO_OWNER_USERNAME=owner
export STUDIO_HOST=127.0.0.1
export STUDIO_PORT=3080
export CLOUDCLI_URL=http://127.0.0.1:3001
export STUDIO_ORIGIN=https://workspace.example.com:28443
export STUDIO_ENV_FILE="$HOME/roamdeck/env.sh"
SH
chmod 600 "$HOME/roamdeck/env.sh"
source "$HOME/roamdeck/env.sh"
mkdir -p "$STUDIO_BASE"/{project,inputs,outputs,logs,studio} "$STUDIO_STATE"
chmod 700 "$STUDIO_STATE"
cat > "$STUDIO_BASE/studio/terminal.rc" <<'SH'
if [ -f "$HOME/.bashrc" ]; then source "$HOME/.bashrc"; fi
source "$HOME/roamdeck/env.sh"
SH
```

网关不会自动读取 `.env`，每次启动都要加载此环境。修改 `ROAMDECK_APP` 路径时，同步后续命令和服务配置。

## 4. 启动 CloudCLI，建立工作台账号，再启动网关

在第一个 SSH 终端启动 CloudCLI，保持它运行：

```bash
source "$HOME/roamdeck/env.sh"
cd "$ROAMDECK_APP"
HOST=127.0.0.1 SERVER_PORT=3001 NODE_ENV=production cloudcli
```

在第二个 SSH 终端执行：

```bash
source "$HOME/roamdeck/env.sh"
cd "$ROAMDECK_APP"
node scripts/bootstrap-owner.mjs
npm run server
```

初始化脚本仅访问回环 CloudCLI，首次创建 `owner` 和随机密码，保存在权限 600 的 `$HOME/roamdeck/access.json`，不打印密码。由你在服务器私下查看该文件并用于登录；不要上传或分享。重复初始化会保留既有凭据。若注册时网络失败，文件也保留；先检查 CloudCLI 状态，确认账号是否已经建立，不要直接删掉凭据文件重来。已有 CloudCLI 账号但缺失凭据文件时不会自动重置账号。

第三个终端检查：

```bash
curl -f http://127.0.0.1:3080/api/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/api/files
```

应分别得到健康 JSON（0.4.5）和 **401**。初次试用可从电脑建立 `ssh -L 3080:127.0.0.1:3080 用户@服务器`，在浏览器访问 `http://127.0.0.1:3080`。公网手机使用下一步的 HTTPS。

## 5. 配置 HTTPS 与后台常驻

将可信 HTTPS 反向代理指向 `127.0.0.1:3080`，支持 WebSocket 和文件上传；只对公网开放反代端口，CloudCLI 3001 和网关 3080 保持回环。非标准端口证书可使用 DNS-01，证书不会因为端口放行而自动签发。

前面的两个前台进程用于首次验证，SSH 关闭会停止它们。验证后按 [通用 systemd 用户服务](deployment.md#通用-systemd-用户服务) 配置常驻与开机启动，再关闭前台进程，避免端口冲突。HTTPS 示例与证书维护见 [部署文档](deployment.md#新服务器的-https-反向代理)。旧 `install-server.sh` / `publish-https.sh` 仍服务于旧实例，**不用于这条通用安装路线**。

## 6. 授权 AI 并从手机连接

以同一服务器用户加载环境后，运行 `codex login`，以及 `claude auth login`，由账号本人按 CLI 指引授权；第三方接口也可在代理设置里按 [配置指南](configuration.md) 填写。工作台登录和 AI 授权是两套账号，安装客户端不代表已登录。长期服务也必须使用同一用户、home 和环境。

安装 Android APK，在服务器列表添加实际 HTTPS 地址，用工作台账号登录。使用其他人的预构建 APK 也可添加自己的服务器，无须为每个域名重新构建 App。Android 打包仅在修改客户端或首次分发 APK 时需要；见 [Android 构建](deployment.md#android-构建)。

服务端包和首次安装步骤不会自动配置 DNS、防火墙、TLS、systemd 或 AI 授权，这些需要服务器所有者完成。既有生产实例升级请走 [维护流程](deployment.md#升级既有实例)，先备份并确认没有运行任务，不要直接重新安装。
