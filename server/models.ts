import type { AgentModel } from '../shared/protocol.ts';
import { z } from 'zod';
const row = z.object({ value: z.string(), label: z.string(), description: z.string().optional(), effort: z.object({ default: z.string().optional(), values: z.array(z.object({ value: z.string() })) }).optional() });
export function cloudModels(value: unknown): AgentModel[] {
  const parsed = z.object({ models: z.object({ OPTIONS: z.array(row), DEFAULT: z.string() }) }).parse(value);
  return parsed.models.OPTIONS.map(item => ({ id: item.value, name: item.label, description: item.description, efforts: item.effort?.values.map(option => option.value) ?? [], defaultEffort: item.effort?.default, isDefault: item.value === parsed.models.DEFAULT, images: true }));
}
export function validateModel(models: AgentModel[], model?: string, effort?: string) {
  const selected = model ? models.find(item => item.id === model) : models.find(item => item.isDefault);
  if (model && !selected) throw new Error('所选模型已不在服务器目录中，请重新选择');
  if (effort && !selected?.efforts.includes(effort)) throw new Error('所选模型不支持这一思考程度，请重新选择');
  return selected;
}
