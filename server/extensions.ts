import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse, stringify, type TomlTable } from 'smol-toml';
import { parse as yaml } from 'yaml';
import { AgentConfigs } from './agent-config.ts';
import { HttpError, assertInside } from './files.ts';
import { readPrivate, writePrivate } from './private-document.ts';
import { extensionName, pluginIdSchema, type AgentProvider, type McpDetail, type McpDocument, type PluginEntry, type SkillEntry } from '../shared/extensions.ts';
const exec = promisify(execFile);
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export type ExtensionOptions = { home?: string; claudeJson?: string; codexSkillRoots?: string[]; run?: (provider: AgentProvider, args: string[]) => Promise<string> };
export class Extensions {
  private locks = new Set<string>();
  private readonly home: string;
  private readonly claudeJson: string;
  constructor(private state: string, private configs: AgentConfigs, private allowedDirectory: (input: string) => Promise<string>, private options: ExtensionOptions = {}) {
    this.home = options.home ?? os.homedir();
    this.claudeJson = options.claudeJson ?? (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(this.home, '.claude.json'));
  }
  async exclusive<T>(provider: AgentProvider, action: () => Promise<T>) {
    if (this.locks.has(provider)) throw new HttpError(409, '该代理正在保存或安装扩展，请稍后重试');
    this.locks.add(provider); try { return await action(); } finally { this.locks.delete(provider); }
  }
  private skillRoots(provider: AgentProvider) {
    return provider === 'claude' ? [path.join(this.configs.home(provider), 'skills')] : this.options.codexSkillRoots ?? [path.join(this.home, '.agents/skills'), path.join(this.configs.home(provider), 'skills')];
  }
  private async skillPath(provider: AgentProvider, id: string) {
    const found = (await this.skills(provider)).find(skill => skill.id === id);
    if (!found || !found.editable) throw new HttpError(404, 'Skill 不存在，或该目录需要在服务器上管理');
    return found;
  }
  private skillMetadata(content: string) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    let value: Record<string, unknown> = {};
    try { if (match) value = record(yaml(match[1])); } catch { throw new HttpError(400, 'SKILL.md 的 YAML 元数据格式有误'); }
    if (typeof value.name !== 'string' || !value.name.trim() || typeof value.description !== 'string' || !value.description.trim()) throw new HttpError(400, 'SKILL.md 需要 name 和 description 元数据');
    return { name: value.name, description: value.description };
  }
  async skills(provider: AgentProvider): Promise<SkillEntry[]> {
    const result: SkillEntry[] = [];
    for (const root of this.skillRoots(provider)) {
      let entries; try { entries = await fs.readdir(root, { withFileTypes: true }); } catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
      for (const entry of entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))) {
        const folder = path.join(root, entry.name), filename = path.join(folder, 'SKILL.md');
        // Plugin folders belong to the provider plugin manager.
        if (await fs.access(path.join(folder, '.claude-plugin/plugin.json')).then(() => true, () => false)) continue;
        try {
          const realRoot = await fs.realpath(root); assertInside(realRoot, await fs.realpath(folder));
          const file = await readPrivate(filename, 256 * 1024); if (!file.exists) continue;
          let metadata; try { metadata = this.skillMetadata(file.content); } catch { metadata = { name: entry.name, description: '元数据有误，打开编辑以修复' }; }
          result.push({ ...metadata, id: createHash('sha256').update(filename).digest('hex').slice(0, 24), path: filename, revision: file.revision, content: file.content, editable: true });
        } catch(e) { if (e instanceof HttpError) result.push({ id: createHash('sha256').update(filename).digest('hex').slice(0, 24), name: entry.name, description: '文件不可编辑或元数据有误，请在服务器检查', path: filename, revision: '', content: '', editable: false }); else if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      }
    }
    return result;
  }
  async saveSkill(provider: AgentProvider, name: string, content: string, id?: string, revision?: string) {
    extensionName.parse(name); this.skillMetadata(content);
    if (Buffer.byteLength(content) > 256 * 1024) throw new HttpError(413, 'Skill 文本超过 256KB');
    const found = id ? await this.skillPath(provider, id) : undefined;
    const root = this.skillRoots(provider)[0], folder = found ? path.dirname(found.path) : path.join(root, name);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    if (!found) await fs.mkdir(folder, { mode: 0o700 }).catch(e => { if (e.code === 'EEXIST') throw new HttpError(409, '同名 Skill 已存在'); throw e; });
    try {
      const file = await readPrivate(path.join(folder, 'SKILL.md'), 256 * 1024);
      if (found && file.revision !== revision) throw new HttpError(409, 'Skill 已被修改，请重新打开');
      await writePrivate(file, content);
    } catch(e) { if (!found) await fs.rm(folder, { recursive: true, force: true }); throw e; }
    return this.skills(provider);
  }
  async importSkill(provider: AgentProvider, name: string, sourcePath: string) {
    extensionName.parse(name);
    const root = this.skillRoots(provider)[0]; await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const source = await this.allowedDirectory(sourcePath), target = path.join(await fs.realpath(root), name);
    if (source === target || target.startsWith(source + path.sep)) throw new HttpError(400, '不能导入目标目录自身或其父目录');
    let total = 0, count = 0;
    const inspect = async (folder: string) => { for (const entry of await fs.readdir(folder, { withFileTypes: true })) { if (['.git', '.DS_Store'].includes(entry.name)) continue; const file = path.join(folder, entry.name), stat = await fs.lstat(file); if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new HttpError(403, '导入目录不允许符号链接或特殊文件'); if (++count > 2000 || (total += stat.size) > 20 * 1024 * 1024) throw new HttpError(413, 'Skill 导入限制为 20MB / 2000 项'); if (stat.isDirectory()) await inspect(file); } };
    await inspect(source); const file = await readPrivate(path.join(source, 'SKILL.md'), 256 * 1024); this.skillMetadata(file.content);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const stage = path.join(root, '.import-' + randomUUID());
    try { await fs.cp(source, stage, { recursive: true, errorOnExist: true, force: false, filter: filename => !['.git', '.DS_Store'].includes(path.basename(filename)) });
      total = 0; count = 0; await inspect(stage);
      // Exclusive directory creation prevents imports overwriting existing skills.
      await fs.mkdir(target, { mode: 0o700 }).catch(e => { if (e.code === 'EEXIST') throw new HttpError(409, '同名 Skill 已存在'); throw e; });
      try { for (const entry of await fs.readdir(stage)) await fs.cp(path.join(stage, entry), path.join(target, entry), { recursive: true, force: false, errorOnExist: true }); } catch(e) { await fs.rm(target, { recursive: true, force: true }); throw e; }
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
    return this.skills(provider);
  }
  async removeSkill(provider: AgentProvider, id: string, revision: string) {
    const skill = await this.skillPath(provider, id);
    if (skill.revision !== revision) throw new HttpError(409, 'Skill 已被修改，请重新打开');
    const folder = path.dirname(skill.path), stat = await fs.lstat(folder); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HttpError(403, '不能删除链接目录');
    await fs.rm(folder, { recursive: true });
  }
  private async mcpState(provider: AgentProvider) {
    const file = provider === 'codex' ? await this.configs.read(provider) : await readPrivate(this.claudeJson);
    let value; try { value = provider === 'codex' ? parse(file.content) : file.content ? record(JSON.parse(file.content)) : {}; } catch { throw new HttpError(400, '代理全局配置格式有误，请先修复配置文件'); }
    const key = provider === 'codex' ? 'mcp_servers' : 'mcpServers';
    const disabled = provider === 'claude' ? await readPrivate(path.join(this.state, 'claude-mcp-disabled.json')) : { path: '', content: '', exists: false, revision: '' };
    let archive; try { archive = disabled.content ? record(JSON.parse(disabled.content)) : {}; } catch { throw new HttpError(400, '已停用的 MCP 配置格式有误，请在服务器检查'); }
    return { file, value, key, servers: record(value[key]), disabled, archive, revision: createHash('sha256').update(file.revision + (provider === 'claude' ? disabled.revision : '')).digest('hex') };
  }
  async mcps(provider: AgentProvider, name?: string): Promise<McpDocument | McpDetail> {
    const state = await this.mcpState(provider), values = provider === 'claude' ? { ...state.archive, ...state.servers } : state.servers;
    if (name) { if (!Object.hasOwn(values, name)) throw new HttpError(404, 'MCP 不存在'); const config = { ...record(values[name]) }; return { name, revision: state.revision, enabled: provider === 'codex' ? config.enabled !== false : Object.hasOwn(state.servers, name), config }; }
    return { revision: state.revision, entries: Object.entries(values).map(([name, raw]) => { const value = record(raw); let endpoint = String(value.command ?? ''); if (typeof value.url === 'string') { try { const url = new URL(value.url); endpoint = url.origin; } catch { endpoint = '无效地址'; } } return { name, enabled: provider === 'codex' ? value.enabled !== false : Object.hasOwn(state.servers, name), transport: String(value.type ?? (value.url ? 'http' : 'stdio')), endpoint }; }) };
  }
  async saveMcp(provider: AgentProvider, name: string, config: Record<string, unknown>, enabled: boolean, revision: string, remove = false, create = false) {
    extensionName.parse(name); const state = await this.mcpState(provider);
    if (state.revision !== revision) throw new HttpError(409, 'MCP 配置已变化，请重新读取');
    if (create && (Object.hasOwn(state.servers, name) || Object.hasOwn(state.archive, name))) throw new HttpError(409, '同名 MCP 已存在，请从列表编辑');
    if (!remove) {
      if (typeof config.command === 'string' && config.command.trim() && !config.url) { if (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every(arg => typeof arg === 'string'))) throw new HttpError(400, 'args 必须是字符串数组'); }
      else if (typeof config.url === 'string' && !config.command) { let url; try { url = new URL(config.url); } catch { throw new HttpError(400, '无效 MCP URL'); } if (!['http:', 'https:', ...(provider === 'claude' ? ['ws:', 'wss:'] : [])].includes(url.protocol)) throw new HttpError(400, '不支持的 MCP URL 协议'); }
      else throw new HttpError(400, 'MCP 需要指定 command 或 url，两者任选一个');
      for (const key of ['env', 'http_headers', 'headers']) if (config[key] !== undefined && (config[key] === null || Array.isArray(config[key]) || typeof config[key] !== 'object' || !Object.values(record(config[key])).every(value => typeof value === 'string'))) throw new HttpError(400, key + ' 必须是字符串键值对象');
      if (provider === 'claude' && !['stdio', 'http', 'sse', 'ws'].includes(String(config.type))) throw new HttpError(400, 'Claude MCP 需要 type：stdio/http/sse/ws');
      if (provider === 'claude' && ((config.command && config.type !== 'stdio') || (config.url && config.type === 'stdio'))) throw new HttpError(400, 'MCP type 必须与 command / url 的连接方式匹配');
    }
    delete state.servers[name];
    if (provider === 'codex') { if (!remove) state.servers[name] = { ...config, enabled }; state.value[state.key] = state.servers; await this.configs.write(provider, stringify(state.value as TomlTable), state.file.revision); }
    else {
      // Archive first; an interrupted disable leaves the still-active config authoritative.
      if (!enabled && !remove) state.archive[name] = config;
      await writePrivate(state.disabled, JSON.stringify(state.archive));
      if (enabled && !remove) state.servers[name] = config;
      state.value[state.key] = state.servers;
      await writePrivate(state.file, JSON.stringify(state.value, null, 2) + '\n');
      if (enabled || remove) { const archive = await readPrivate(state.disabled.path); const value = record(JSON.parse(archive.content)); delete value[name]; await writePrivate(archive, JSON.stringify(value)); }
    }
    return this.mcps(provider);
  }
  private async run(provider: AgentProvider, args: string[]) {
    if (this.options.run) return this.options.run(provider, args);
    try { return (await exec(provider, args, { cwd: this.home, timeout: 120000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, CI: '1' } })).stdout; }
    catch { throw new HttpError(502, '代理命令未完成。请检查安装、市场来源、网络或组织策略；需要交互授权的插件请在终端安装。'); }
  }
  async plugins(provider: AgentProvider): Promise<PluginEntry[]> {
    let value: unknown; try { value = JSON.parse(await this.run(provider, ['plugin', 'list', '--json'])); } catch(e) { if (e instanceof HttpError) throw e; throw new HttpError(502, '代理插件列表格式无法识别'); }
    const items = provider === 'codex' ? record(value).installed : value;
    if (!Array.isArray(items)) throw new HttpError(502, '代理插件列表格式无法识别');
    return items.filter(item => provider === 'codex' || record(item).scope === 'user' || record(item).scope === 'skills-dir').map(item => { const row = record(item); return { id: String(row.pluginId ?? row.id ?? ''), name: String(row.name ?? row.id ?? ''), version: String(row.version ?? '未知'), enabled: row.enabled !== false, scope: String(row.scope ?? 'user'), managed: provider === 'claude' && (row.scope !== 'user' || String(row.id).endsWith('@skills-dir')) }; });
  }
  async pluginAction(provider: AgentProvider, id: string, action: 'install' | 'enable' | 'disable' | 'remove') {
    pluginIdSchema.parse(id);
    if (action !== 'install') { const plugin = (await this.plugins(provider)).find(plugin => plugin.id === id); if (!plugin) throw new HttpError(404, '插件未安装'); if (plugin.managed && action === 'remove') throw new HttpError(403, '内置或目录插件请通过其来源管理'); }
    if (provider === 'codex' && ['enable', 'disable'].includes(action)) { const file = await this.configs.read(provider), value = parse(file.content); const plugins = record(value.plugins); plugins[id] = { ...record(plugins[id]), enabled: action === 'enable' }; value.plugins = plugins as TomlTable; await this.configs.write(provider, stringify(value), file.revision); }
    else { const command = provider === 'codex' ? action === 'install' ? 'add' : 'remove' : action === 'install' ? 'install' : action === 'remove' ? 'uninstall' : action;
      await this.run(provider, ['plugin', command, id, ...(provider === 'claude' ? ['--scope', 'user'] : []), '--json']); }
  }
}
