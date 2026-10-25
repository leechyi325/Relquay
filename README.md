# RoamDeck · 随行台

**手机上的远程 AI 工作台。** 把 Claude Code / Codex、项目、终端、文件和后台任务放在同一个入口；客户端支持 Android 手机、平板和浏览器，代理与任务在自己的服务器上运行。

Roam 表示随处使用，Deck 表示集中操作的工作台。适用于软件开发、脚本自动化、服务器运维、文档处理和其他需要远程执行的工作。

## 功能

| 入口 | 功能 |
| --- | --- |
| 工作台 | 选择 Claude Code / Codex，项目目录和名称，新建/恢复/删除会话，实时输出、工具状态、审批、停止和重连 |
| 终端 | 实际 PTY + tmux，适应屏宽或 80/120 列，横向触摸/滑块、字号、全屏、控制键、中文命令编辑和历史 |
| 文件 | 浏览、上传下载、新建目录、编辑文本、移动/重命名、引用到会话、目录打开终端 |
| 预览 | 图片、音视频、Markdown/文本、隔离 HTML；PDF 显示取决于 WebView，也可下载原件 |
| 任务 | 持久化单 worker 队列、日志、取消、输出入口；关闭客户端后继续执行 |

目录分为项目、输入文件、输出文件和运行日志。上传单文件最多 512MB，文本编辑最多 2MB，预览链接有效期 15 分钟。会话删除保留项目文件，运行中会话需要先停止。

## 仓库结构

```text
src/                 React 手机/平板界面
server/              Express 网关、文件、会话与任务
shared/              协议、版本和默认连接配置
android/             Capacitor Android 工程与原生桥
public/              RoamDeck 图标
tests/               行为与协议测试
scripts/             构建、部署和验收脚本
upstream/            服务端客户端依赖锁文件
docs/                架构与部署说明
```

仓库只维护工具源码、图标、测试和说明。凭据、运行状态、node_modules、SDK、构建缓存、截图报告、APK 和内容制作工程均排除在版本管理之外。

## 本地开发

需要 Node.js ≥24。Android 构建另需 JDK 21、Android SDK 36 和 Gradle 8.14.3。

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:ui
```

`npm run dev` 启动界面开发服务。`npm run server` 启动网关；环境变量示例在 `.env.example`，需由调用环境导出。基础架构与协议见 [architecture.md](docs/architecture.md)。

```bash
export STUDIO_BASE=/home/ubuntu/workspace
export CLOUDCLI_URL=http://127.0.0.1:3001
export STUDIO_ORIGIN=https://workspace.example.com:28443
npm run server
```

`STUDIO_BASE` 下需存在 `project`、`inputs`、`outputs`、`logs` 四个目录。CloudCLI 独立运行，账号通过受保护的首次设置流程建立，两个 AI 账号由使用者本人授权。

## Android

```bash
npm run android:build
```

构建脚本默认使用本机 Android Studio JDK 和 `.runtime/android-sdk`。其他位置设置 `STUDIO_JAVA_HOME`、`STUDIO_ANDROID_SDK`；可用 `STUDIO_GRADLE` 指定 Gradle。输出为 `artifacts/roamdeck-<版本>-debug.apk`。网页文件由 `npm run android:sync` 打包，不提交生成的 Android assets。

应用标识目前保留 `xyz.leechyi.compileverse`，用于兼容已有安装与 Keystore；显示名称为 RoamDeck。正式分发的签名、标识和商店发布需另行配置。

## 当前实例

- 网页：<https://safe.leechyi.xyz:28443>
- Android：<https://safe.leechyi.xyz:28443/downloads/roamdeck-0.1.2.apk>
- 工作台账号：`ubuntu`；密码在本机受保护的 `private/access.json`，不在仓库中。
- 可覆盖升级此前版本，保留登录信息。进入「终端」完成 Codex / Claude 的本人账号授权，再创建会话。

当前部署沿用原服务目录和 systemd 名称，迁移与证书说明见 [deployment.md](docs/deployment.md)。

## 验证与边界

行为测试覆盖鉴权、路径和符号链接越界、保存冲突、中文上传、Range、队列、会话命名/删除和 Codex RPC。浏览器检查使用临时文件与协议 fixture；实际 ARM 与 Android 模拟器检查单独记录，不把模拟器或协议测试当成真实手机/模型验收。

已有真实服务器和 Android 16 ARM64 模拟器验证。当前尚未提供独立 Git 图形界面，Git 可通过终端使用；部分高级交互表单需要终端处理。Telegram 未配置时不提供通知。个人手机的兼容性和真实模型工作流仍需要使用者复核。

本仓库尚未选择开源许可证，也未配置远程仓库；当前为独立本地 Git 仓库。
