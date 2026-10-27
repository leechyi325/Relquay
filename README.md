# RoamDeck · 随行台

[![CI](https://github.com/leechyi325/RoamDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/leechyi325/RoamDeck/actions/workflows/ci.yml)

**手机上的远程 AI 工作台。** Claude Code / Codex 在自己的服务器上运行，Android 手机、平板或浏览器集中操作对话、项目、文件、终端和后台任务。适用于开发、运维、文档处理与其他远程工作。

当前版本 **0.4.5**，Android versionCode **12**。界面资源随 APK 打包；仅更新服务器网页不会更新已安装 App。

## 文档入口

| 需要做什么 | 文档 |
| --- | --- |
| 添加服务器、对话、文件、终端、任务、通知和用量 | [使用指南与故障排查](docs/user-guide.md) |
| 填写代理连接、模型、密钥；管理 Skills / MCP / 插件 | [代理配置与扩展](docs/configuration.md) |
| 部署、升级、备份、TLS 和 Android 打包 | [部署与维护](docs/deployment.md) |
| 理解数据流、鉴权、接口和实现约束 | [架构与合同](docs/architecture.md) |
| 查看测试入口、0.4.5 验证结果和未验证范围 | [验证记录](docs/validation.md) |
| 查询各版变更 | [更新记录](CHANGELOG.md) |

## 当前功能

| 模块 | 能力 |
| --- | --- |
| 服务器 | 多服务器添加、命名、编辑、移除、切换，分别登录 |
| 对话 | Claude / Codex 会话；选择目录和项目名、重命名/删除、附件、模型与思考程度、Markdown、可折叠思考、审批和问答 |
| 文件 | 自定义模块及多个文件夹；上传下载、目录创建、文本编辑、移动/重命名、引用附件、打开终端 |
| 预览 | 图片、音视频、Markdown/文本和隔离 HTML；PDF 取决于 WebView，也可下载 |
| 终端 | PTY + tmux、适应屏宽/固定列宽、横向查看、中文命令编辑、复制与自定义快捷命令 |
| 任务 | 单 worker 持久队列、日志、取消、编辑与删除记录、复制重跑 |
| 用量与提醒 | 额度窗口和设备时区、默认折叠 Token 与按会话统计、提醒收件箱、可主动开启的 Android 后台通知 |
| 代理设置 | 用户级配置引导/源码编辑、Skills、MCP、插件管理 |

这是单一所有者的服务器工作台；登录者可以执行服务器命令。每台服务器需要独立部署、HTTPS 和账号。仓库没有公共演示账号或预置可用服务器。

## 本地开发

需要 Node.js ≥24。先安装依赖，再运行检查：

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:ui
```

连接实际代理时，另行按 [部署文档](docs/deployment.md) 准备 CloudCLI、CLI 和账号。网关读取调用环境中的变量，不会自动加载 `.env`：

```bash
export STUDIO_BASE="$PWD/.runtime/workspace"
export STUDIO_STATE="$PWD/.state"
export STUDIO_ORIGIN=http://127.0.0.1:5173
export CLOUDCLI_URL=http://127.0.0.1:3001
mkdir -p "$STUDIO_BASE"/{project,inputs,outputs,logs}
npm run server
```

另开终端运行 `npm run dev`，访问 `http://127.0.0.1:5173`。Vite 将 API、预览和 WebSocket 转发给本机 3080 网关。没有 CloudCLI/账号时不能完成实际代理对话；UI 验证脚本使用独立 fixture。

Android 打包见 [Android 构建](docs/deployment.md#android-构建)。保持既有包名和签名才能保留安装兼容性。部署脚本目前包含 Ubuntu 用户及实例路径假设，使用前必须阅读其 [适用范围](docs/deployment.md#安装脚本的适用范围)。

## 仓库结构

```text
src/       React 手机/平板界面
server/    Express 网关、代理桥、文件和任务
shared/    协议、配置、版本和显示逻辑
android/   Capacitor Android 工程及原生桥
public/    RoamDeck 图标
tests/     行为和协议测试
scripts/   构建、部署及验收脚本
upstream/  服务端客户端依赖锁文件
docs/      使用、配置、部署、架构和验证说明
```

凭据、运行状态、依赖、SDK、构建产物、APK、实例验收素材和内容制作工程不入库。实际手机兼容性与完整模型工作流仍需用户验收；测试和模拟器结果的范围见 [验证记录](docs/validation.md)。

本仓库当前未附带开源许可证。公开可见不等于授予复制、修改或再分发许可；分发前需另行确定许可证。
