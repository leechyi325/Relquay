import { z } from 'zod';
export const noticeSchema = z.object({
  id: z.string().uuid(), seq: z.number().int().nonnegative(), type: z.enum(['approval', 'question', 'agent-complete', 'agent-ended', 'agent-failed', 'job-complete', 'job-failed']),
  title: z.string(), createdAt: z.string(), provider: z.enum(['claude', 'codex']).optional(), sessionId: z.string().optional(), jobId: z.string().optional(), requestId: z.string().optional(), readAt: z.string().optional(), resolvedAt: z.string().optional(),
});
export type Notice = z.infer<typeof noticeSchema>;
export type NoticePage = { items: Notice[]; cursor: number; unread: number; hasMore: boolean; gap: boolean };
export type NoticeTarget = { origin: string; eventId: string };
