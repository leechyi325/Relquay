import { z } from 'zod';
import type { ChatEvent } from './protocol';
const questionSchema = z.object({ id: z.string().optional(), header: z.string().optional(), question: z.string(), multiSelect: z.boolean().optional(), isSecret: z.boolean().optional(), options: z.array(z.object({ label: z.string(), description: z.string().optional() })).nullable().optional() });
export type InteractionQuestion = { id: string; title: string; question: string; multiple: boolean; secret: boolean; options: { label: string; description?: string }[] };
export function interactionInput(event: ChatEvent): Record<string, unknown> { const input = event.input ?? event.toolInput; return input && typeof input === 'object' ? input as Record<string, unknown> : {}; }
export function interactionQuestions(event: ChatEvent): InteractionQuestion[] {
  if (event.interaction !== 'questions' && event.toolName !== 'AskUserQuestion') return [];
  const parsed = questionSchema.array().safeParse(interactionInput(event).questions);
  return parsed.success ? parsed.data.map((question, index) => ({ id: question.id ?? String(index), title: question.header ?? `问题 ${index + 1}`, question: question.question, multiple: question.multiSelect === true, secret: question.isSecret === true, options: question.options ?? [] })) : [];
}
export function interactionResponse(event: ChatEvent, values: Record<string, string[]>) {
  const questions = interactionQuestions(event);
  if (!questions.length) throw new Error('无法识别的问题结构，请在终端继续');
  for (const question of questions) if (!values[question.id]?.some(value => value.trim())) throw new Error('请回答所有问题，或明确选择跳过');
  return event.interaction === 'questions'
    ? { answers: Object.fromEntries(questions.map(question => [question.id, { answers: values[question.id] }])) }
    : { updatedInput: { ...interactionInput(event), answers: Object.fromEntries(questions.map(question => [question.question, values[question.id].join(', ')])) } };
}
