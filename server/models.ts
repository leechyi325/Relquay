import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { AgentModel } from '../shared/protocol.ts';
import { z } from 'zod';
const row = z.object({ value: z.string(), label: z.string(), description: z.string().optional(), effort: z.object({ default: z.string().optional(), values: z.array(z.object({ value: z.string() })) }).optional() });
type Resolved = Record<string, { name: string; id: string }>;
// Claude Code 只提供 sonnet/opus 等别名；具体型号从服务器上安装的 Claude Code 里读取，升级 CLI 后自动跟上。读取失败时用这张表兜底。
export const fallbackAliases: Resolved = {
  fable: { name: 'Fable 5.1', id: 'claude-fable-5-1' },
  opus: { name: 'Opus 5.5', id: 'claude-opus-5-5' },
  sonnet: { name: 'Sonnet 5.5', id: 'claude-sonnet-5-5' },
  haiku: { name: 'Haiku 5.5', id: 'claude-haiku-5-5' }
};
/** 每个系列取版本号最大的型号 ID；CLI 里别名指向的就是它内置的最新型号。 */
export function latestClaudeIds(ids: string[]): Resolved {
  const best: Record<string, [number, number]> = {}, out: Resolved = {};
  for (const id of ids) {
    const match = /^claude-(fable|opus|sonnet|haiku)-(\d)-(\d)$/.exec(id); if (!match) continue;
    const [, family, major, minor] = match, version: [number, number] = [Number(major), Number(minor)], current = best[family];
    if (!current || version[0] > current[0] || (version[0] === current[0] && version[1] > current[1])) best[family] = version;
  }
  for (const [family, [major, minor]] of Object.entries(best)) out[family] = { name: `${family[0].toUpperCase()}${family.slice(1)} ${major}.${minor}`, id: `claude-${family}-${major}-${minor}` };
  return out;
}
function locate(command: string) {
  if (command.includes('/')) return command;
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) { const file = path.join(directory, command); if (fs.existsSync(file)) return file; }
}
let aliasCache: { key: string; data: Resolved } | undefined;
export async function claudeAliases(command = 'claude'): Promise<Resolved> {
  try {
    const file = fs.realpathSync(locate(command) ?? ''), stat = fs.statSync(file), key = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (aliasCache?.key === key) return aliasCache.data;
    const output = await new Promise<string>((resolve, reject) => execFile('grep', ['-aoE', 'claude-(fable|opus|sonnet|haiku)-[0-9]-[0-9]\\b', file], { maxBuffer: 16 << 20, timeout: 20000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const data = { ...fallbackAliases, ...latestClaudeIds(output.split('\n')) };
    aliasCache = { key, data }; return data;
  } catch { return fallbackAliases; }
}
function resolveClaude(item: AgentModel, aliases: Resolved): AgentModel {
  const base = item.id.replace(/\[1m\]$/, ''), hit = aliases[base];
  if (!hit) return item;
  const long = item.id !== base;
  return { ...item, name: `${hit.name}${long ? ' · 1M 上下文' : ''}`, description: `${hit.id}${long ? '[1m]' : ''}${item.description ? ' · ' + item.description : ''}` };
}
export function cloudModels(value: unknown, aliases: Resolved = fallbackAliases): AgentModel[] {
  const parsed = z.object({ models: z.object({ OPTIONS: z.array(row), DEFAULT: z.string() }) }).parse(value);
  return parsed.models.OPTIONS.map(item => resolveClaude({ id: item.value, name: item.label, description: item.description, efforts: item.effort?.values.map(option => option.value) ?? [], defaultEffort: item.effort?.default, isDefault: item.value === parsed.models.DEFAULT, images: true }, aliases));
}
export function validateModel(models: AgentModel[], model?: string, effort?: string) {
  const selected = model ? models.find(item => item.id === model) : models.find(item => item.isDefault);
  if (model && !selected) throw new Error('所选模型已不在服务器目录中，请重新选择');
  if (effort && !selected?.efforts.includes(effort)) throw new Error('所选模型不支持这一思考程度，请重新选择');
  return selected;
}
