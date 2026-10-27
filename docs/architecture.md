# 架构与合同

适用版本：**0.4.5**。[返回首页](../README.md) · [部署维护](deployment.md) · [验证记录](validation.md)

## 范围与数据流

RoamDeck 是单一所有者的远程工作台。登录者有权操作服务器文件、执行命令、授权代理；服务不是多租户隔离边界。客户端是独立 React 界面，通过 Capacitor 打包 Android，不是 CloudCLI 网页的 iframe。

```text
Android 内置 React UI / 浏览器
  → HTTPS 反向代理
    → Express 网关（回环 3080）
      → CloudCLI（回环 3001）：Claude 会话与标准化协议、项目目录、shell 附着
      → Codex App Server（本机 stdio）：自有 Codex 执行、批准、历史和用量
      → 可选 FileBrowser Quantum（回环 3081）
      → 文件根 / 持久任务队列 / tmux
```

CloudCLI 固定版本且未修改上游代码。自有 Codex 会话使用 `initialize`、`initialized`、`thread/start` 或 `thread/resume`，再 `turn/start`；请求 sandbox 为 `workspace-write`，响应对应 `workspaceWrite`，批准策略 `on-request`。未支持的交互明确报错并提示终端处理。

## 源码与状态归属

| 位置 | 职责 |
| --- | --- |
| [shared/protocol.ts](../shared/protocol.ts) | 位置、会话、事件解码和重放 reducer |
| [shared/chat-presentation.ts](../shared/chat-presentation.ts) | 按 item/channel 合并增量、完成文本和思考 |
| [shared/config-fields.ts](../shared/config-fields.ts) | 引导配置投影与草稿合并 |
| [server/app.ts](../server/app.ts) | 鉴权、路由、网关和 Socket 生命周期 |
| [server/codex.ts](../server/codex.ts) | 自有 Codex ID、stdio、历史、批准和事件 |
| [server/modules.ts](../server/modules.ts) / [files.ts](../server/files.ts) | 模块绑定、实际路径边界和文件操作 |
| [server/jobs.ts](../server/jobs.ts) | 单 worker 队列、持久日志和取消 |
| [server/usage.ts](../server/usage.ts) / [notifications.ts](../server/notifications.ts) | 用量快照、额度与通用通知元数据 |
| [server/agent-config.ts](../server/agent-config.ts) / [extensions.ts](../server/extensions.ts) | 固定原生配置文件、用户级扩展与串行写入 |
| [server/terminal.ts](../server/terminal.ts) | 流式终端设备协商过滤 |

`STUDIO_BASE` 供应初始 project/inputs/outputs/logs；私有状态位置由 `STUDIO_STATE` 决定，未设置时为应用 `.state`。生产实例状态、账号、AI 配置和密钥不属于源码交付。运行环境和历史路径兼容见部署文档。

## 鉴权与能力链接

- CloudCLI 验证所有者登录；网关签发独立七天 token / secure cookie，上游 token 留在服务器。退出关闭所属 Socket。网页使用按 origin 分项的 sessionStorage；Android 使用 AES-GCM + Keystore。
- 服务器 profile 使用规范化 HTTPS origin，登录完成写回其捕获的 origin，避免切换期间串号。切换会重建服务器相关 UI/连接，远端作业不随之停止。浏览器跨服务器来源必须精确允许。
- Socket 使用一次性、30 秒、绑定频道的 ticket；不将长期 bearer 放入 URL。过期、复用或频道错误的 ticket 拒绝握手。
- 预览使用 15 分钟签名能力链接，绑定模块实际目录及作用范围。绑定变化使旧链接失效；改显示名不失效。HTML 无 same-origin 权限，资源链接仍受范围约束。
- FileBrowser 高级入口使用 30 秒一次配对和回环可信代理，不公开上游管理权限。

## 会话身份、消息和交互

CloudCLI 保持稳定应用会话 ID。自有 Codex 原生 thread ID 作为别名解析到应用 ID；最近会话按代理和身份去重，不能按标题合并。同名独立会话保留；原目录条目缺失但网关仍拥有元数据时可以恢复。新建提交使用同步防重保护。

查询/重命名先解析真实身份；名称 trim 后 1–200 字符，允许运行时重命名，不修改工作目录。自有 Codex 保存可选名称元数据，原生重命名尽力同步。删除检查双 ID 的运行状态，先 archive 原生线程再删除网关记录与对应目录条目，项目文件保留。

消息按事件游标重放，断线保留待处理批准。Codex 事件游标跨轮次持久；Claude 使用上游重放语义。思考摘要和代理返回的可读思考分组折叠，不索取或伪造隐藏思考。历史分页向用户/轮次边界扩展，防止切断长思考；更早消息 prepend 不重置实时游标。自有历史 limit 1–500、offset 0–1000000，Claude 使用上游尾部 offset。

Markdown 使用应用自己的 React 组件和 GFM，支持表格、任务列表、删除线、语义标题/列表/引用、代码语言与复制。跳过原始 HTML，外链只允许 HTTP(S)。交互参考 [HAPI](https://github.com/tiann/hapi/tree/65c8dc727a55b8bc14b8a17fc6ded6ca5846dd9d/web/src/components/assistant-ui) 与 [Paseo](https://github.com/getpaseo/paseo/blob/902b0c7a1637cc7a6c2ee268dca8161965a35def/docs/markdown-renderer.md)，没有直接复制其产品源码。

批准只有显式单次允许/拒绝；问题使用协议可用的选择或输入，提交后等服务端确认。通知跳转先解析目标再标读/导航，已删除目标不创建空白会话；错误保留收件箱并显示可处理提示。

## 文件与附件

模块一个或多个绑定，默认边界为 home 和 STUDIO_BASE，可配置其他允许根。输入先检查词法路径，再检查真实路径；读写、移动和目录创建都不能通过符号链接越界。有排队/运行任务的绑定不能重映射。移除模块不删除物理文件。

上传不覆盖已存在文件，单文件上限 512MB；文本上限 2MB，比较 mtime 后原子替换。二进制文本编辑拒绝。Range 返回正确的分段/416，预览链接失效需重新签发。

附件每条消息最多 10 个；手机附件进入服务器独立库，同名不覆盖。PNG/JPEG/WebP/GIF 最多 20MB，传给支持图片的代理；其他附件转换为已核验的路径引用。移除待发引用不删除原文件。

## 终端生命周期与设备协商

终端首次访问才挂载，底部菜单切换使用隐藏而非卸载；保留连接、缓冲区和草稿，隐藏时关闭覆盖面板、全屏和 armed Ctrl。切换服务器、退出或改变目录仍清理对应客户端。

FitAddon 的直接测量面保持零 padding，14px 留白置于外层。固定列宽和横向查看也使用同一 PTY；字号/旋转/全屏只 resize。实际重连强制更换 CloudCLI 附着 PTY，重新附着既有 tmux，不能杀死原 shell。不能将断线续接解释为主机重启续跑。

旧故障来自上游重播 secondary DA 查询，以及慢网迟到响应进入 readline。网关本机消费顶层 `CSI > [0] c`，立即返回固定 xterm6 响应 `ESC[>0;276;0c`；扫描支持跨帧 CSI，保留 OSC/DCS、主 DA、光标报告和其他控制序列。输入端移除完整的重复 secondary DA 响应，不等待后续键，也不删除用户输入/输出中的可见字面量 `0;276;0c`。旧客户端 plain-shell init 同样被强制新附着。

复制优先选区，否则导出 active buffer；使用 `isWrapped` 合并软折行，保留硬换行和边界真实空格，跳过宽字符空填充及末尾空行。复制不执行 shell 命令。快捷命令按 origin 保存在本机，上限 50 条、名称 60 字、命令 16000 字；空数组保持空，损坏/缺失时恢复默认，点击仅填草稿。命令历史单独保留。

## 任务队列

异步路径检查前先占用单 worker，避免并发越过限制。记录和日志持久化；取消发给进程组并按需升级信号，退出前不能声称已取消。启动时原运行项标记中断，排队项继续。

名称可编辑，变更命令要求 queued；删除 running/cancelling 返回 409，其余删除记录与日志，输出文件保留。完成/运行任务的原命令不可直接改，复制创建新任务。

## 额度、Token 与提醒

账号额度由供应商数据归一化，缓存 60 秒。Codex 重置 Unix 秒转 ISO 时刻，由客户端 Intl 显示设备 IANA 时区、GMT 偏移和倒计时；服务器时区不改变时刻。

用量最多留存 1000 个快照。Codex 是线程累计，缓存/思考为子项；Claude 是上下文快照。按会话列表结合最近最多 100 个目录名称及自有 Codex 元数据，别名取最新快照而非相加；上游目录不可用仍保留已有用量。缺失和真实 0 区分。Token 总计/日行和会话统计默认折叠，展开会话统计才加载，支持代理/名称搜索。

通知保存最多 500 条通用元数据，最新列表 100 条；增量 `{items,cursor,unread,hasMore,gap}` 每页最多 100 条。读标记不解决批准。任务与 AI 回调产生终态/待处理事件，网关生成运行键去重；CloudObserver 独立于页面观察 Claude，不执行模型请求。短暂掉线不能直接当完成；只确认已结束时使用诚实的 ended 提醒。

Android 使用用户开启的 specialUse 前台服务，每 15 秒顺序轮询选择的服务器，凭据来自 Keystore、正常 TLS、拒绝重定向；配置/游标不含密钥。常驻监听和任务提醒频道分离，状态分别报告权限、频道重要性、运行、同步、错误和最近通知。同频道测试不创建服务端事件。首次同步抑制启用前完成事件，保留启用至首次同步的新完成及待处理请求；频道关闭时保留游标以待恢复。显式重开仅恢复此前开启的监听。

通知 Intent 仅含 origin 和不透明事件 ID，匹配已知服务器、恢复登录、认证查询目标后导航；冷启动消费要等活动 React effect 接受，兼容 StrictMode。系统强停和省电限制不绕过。

## 原生配置与扩展

配置和扩展按 provider 串行写入。固定用户配置文件、revision hash、no-store、512KB 上限、常规文件和最终符号链接检查、原子 mode600 替换；冲突返回 409。源码草稿不持久存储，保存不自动重启代理。

引导表单仅修改明确字段，未修改保留原文；修改会规范 JSON/TOML，保留其他配置值但可能去掉 TOML 注释。高级认证留给源码。地址/提供商 ID 改变清空密钥，官方模式不触碰账号授权；切源码只更新草稿。Codex 服务器默认模型/effort 传 null，显式选择才覆盖。

Skills 仅管理独立用户目录，限制名称/描述、256KB 文稿、20MB/2000 项目录导入，不接受链接/特殊文件。MCP 使用原生用户配置；Claude 全局停用归档到私有状态，活跃配置与归档的 revision 一起检查，崩溃遗留双份时活跃优先。插件使用固定 execFile 参数、用户 home、120 秒超时和有界输出，无 shell 插值、自动确认或项目级覆盖；不依赖未成熟的 Codex 插件 RPC。字段与操作细节见 [配置指南](configuration.md)。

配置编辑操作栏为普通文档流，不复用批准面板 sticky footer；文本框有输入法友好的最小高度和内部滚动。

## 接口索引

以下除登录/健康外均要求授权，具体 payload 以共享 schema 和路由为准。

| 接口 | 用途 |
| --- | --- |
| `/api/login`、`/api/logout`、`/api/me`、`/api/status`、`/api/health` | 登录与状态 |
| `/api/conversations`、`/:id` | POST 新建，GET 查询，PUT 重命名，DELETE 删除 |
| `/api/cloud/*` | 允许列表中的上游项目/代理/Git/命令接口，非任意管理代理 |
| `/api/file-modules`、`/api/roots`、`/api/directories` | 模块与目录 |
| `/api/files*`、`/api/chat/attachments` | 文件操作与附件 |
| `/api/agents/:provider/models`、`/config` | 模型目录与配置 |
| `/api/agents/:provider/skills`、`/mcp`、`/plugins` | 用户级扩展 |
| `/api/jobs`、`/:id`、`/:id/cancel`、`/:id/log` | 任务增查改删、取消、日志 |
| `/api/usage/accounts`、`/api/usage/sessions`、`/api/usage/sessions/:id` | 账号和会话用量；列表 provider/search/offset/limit，limit 1–100、offset 0–10000、search ≤200 字 |
| `/api/notifications`、`/:id`、`/:id/read`、`/read-all` | 提醒与读取状态 |
| `/api/socket-ticket`、`/ws/chat`、`/ws/terminal` | 短票据及实时连接 |
| `/api/filebrowser-link`、`/preview/:capability/*` | 高级文件配对与受限预览 |

## 错误与验证要求

| 条件 | 结果 |
| --- | --- |
| 缺失/过期/撤销登录 | 401 |
| 非法来源 / 非允许上游管理接口 | 403 / 404 |
| 重用或错频道 ticket | 握手 401 |
| 路径/符号链接越界 | 400 / 403 |
| 同名上传、保存冲突、运行中删除 | 409，保留原对象 |
| 超出文件/编辑限制、二进制编辑 | 413 / 415 |
| 无效/过期预览能力 | 403 / 410 |
| 不可满足 Range | 416 与 Content-Range |
| 提醒目标不存在 / 上游暂时无法查询 | 410 / 502，保留收件箱提示 |

不在响应/日志泄露原始密钥。不得通过关闭 TLS、自动批准、重建 PTY 或按可见字符串过滤输出来掩盖问题。基础质量门、慢网协商回归、Android 实际 IME 与真实模型验收的区别见 [验证记录](validation.md)。
