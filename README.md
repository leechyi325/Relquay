# RoamDeck · 随行台

**手机上的远程 AI 工作台。** 把 Claude Code / Codex、项目、终端、文件和后台任务放在同一个入口；客户端支持 Android 手机、平板和浏览器，代理与任务在自己的服务器上运行。

Roam 表示随处使用，Deck 表示集中操作的工作台。适用于软件开发、脚本自动化、服务器运维、文档处理和其他需要远程执行的工作。

## 功能

| 入口 | 功能 |
| --- | --- |
| 服务器 | 添加、命名、编辑、移除与切换多台 RoamDeck 服务器，各自保存登录状态 |
| 工作台 | 选择 Claude Code / Codex，项目目录和名称，新建/恢复/删除会话，实时输出、工具状态、审批、停止和重连 |
| 终端 | 实际 PTY + tmux，适应屏宽或 80/120 列，横向触摸/滑块、字号、全屏、控制键、中文命令编辑和历史 |
| 文件 | 浏览、上传下载、新建目录、编辑文本、移动/重命名、引用到会话、目录打开终端 |
| 预览 | 图片、音视频、Markdown/文本、隔离 HTML；PDF 显示取决于 WebView，也可下载原件 |
| 用量 | 账号额度窗口、重置时间、服务器账号 Token 活动和本会话用量；缺失数据明确标注 |
| 提醒 | 任务/AI 轮次完成、失败、待批准和待回答；持久收件箱及 Android 后台系统通知 |
| 任务 | 持久化单 worker 队列、日志、取消、输出入口；关闭客户端后继续执行 |

初始模块为项目、输入文件、输出文件和运行日志，可在「文件 → 管理模块」重命名、重新绑定、添加或移除；移除模块保留实际文件。一个模块只有一个绑定时直接进入，多绑定时先选文件夹。目录在进入页面、手动刷新及前台每 10 秒刷新。上传单文件最多 512MB，文本编辑最多 2MB，预览链接有效期 15 分钟。会话删除保留项目文件，运行中会话需要先停止。

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
- Android：<https://safe.leechyi.xyz:28443/downloads/roamdeck-0.3.0.apk>
- 工作台账号：`ubuntu`；密码在本机受保护的 `private/access.json`，不在仓库中。
- 可覆盖升级此前版本，保留登录信息。进入「终端」完成 Codex / Claude 的本人账号授权，再创建会话。

当前部署沿用原服务目录和 systemd 名称，迁移与证书说明见 [deployment.md](docs/deployment.md)。

手机顶部服务器名称和登录页服务器按钮可打开服务器列表。每台服务器需要独立部署 RoamDeck、单独登录；配置仅保存在本机，切换保留服务器上的任务。

## 文件模块、附件与模型

- 默认可绑定当前服务用户 home 和 STUDIO_BASE 下的既有目录；`STUDIO_BROWSE_ROOTS` 可显式指定允许的绝对目录，Linux 以冒号分隔。绑定先解析真实路径，模块内路径保持越界和符号链接检查。有排队或运行任务的绑定不能重映射。
- 对话回形针入口可从手机上传或从服务器模块多选，每条消息最多 10 个附件。手机上传复制到当前服务器独立附件库；同名文件互不覆盖。移除附件只移除待发引用，不删除服务器原文件。PNG/JPEG/WebP/GIF 通过图片输入传给支持的代理，最多 20MB；其他文件提供经核验的服务器路径，由代理按任务读取。
- 模型目录来自服务器；Codex 用 App Server `model/list`，Claude 用 CloudCLI 的 `models.OPTIONS`。思考选项随模型变化，运行中锁定，从下一轮生效；目录不等于账号权限。
- 批准面板展示命令、目录、原因、可用变更和完整请求；只提供单次允许或拒绝。问答支持协议中的单选、多选、自定义和密码输入，提交后等确认，断线重放。无法识别的问题会明确要求终端处理。
- 浏览器从一台工作台切换其他服务器时，目标服务器需将网页来源加入 `STUDIO_CLIENT_ORIGINS`；Android 的固定应用来源已内置，不需要此设置。

## 验证与边界

行为测试覆盖鉴权、路径和符号链接越界、保存冲突、中文上传、Range、队列、会话命名/删除和 Codex RPC。浏览器检查使用临时文件与协议 fixture；实际 ARM 与 Android 模拟器检查单独记录，不把模拟器或协议测试当成真实手机/模型验收。

已有真实服务器和 Android 16 ARM64 模拟器验证。当前尚未提供独立 Git 图形界面，Git 可通过终端使用；部分高级交互表单需要终端处理。网页提供提醒收件箱；Android App 可主动开启后台系统提醒。个人手机的兼容性和真实模型工作流仍需要使用者复核。

本仓库尚未选择开源许可证，也未配置远程仓库；当前为独立本地 Git 仓库。


## 额度、Token 与 Android 提醒（0.3）

在「工作台设置 → 额度与 Token」查看所选服务器的账号数据，会话输入框下方也有用量入口。Codex 使用 App Server 的账号额度、账号活动及线程 Token 事件；展示输入、输出、缓存命中与已报告的思考 Token。Claude 通过 CloudCLI 报告当前上下文快照，与累计账单不同；OAuth 登录时尝试读取账号额度，私有接口变化、未授权或 API Key 模式时明确显示不可用。缓存和思考是输入/输出的子项，不重复相加，不估算费用。账号接口缓存 60 秒，手动刷新不会强制请求供应商。

手机顶部铃铛打开「提醒中心」，提醒点开进入实际会话或任务日志；支持未读和全部已读。服务器保存最近 500 条通用状态，界面展示最近 100 条；不保存命令、消息正文或问答内容。通知只导航，批准/拒绝仍在对话中明确操作。

Android 使用「提醒中心 → 后台提醒设置」：选择服务器和提醒类型，点「开启后台提醒」并允许通知。应用保留可暂停的常驻通知，约每 15 秒依次检查各台已登录服务器；独立 cursor 保存在本机，切换工作台不停止监听。首次开启仅提醒最近收件箱中尚未处理的批准/问答，历史完成记录不推送。每台服务器需升级到 0.3；登录过期时设置页显示重新登录提示。暂停后再次开启不会重播旧完成记录。

该版本采用用户主动开启的 Android 前台服务，不依赖 Telegram、FCM 或额外账号。系统强停、重启、断网及厂商省电可能暂停或延迟监听；重新打开 App 后可检查状态并开启。网页仅有前台收件箱，不提供浏览器后台推送。服务端的 CloudCLI 观察连接独立于聊天页面；短暂掉线后若只确认运行已结束，会显示「会话已结束，请查看结果」，不冒充成功。后台提醒覆盖 RoamDeck 发起的 AI 轮次与队列任务，不承诺其他终端客户端的全部生命周期。
