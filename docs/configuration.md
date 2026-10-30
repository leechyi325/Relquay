# 代理配置与扩展

适用版本：**0.4.7**。[返回首页](../README.md) · [使用指南](user-guide.md) · [部署维护](deployment.md)

从 Claude Code / Codex 卡片旁的小设置按钮进入「配置 / Skills / MCP / 插件」。这些操作作用于当前服务器运行用户，对同一用户下的项目通用；当前没有项目级覆盖关系管理。

## 引导式配置

默认使用引导表单，需要高级字段或保留原有注释时切换源码编辑。先读取现有配置，按用途选择连接方式：

| 选择 | 作用 |
| --- | --- |
| 保留当前连接 | 仅修改需要的模型/思考字段，保持现有高级认证或连接方式 |
| 官方连接 | 切回对应官方连接配置；不执行账号登录，也不编辑认证文件 |
| 自定义连接 | 填写供应商给出的接口地址、认证方式与模型等字段 |

| 字段 | Codex | Claude Code |
| --- | --- | --- |
| 默认模型 | 原生 `model` | 原生 `model`，同步现有模型环境覆盖项 |
| 思考程度 | `model_reasoning_effort` | `effortLevel`，同步现有相关环境覆盖项 |
| 自定义地址 | Responses 服务基础地址，通常以 `/v1` 结尾，不填具体 `/responses` 请求路径 | Messages 服务基础地址，通常填服务根地址，不填 `/v1/messages` 请求路径 |
| 提供商 ID | 写入 `model_provider` 和 `model_providers.<ID>`；使用自己的名称，避开保留 ID `openai` / `ollama` / `lmstudio` | 无需提供商 ID |
| 认证 | 直接 Bearer 密钥，或引用既有服务器环境变量名称 | Bearer Token 或 API Key，按供应商要求选择 |

Codex 自定义配置使用 `wire_api = "responses"` 与 `requires_openai_auth = false`，密钥映射到 `experimental_bearer_token`，环境变量名映射到 `env_key`。填写环境变量**名称**不会在服务器创建该变量或写入变量值；需由管理员在代理运行环境提供。

Claude 地址写入 `env.ANTHROPIC_BASE_URL`；Bearer 使用 `env.ANTHROPIC_AUTH_TOKEN`，API Key 使用 `env.ANTHROPIC_API_KEY`。Bearer 字段填原始令牌，不自行加 `Bearer ` 前缀。地址允许 HTTP(S)，不包含内嵌账号密码、查询参数或片段；实际值与模型 ID 应以供应商给出的接口为准。

密钥默认遮蔽，变更地址或提供商 ID 会清空表单密钥，避免误发到新地址。命令认证、云认证或自定义请求头等高级形式使用源码模式。保存只确认 JSON/TOML 语法与写入成功，不保证供应商兼容、账号有权限或连接可用。保存不会终止运行中的代理，必要时由用户在空闲后重启或创建新会话。聊天中的显式模型/思考选择优先于服务器默认值。

## 源码、保存与冲突

| 代理 | 可编辑文件 |
| --- | --- |
| Codex | `CODEX_HOME/config.toml`；未设置时为运行用户 `~/.codex/config.toml` |
| Claude | `CLAUDE_CONFIG_DIR/settings.json`；未设置时为运行用户 `~/.claude/settings.json` |

编辑器不接受任意文件路径，不编辑 `auth.json` 等账号认证文件。需要登录时，由账号本人在服务器终端完成对应 CLI 的授权；工作台密码与 AI 账号授权分开。

引导字段未变化时保留原文；实际修改引导字段会重新序列化配置，可能移除 TOML 注释并调整排版。其他 MCP、插件、hooks、权限与提供商配置保留其值。切到源码会将有效的引导修改应用到本地草稿，只有点击保存才写入服务器。

文件上限 512KB；保存使用读取时的 revision 检查冲突、拒绝符号链接，原子写入权限 600。冲突时先保留草稿，再重新读取合并。草稿不写入浏览器持久存储；离开前先保存所需修改。保存/重新读取按钮随文档滚动，避免手机输入法打开时覆盖编辑框。

## Skills

可查看、导入、编辑和移除独立用户 Skill。手机导入 `SKILL.md`；需要附带脚本、参考资料等支持文件时，从允许的服务器目录导入整个 Skill 文件夹。

| 代理 | 管理范围 |
| --- | --- |
| Codex | `~/.agents/skills` 与旧 `CODEX_HOME/skills` |
| Claude | `CLAUDE_CONFIG_DIR/skills`，默认 `~/.claude/skills` |

`SKILL.md` 最多 256KB，要求 YAML 中有合法的名称和描述。服务器目录导入最多 20MB、2000 项，拒绝符号链接和特殊文件。同名内容不能静默覆盖。隐藏、系统和插件包内置 Skills 不在此处作为独立目录管理。

**移除会删除被选中的独立 Skill 目录**，不只是从界面隐藏；原始导入来源不随之删除。修改前按需要备份，已有运行代理可能需要重新加载。

## MCP

支持用户级连接增删改、启用与停用。编辑的是代理原生配置：Codex 的 `mcp_servers`；Claude 用户配置文件中的 `mcpServers`，默认 `~/.claude.json`，自定义配置目录时为 `CLAUDE_CONFIG_DIR/.claude.json`。

Claude 用户级停用通过工作台私有 `state/claude-mcp-disabled.json` 暂存条目，重新启用时恢复。备份时保留原生配置和此暂存文件；其中可能有密钥。项目和账号元数据保留，不返回给 MCP 列表。

列表隐藏地址中的凭据和查询参数；有权限的详情编辑仍可能含密钥。保存 JSON/TOML 可能规范排版，但保留无关配置值。保存不会主动连接 MCP，也不代办 OAuth；需要额外授权时在对应 CLI/终端处理。

## 插件

使用服务器 PATH 中已安装的原生 CLI，提供安装、启停、卸载；安装标识使用明确的 `name@marketplace`，市场须先在 CLI 中配置并具备所需权限。

工作台固定使用用户级命令，在运行用户 home 执行，超时 120 秒。需要交互确认、OAuth 或市场管理时会提示转到终端；不会自动批准。内置、目录来源或其他非独立安装的插件按其来源管理，不保证可由此页卸载。

## 设计参考

引导字段组织参考 [CC-Switch 配置编辑说明](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/2-providers/2.3-edit.md)，实际键名按当前锁定的 [Codex 0.164.0 schema](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/config.schema.json) 与 [Claude 环境变量说明](https://code.claude.com/docs/en/env-vars) 适配。Relquay 自行实现表单与保存逻辑；上游字段变化需重新验证。
