import type { AgentModel } from '../shared/protocol.ts';
import { z } from 'zod';
const row = z.object({ value: z.string(), label: z.string(), description: z.string().optional(), effort: z.object({ default: z.string().optional(), values: z.array(z.object({ value: z.string() })) }).optional() });
// Claude Code 只提供 sonnet/opus 等别名；这里补上别名当前对应的具体型号，别名升级后需同步更新。
const claudeResolved: Record<string, { name: string; id: string }> = {
  fable: { name: 'Fable 5.1', id: 'claude-fable-5-1' },
  opus: { name: 'Opus 5.5', id: 'claude-opus-5-5' },
  sonnet: { name: 'Sonnet 5.5', id: 'claude-sonnet-5-5' },
  haiku: { name: 'Haiku 5.5', id: 'claude-haiku-5-5' }
};
function resolveClaude(item: AgentModel): AgentModel {
  const base = item.id.replace(/\[1m\]$/, ''), hit = claudeResolved[base];
  if (!hit) return item;
  const long = item.id !== base;
  return { ...item, name: `${hit.name}${long ? ' · 1M 上下文' : ''}`, description: `${hit.id}${long ? '[1m]' : ''}${item.description ? ' · ' + item.description : ''}` };
}
export function cloudModels(value: unknown): AgentModel[] {
  const parsed = z.object({ models: z.object({ OPTIONS: z.array(row), DEFAULT: z.string() }) }).parse(value);
  return parsed.models.OPTIONS.map(item => resolveClaude({ id: item.value, name: item.label, description: item.description, efforts: item.effort?.values.map(option => option.value) ?? [], defaultEffort: item.effort?.default, isDefault: item.value === parsed.models.DEFAULT, images: true }));
}
export function validateModel(models: AgentModel[], model?: string, effort?: string) {
  const selected = model ? models.find(item => item.id === model) : models.find(item => item.isDefault);
  if (model && !selected) throw new Error('所选模型已不在服务器目录中，请重新选择');
  if (effort && !selected?.efforts.includes(effort)) throw new Error('所选模型不支持这一思考程度，请重新选择');
  return selected;
}
