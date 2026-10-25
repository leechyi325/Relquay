import { z } from 'zod';
import type { Conversation } from '../shared/protocol.ts';
import { HttpError } from './files.ts';

export const conversationId = z.string().regex(/^[a-zA-Z0-9_-]+$/);
export const conversationRename = z.object({ title: z.string().trim().min(1).max(200) });
export function cloudConversation(input: unknown): Conversation {
  const data = z.object({ sessionId: conversationId, provider: z.enum(['claude', 'codex']), summary: z.string().optional(), sessionTitle: z.string().optional(), lastActivity: z.string().nullable().optional(), isArchived: z.boolean().optional(), projectPath: z.string().optional(), project: z.object({ fullPath: z.string().optional(), path: z.string().optional(), displayName: z.string().optional() }).nullable().optional() }).parse(input);
  if (data.isArchived) throw new HttpError(410, '对应会话已归档，请从工作台选择其他会话');
  return { sessionId: data.sessionId, provider: data.provider, sessionTitle: data.sessionTitle || data.summary || '代理会话', projectDisplayName: data.project?.displayName || '服务器项目', projectPath: data.project?.fullPath ?? data.project?.path ?? data.projectPath, lastActivity: data.lastActivity ?? null };
}
