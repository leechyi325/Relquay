# RoamDeck · 随行台

这是通用手机远程 AI 工作台的独立仓库。产品覆盖代理会话、项目、终端、文件和后台任务。

- 先读 `README.md` 和 `docs/architecture.md`。产品文案使用 RoamDeck / 随行台，保持通用用途。
- 产品源码在 `src/`、`server/`、`shared/`、`android/`；上游依赖由两个 package-lock 锁定，不直接修改 node_modules。
- 运行 `npm run typecheck`、`npm test`、`npm run build`。界面改动加 `npm run test:ui`；Android 改动需要构建，真机和模拟器结果分别说明。
- 凭据、运行状态、依赖、SDK、构建输出和 APK 不入库。不要添加内容制作项目、原始音视频或实例专用的验收素材。
- 文件路径保持 realpath 约束；权限审批需明确操作，不能自动批准；终端显示变化不重建 PTY。
- 保留已有 Android 包标识、Keystore 和服务器状态目录的升级兼容性，迁移前先检查当前部署。
