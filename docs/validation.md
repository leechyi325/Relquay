# 验证记录与复检入口

[返回首页](../README.md) · [架构合同](architecture.md) · [部署维护](deployment.md)

## 0.4.5 验证基线 · 2026-10-27

对应源码提交 `f544cf8`，Android versionName 0.4.5 / versionCode 12。下表是该版本发布时已完成的验证记录；本轮文档整理没有重新运行产品测试或部署。

| 层次 | 已验证内容 | 范围 |
| --- | --- | --- |
| 本地 Node 26 | 42 项行为测试、TypeScript、Vite 构建通过 | 协议、文件、队列、用量、配置等；不调用模型 |
| Oracle Ubuntu ARM64 / Node 24 | 同样 42 项测试、类型检查与构建通过 | 实际目标架构 |
| 浏览器 | 51 个截图状态，无页面异常/横向溢出；已检查截图 | 临时 fixture；配置引导/遮蔽/源码、折叠与懒加载、会话统计/筛选/搜索、未知/零与不同统计口径 |
| Android 16 ARM64 模拟器 | 同签名升级保留登录；实际输入法下配置编辑、长草稿和明确保存通过；用量默认折叠和会话切换通过 | 该 WebView 的配置与用量接口被拦截为测试数据；未读写生产 AI 配置 |
| 输入法回归 | 0.4.4 光标对齐时未遮挡，向上滚动 100px 后出现 42.54 CSS px 遮挡；0.4.5 引导/源码/滚动后均为 0 | 测量实际软键盘和按钮/编辑区域矩形，最终操作栏为 static |
| 原生 Codex 配置 | 临时配置 home 中生成的自定义 TOML 可由 ARM Codex 0.164.0 `features list` 加载，之后清理 | 证明语法与原生加载兼容，不证明连接和模型权限 |
| 实际服务 | 公开 HTTPS 健康版本 0.4.5，未登录用量接口 401；会话列表与详情的 canonical 快照一致 | 只检查元数据，不输出用户正文 |
| APK | 4,520,767 字节，完整公网下载与本机/服务器摘要一致；签名与 0.4.4 一致 | SHA-256 见下方；debug 构建，不是商店发布 |

```text
3b9917b9d8d9a6fdb17a18096be32edbfff1abb1b0bf7eae9460e838350f6dad
```

验收产物保存在被 Git 忽略的 `artifacts/` / `.runtime/`，不随仓库分发。相关记录名为 `revision12-public-report.json`、`config-usage-native-report.json`、`config-usage-native-baseline-report.json`；报告、APK 和日志由实例维护者保管。模拟器测试恢复原键盘偏好、清理专用测试文件并停止模拟器。

## 基础质量门

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:ui
```

目前无独立 lint 脚本，使用严格 TypeScript 与行为测试。GitHub [CI](../.github/workflows/ci.yml) 在 Node 24 执行依赖安装、类型、测试和构建，**不包括浏览器、Android 或远程部署检查**。

`test:ui` 启动独立 fixture，默认需要本机 Chrome；其他位置用 `STUDIO_CHROME` 指定。UI 改动必须检查截图，不只统计返回码。Android 改动另需 APK 构建、签名检查和原生运行，真实手机与模拟器分别报告。

仅修改文档时检查相对链接/锚点、命令与源码一致性、版本和 `git diff --check`；不为文档改动重新构建或部署产品。

## 专项脚本

这些脚本不是全都由 `npm test` 自动执行。运行前阅读脚本、准备独立测试目录和模拟器，确认目标环境与清理逻辑；远程/原生脚本可能创建测试会话、任务或更改专用模拟器设置，不能盲目对用户现有会话操作。

| 脚本 | 用途与注意事项 |
| --- | --- |
| [check-ui.mjs](../scripts/check-ui.mjs) | 浏览器 fixture、截图和交互断言 |
| [check-extension-cli.mjs](../scripts/check-extension-cli.mjs) | 原生 CLI 扩展兼容性；临时配置 home 与空测试插件，执行方式 `node --import tsx scripts/check-extension-cli.mjs` |
| [check-terminal-negotiation.mjs](../scripts/check-terminal-negotiation.mjs) | 真实 ARM 延迟设备响应、旧客户端 init、shell PID/变量保留；需要 `STUDIO_SSH_TARGET=USER@HOST` |
| [check-terminal-replay.mjs](../scripts/check-terminal-replay.mjs) | 终端协商回归兼容入口，转到上项 |
| [check-terminal-native.mjs](../scripts/check-terminal-native.mjs) | 专用 Android 模拟器的终端复制、留白、触屏横移、列宽/旋转/全屏、菜单和重连；需远程目标 |
| [check-chat-native.mjs](../scripts/check-chat-native.mjs) | 两代理临时会话、重命名、键盘、返回和缺失目录恢复；不执行推理 |
| [check-chat-render-native.mjs](../scripts/check-chat-render-native.mjs) | 临时会话与拦截消息的 Markdown、思考折叠、历史；不当作模型输出验收 |
| [check-notifications-native.mjs](../scripts/check-notifications-native.mjs) | 实际后台测试任务、系统通知和点击导航、暂停与去重 |
| [check-notification-health-native.mjs](../scripts/check-notification-health-native.mjs) | 独立频道诊断/测试、重开恢复和首次同步窗口；仅专用模拟器 |
| [check-config-usage-native.mjs](../scripts/check-config-usage-native.mjs) | Android 实际 IME、配置 fixture 保存与用量选择；固定专用 `emulator-5554`，无生产配置写入 |
| [check-usage-remote.mjs](../scripts/check-usage-remote.mjs) | 实际 ARM 用量与失败提醒检查 |

例如，终端协商必须覆盖迟到 0 / 1800 / 5000ms 的响应，并验证手机不再收到该查询、没有可见污染、原 shell PID/变量保留。只测立即响应或重复连接不足以覆盖慢网问题。不要捕获用户已有窗格、清空历史或删除看起来相同的字面量。

## 历史验证与本次未覆盖

0.4.4 已在专用 Android 模拟器验证真实后台任务完成、冷启动通知跳转、频道关闭诊断及重开恢复；这不是 0.4.5 新做的完整通知验收。旧版测试数量/截图数量不能替代当前版本基线。

当前仍需用户在个人 Android 手机/平板复核输入法、显示、后台省电限制和真实工作流。没有把 fixture、模拟器、App Server 握手或原生配置加载当成完整模型推理；实际 Codex / Claude 回复、完整工具操作和真实批准链路须在账号本人授权后完成。显示的思考限于代理返回内容。

尚无独立 Git 图形界面、项目级扩展覆盖管理、FCM/Telegram 或浏览器后台推送。Git 和不支持的高级交互可通过终端完成。手动 DNS-01 证书不自动续签；安装脚本也不是通用安装器，详见部署文档。

## 服务端打包配套验证 · 2026-10-27

服务端轻量包使用 Git 已跟踪文件白名单和新生成的独立 Vite 输出，不复制运行目录、node_modules、AGENTS、用户数据或 dist/downloads。初始化账号 helper 支持新服务器目录和回环地址，保留旧路径兼容；回归覆盖凭据不打印、权限600、重复执行与拒绝覆盖。

该配套不改变0.4.5 Android UI或现有生产部署；新的打包/安装检查与上面的0.4.5发布基线分别记录。

配套检查结果：本地 Node26 类型检查与45项测试通过（原42项 + 3项初始化回归），独立 Vite 构建成功。Oracle ARM64 / Node24.22.1 在一次性HOME和回环13301/13380按README解压、全新安装两组锁定依赖、启动实际CloudCLI、首次/再次初始化账号、网关健康、未授权401、登录/文件与预构建网页检查通过；Codex0.164.0和Claude2.1.310版本/登录帮助可执行。无模型推理、AI账号登录或生产服务更新。测试进程和临时账号数据在验收后清理。

首个macOS包在GNU tar解压时出现扩展属性警告，打包现已关闭xattrs和Apple复制元数据；最终包另行检查GNU tar解压、清单和摘要。新服务的HTTPS/DNS/systemd仍由部署者配置，不将回环启动验收称为全新公网部署。
