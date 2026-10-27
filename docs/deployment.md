# 自托管部署与维护

适用版本：**0.4.5 / Android versionCode 12**。[返回首页](../README.md) · [使用指南](user-guide.md) · [验证记录](validation.md)

## 部署拓扑与前提

当前部署路径经过 Ubuntu ARM64 + systemd 验证；服务器运行代理与任务，Android 打包可在另一台电脑完成。需要 Node.js ≥24、npm、tmux、构建工具、自己的域名和系统 CA 信任的 TLS 证书。上游版本由 [upstream/package.json](../upstream/package.json) 和锁文件固定：CloudCLI 1.37.5、Codex 0.164.0、Claude Code 2.1.310。

```text
手机 / 浏览器 → HTTPS :28443 → Caddy
                                → 网关 127.0.0.1:3080
                                → CloudCLI 127.0.0.1:3001
                                → 可选 FileBrowser 127.0.0.1:3081
网关 → 本机 Codex App Server / 文件 / 队列 / tmux
```

HTTP 28080 用于跳转；Caddy 管理接口默认回环 2019。OCI 安全列表/NSG 和主机防火墙需要分别放行实际选择的公网端口；3001、3080、3081、2019 不对公网开放。AI 账号由本人完成授权，首次工作台账号私下创建，不提供公共注册入口。

## 安装脚本的适用范围

**当前脚本是既有实例的部署脚本，尚不是通用安装器。** 运行前阅读 [install-server.sh](../scripts/install-server.sh)、[bootstrap-owner.mjs](../scripts/bootstrap-owner.mjs)、[publish-https.sh](../scripts/publish-https.sh)，按目标机器调整并复核：

| 假设 | 当前实现 |
| --- | --- |
| 用户和目录 | systemd 用户与初始账号为 `ubuntu`，多个生成脚本和 HTTPS 路径写死 `/home/ubuntu/compileverse/` |
| 根目录变量 | 安装入口接受 `COMPILEVERSE_ROOT`，但它不会改写全部硬编码路径；仅设置该变量不足以迁移部署 |
| 环境 | 需要既有根目录中的 `env.sh` 和相应 runtime；生成的启动脚本会引用它们 |
| 下载架构 | HTTPS / FileBrowser 安装使用固定版本和摘要的 ARM64 二进制 |
| 账号 | 引导账号凭据保存在私有 `studio/access.json`；不是任意用户的通用注册器 |
| 防火墙 | HTTPS 脚本会增补配置端口，并移除历史 80/443 的指定 ACCEPT 规则；应先确认目标主机现有规则 |
| TLS | 找到 `state/tls/fullchain.pem` 和 `privkey.pem` 时使用它们；缺失时回退 Caddy 内部证书，Android 默认不会信任 |

脚本会写配置/服务并启停服务，不应用作常规升级命令。自托管时先完成用户、目录、运行环境、架构、证书和防火墙适配，在隔离机器验证，再安装；不要在其他业务主机上直接照搬执行。

既有部署保留服务名 `compileverse-studio`、`compileverse-cloudcli`、`compileverse-filebrowser`、`compileverse-https`，用于升级兼容。产品名称仍为 RoamDeck。

## 网关运行环境

变量示例见 [.env.example](../.env.example)。网关不自动加载 dotenv，需由 shell、systemd 或启动脚本导出。下面是运行时变量；它们不保证自动替换安装脚本中的固定路径。

| 变量 | 作用与默认值 |
| --- | --- |
| `STUDIO_BASE` | 初始项目/输入/输出/日志父目录；回退旧 `COMPILEVERSE_ROOT`，再回退 `/home/ubuntu/compileverse` |
| `STUDIO_STATE` | 私有状态目录；默认应用目录 `.state`，生产建议独立设置 |
| `STUDIO_HOST` / `STUDIO_PORT` | 默认 `127.0.0.1` / `3080` |
| `STUDIO_ORIGIN` | 公网精确 origin；默认来自 `shared/config.json` |
| `CLOUDCLI_URL` | 默认 `http://127.0.0.1:3001` |
| `FILEBROWSER_URL` | 可选回环 FileBrowser 地址 |
| `STUDIO_ENV_FILE` | 可选后台任务 shell 环境文件 |
| `STUDIO_BROWSE_ROOTS` | 允许绑定的绝对目录，Linux 使用冒号分隔；默认运行用户 home 和 `STUDIO_BASE` |
| `STUDIO_CLIENT_ORIGINS` | 其他工作台网页的精确来源，逗号分隔，含协议/域名/端口 |

创建 `STUDIO_BASE` 下的 `project`、`inputs`、`outputs`、`logs`，确保运行用户有相应权限。模块修改后保存在状态文件中，升级应保留它。浏览器在 A 工作台连接 B 时由 B 允许 A 的网页来源；Android 固定应用来源已内置，无需通配 CORS。

部署源码只传工具仓库。保留实例 `shared/config.json`，不要用仓库里的 `workspace.example.com` 覆盖实际域名。首次安装需要分别安装应用与上游锁定依赖，将上游 CLI 加入服务 PATH，并私下建立 CloudCLI 所有者；网关启动不等于已配置上游或登录 AI。

## 升级既有实例

1. 核对当前提交、应用版本、服务用户、路径、证书、签名和状态位置。将源码/静态文件及私有状态备份到 Web 根目录之外，备份限制为所有者可读写；保留旧 APK。
2. 在独立 staging 目录安装锁定依赖、类型检查、测试并构建。前后端按同一版本发布；若修改原生或内置 UI，重新构建同签名 APK。
3. 检查后台队列中排队/运行/取消中的任务、CloudCLI 运行会话及网关 Codex processing。确认全部空闲再重启网关；不要为发布强行打断用户任务。
4. 分别发布服务源码和检查过的静态文件，保留私有状态、账号、TLS、实例配置及下载目录。复制时不要对整个运行目录执行 `--delete`；不要覆盖生产用户配置。
5. 重启需要更新的服务；纯静态更新无需重启网关，文档改动无需重启或构建 APK。验证 HTTPS、版本、未登录受保护接口的 401、登录后基本功能及 APK 摘要。

Vite 默认构建会清空 `dist`，其中若有发布的 `dist/downloads/` 会被一起删除。**不要在运行中的应用目录直接执行默认构建。** 在 staging 目录可使用独立输出：

```bash
npm ci
npm run typecheck
npm test
npm exec vite -- build --outDir .runtime/release-dist
```

此目录应先检查，再发布 `index.html` 和资源，保留运行目录的 downloads。不是完整通用部署命令；实际路径/服务按目标实例处理。依赖版本不随例行发布任意升级。

```bash
sudo systemctl status compileverse-studio compileverse-cloudcli compileverse-filebrowser compileverse-https
journalctl -u compileverse-studio -n 80 --no-pager
```

上述服务名针对现有部署。查看日志应避免将用户消息、命令、凭据或认证响应复制到公开问题中。

## 备份与回滚

至少备份私有 `state/`、用户项目数据、原生 AI 用户配置/授权目录、必要的 CloudCLI 状态、部署环境、TLS 和原 APK 签名材料。`state/` 包括登录、模块、任务日志、Codex 会话、通知、Token 快照、附件及 Claude 停用 MCP 暂存；配置/暂存文件也可能含密钥。`access.json` 权限为 600，不放进 Git、APK 或静态下载目录。

回滚源码和静态资源到匹配版本后，再在空闲窗口重启网关。状态兼容性单独检查，不把旧备份直接覆盖到含新任务/文件的状态目录。tmux 可以保留断线会话，不保证主机重启后进程存活；网关重启会将原运行任务标记中断。

停止新增 systemd 服务可停用工作台，保留工程和状态。不要以清空账号目录、删除 shell 历史或重建 Keystore 作为常规升级步骤。

## TLS 与 DNS-01 维护

公开入口使用浏览器和 Android 系统 CA 信任的证书；Android 不随仓库分发实例专用 CA 或私钥。仅改用不常见端口不会完成证书签发，也不会替代登录与 HTTPS。

既有实例通过 Spaceship 手动添加 DNS-01 TXT 记录完成签发，**当前不是自动续签**。续签时需读取 ACME 客户端给出的新挑战值，在域名 DNS 面板更新 `_acme-challenge` TXT，确认公开权威解析返回新值，再按客户端流程完成签发、安装完整链/私钥并重载 Caddy。旧 TXT 不代表下一次挑战已完成。若要自动续签，需另行验证 DNS API 集成与受限凭据管理。

现有路径为 `studio/state/tls/fullchain.pem` 与 `privkey.pem`。更新前保留可回退副本，校验域名、证书链、有效期及私钥权限，重载后从公网用正常 CA 验证。不要只检查磁盘文件或加 `-k` 便声称证书可用。到期时间与维护责任应保存在实例交付记录，并提前安排续签。

## Android 构建

需要 JDK 21、Android SDK 36、Gradle 8.14.3；脚本默认使用本机 Android Studio JDK 和 `.runtime/android-sdk`，可设置 `STUDIO_JAVA_HOME`、`STUDIO_ANDROID_SDK`，必要时用 `STUDIO_GRADLE` 指定 Gradle。

```bash
VITE_STUDIO_ORIGIN=https://workspace.example.com:28443 npm run android:build
```

脚本执行构建、Capacitor 同步和 `assembleDebug`，输出 `artifacts/roamdeck-<版本>-debug.apk`，并验证签名和 SHA-256。`VITE_STUDIO_ORIGIN` 仅设置新安装的初始入口，已保存的服务器优先。APK 和生成的 Android assets 不提交 Git。

0.4.5 使用 versionCode 12，包名继续为 `xyz.leechyi.compileverse`。升级需同包名同签名以保留 Keystore、服务器列表和提醒状态；备份签名材料并验证覆盖安装。当前交付是 debug APK，正式签名与商店发布另行配置。通知采用用户主动开启的 `specialUse` 前台服务，商店分发仍需按相应审核要求申报。

## 升级后的重点复核

- 前后端和 Android 版本匹配；0.4.5 新增按会话统计与配置字段引导，旧 UI 不会因服务端升级自动替换。
- 保留账号、模块、会话、Token 快照、通知游标和停用 MCP 暂存；旧会话没有用量快照时显示未知，不需要重建会话或重新授权全部账号。
- 0.4.2 的终端协商主要在网关修复，旧 0.4.1 客户端也受益，升级后重连；0.4.4 的原生频道诊断和通知恢复需要安装新版 APK。
- 新版配置保存栏随页面滚动；个人手机上复核输入法。布局验收使用临时 fixture，不向正式 AI 配置写测试密钥。
- 检查通知权限、独立任务提醒频道和最近同步状态；常驻通知不能代替完成提醒验证。

可重复运行的验收脚本及其操作边界见 [验证记录](validation.md)。
