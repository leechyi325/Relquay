# RoamDeck · 随行台

这是通用手机远程 AI 工作台的独立仓库。产品覆盖代理会话、项目、终端、文件和后台任务。

- 先读 `README.md` 的文档导航和 `docs/architecture.md`；操作入口见 `docs/user-guide.md`，配置见 `docs/configuration.md`，部署见 `docs/deployment.md`，验证边界见 `docs/validation.md`。产品文案使用 RoamDeck / 随行台，保持通用用途。
- 产品源码在 `src/`、`server/`、`shared/`、`android/`；上游依赖由两个 package-lock 锁定，不直接修改 node_modules。
- 运行 `npm run typecheck`、`npm test`、`npm run build`。界面改动加 `npm run test:ui`；Android 改动需要构建，真机和模拟器结果分别说明。
- 仅文档改动检查相对链接/锚点、版本、命令与源码一致性和 `git diff --check`，无需重跑构建或部署。功能变化同步当前指南与 `CHANGELOG.md`，历史版本说明不混入当前操作步骤。
- 凭据、运行状态、依赖、SDK、构建输出和 APK 不入库。不要添加内容制作项目、原始音视频或实例专用的验收素材。
- 文件路径保持 realpath 约束；权限审批需明确操作，不能自动批准；终端显示变化不重建 PTY。
- 保留已有 Android 包标识、Keystore 和服务器状态目录的升级兼容性，迁移前先检查当前部署。
