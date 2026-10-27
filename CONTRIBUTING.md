# 参与 RoamDeck

感谢你帮助改进 RoamDeck。可以从文档、可复现的问题、手机交互和环境兼容性开始，不需要先搭建 Android 模拟器。

[返回首页](README.md) · [安装指南](docs/getting-started.md) · [架构](docs/architecture.md) · [安全反馈](SECURITY.md)

## 提问与反馈

- 使用问题先看 [故障排查](docs/user-guide.md#常见问题)，仍有问题可发 Issue，说明卡在哪一步。
- Bug 请写清版本、Android App 或浏览器、复现步骤、实际与预期结果；截图和脱敏日志会帮助定位。
- 功能建议请先描述要完成的工作、当前阻碍及预期交互。较大的改动建议先开 Issue 对齐范围。
- 不要在公开 Issue、PR、截图或附件中包含密码、Token、API Key、私有对话和项目文件。敏感漏洞按安全反馈流程处理。

## 本地开发

需要 Node.js ≥24 和 npm；终端功能还需要 tmux。先 fork 仓库，在自己的分支开发：

```bash
git clone https://github.com/YOUR_USERNAME/RoamDeck.git
cd RoamDeck
git switch -c feat/your-change
npm ci
```

只运行行为测试时不需要 AI 账号，测试使用临时目录、假 CLI 和协议 fixture，不应连接个人账号。验证全部基础检查：

```bash
npm run typecheck
npm test
npm run build
```

开发真实页面需先准备独立的 CloudCLI / AI 客户端和工作台账号，见 [安装指南](docs/getting-started.md)。网关环境由启动环境导出，不自动加载 `.env`：

```bash
export STUDIO_BASE="$PWD/.runtime/workspace"
export STUDIO_STATE="$PWD/.state"
export STUDIO_ORIGIN=http://127.0.0.1:5173
export CLOUDCLI_URL=http://127.0.0.1:3001
mkdir -p "$STUDIO_BASE"/{project,inputs,outputs,logs}
npm run server
```

另开终端运行 `npm run dev`，访问 `http://127.0.0.1:5173`。Vite 代理 API、预览与 WebSocket 到网关3080。请使用独立开发目录与账号配置，不在正在使用的生产工作台上直接开发。

## 按改动范围验证

| 改动 | 建议验证 |
| --- | --- |
| 文档、Issue/PR 模板 | 相对链接和锚点、命令/版本、Markdown/YAML、`git diff --check` |
| TypeScript、协议或网关 | 类型检查、行为测试、构建；补能复现真实问题的回归用例 |
| 页面与交互 | 基础检查 + `npm run test:ui`，检查手机/平板截图、空/错误状态与横向溢出 |
| Android 原生桥、通知或键盘适配 | APK 构建和签名检查，在真机或独立模拟器验收；说明设备与未覆盖范围 |
| 安装与服务端打包 | 独立目录安装、依赖/路径/权限、鉴权与启动检查；不重启他人的工作负载 |

浏览器 UI 验证使用本地 fixture，默认 Chrome 路径针对 macOS，其他环境设置 `STUDIO_CHROME`。原生脚本部分固定使用专用模拟器，运行前阅读脚本并核对目标设备。模拟器、fixture 和 CLI 握手不代表已完成真实模型推理。

`npm run server:package` 从完整 Git checkout 生成服务器包，不复制整个工作目录或运行中的 dist。新增运行所需文件时，检查打包清单并确保在源码交付中包含。正式重复打包应先提交所需新文件；不从个人数据目录补文件进包。

## Pull Request

1. 保持单一主题，说明具体问题、行为变化和验证方式。
2. 界面改动附使用虚构数据的前后截图；原生改动注明实际测试设备。
3. 接口、配置或用户流程变化，同步对应指南和 README 更新记录。
4. 不提交 node_modules、SDK、缓存、APK、凭据、运行状态或个人内容。AGENTS.md 是本地开发辅助文件，不需要提交。
5. 需要调整依赖时说明原因，保持应用与上游的两个锁文件；避免无关升级。

提交格式沿用 `feat:`、`fix:`、`docs:`、`test:`、`chore:`。维护者会检查功能与验证范围；提交 PR 不要求你获得模型账号或公开自己的密钥。

## 实现约定

文件操作保持真实路径边界和保存冲突检测；批准必须由用户明确操作；终端显示变化调整同一 PTY。Android 升级保留包标识、签名与 Keystore 兼容性。详细约束见 [架构文档](docs/architecture.md)。

## 许可证

项目使用 [MIT License](LICENSE)。提交贡献前，请确认你有权以该许可证提供相应内容；不要复制不兼容许可的第三方源码。依赖及上游工具遵循各自条款。
