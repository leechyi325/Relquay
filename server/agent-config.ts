import path from 'node:path';
import os from 'node:os';
import { parse } from 'smol-toml';
import { HttpError } from './files.ts';
import { readPrivate, writePrivate } from './private-document.ts';
import type { AgentConfig } from '../shared/agent-config.ts';

// Only these settings files are exposed. Auth files and arbitrary paths are excluded.
export class AgentConfigs {
  private saving = new Set<string>();
  constructor(private homes = {
    codex: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    claude: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
  }) {}
  home(provider: AgentConfig['provider']) { return this.homes[provider]; }
  private target(provider: AgentConfig['provider']) {
    return path.join(this.homes[provider], provider === 'codex' ? 'config.toml' : 'settings.json');
  }
  async read(provider: AgentConfig['provider']): Promise<AgentConfig> {
    return { provider, ...await readPrivate(this.target(provider), 512 * 1024) };
  }
  async write(provider: AgentConfig['provider'], content: string, revision: string) {
    if (Buffer.byteLength(content) > 512 * 1024) throw new HttpError(413, '配置文件超过 512KB');
    try {
      if (provider === 'codex') parse(content);
      else { const value = JSON.parse(content); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); }
    } catch { throw new HttpError(400, provider === 'codex' ? 'TOML 格式有误，请检查后保存' : '配置必须是合法的 JSON 对象'); }
    if (this.saving.has(provider)) throw new HttpError(409, '配置正在保存，请稍后重试');
    this.saving.add(provider);
    try {
      const current = await this.read(provider);
      if (current.revision !== revision) throw new HttpError(409, '配置已被其他操作修改，请重新读取后保存');
      await writePrivate(current, content);
      return await this.read(provider);
    } finally { this.saving.delete(provider); }
  }
}
