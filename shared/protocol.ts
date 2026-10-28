import { z } from 'zod';

export const roots = ['project', 'inputs', 'outputs', 'logs'] as const;
export type RootId = string;
export const rootIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const locationSchema = z.object({ root: rootIdSchema.default('project'), path: z.string().max(4096).default('') });
export const fileModuleSchema = z.object({ id: rootIdSchema, name: z.string().trim().min(1).max(60), folders: z.array(z.object({ id: rootIdSchema, name: z.string().trim().min(1).max(100), path: z.string().min(1).max(4096) })).min(1).max(30) });
export type FileModule = z.infer<typeof fileModuleSchema>;
export type FileRoot = FileModule['folders'][number] & { moduleId: string; moduleName: string };
export type AgentModel = { id: string; name: string; description?: string; efforts: string[]; defaultEffort?: string; isDefault?: boolean; images?: boolean };
export const attachmentSchema = z.union([z.object({ uploadId: z.string().uuid() }), locationSchema]);
export type AttachmentReference = z.infer<typeof attachmentSchema>;
export type ChatAttachment = { id: string; name: string; size: number; mime: string; reference: AttachmentReference; source: 'phone' | 'server' };
export type FileLocation = z.infer<typeof locationSchema>;
export type FileEntry = FileLocation & { name: string; directory: boolean; size: number; modified: number; mime: string };
export type Provider = 'claude' | 'codex';
export type Conversation = { sessionId: string; provider: Provider; sessionTitle: string; projectDisplayName: string; lastActivity: string | null; projectPath?: string; projectId?: string | null };
export const conversationCreateSchema = z.object({
  provider: z.enum(['claude', 'codex']), projectName: z.string().trim().min(1).max(100),
  title: z.string().trim().max(200).default(''), cwd: locationSchema,
  createDirectory: z.boolean().default(false),
});
export type ConversationCreate = z.infer<typeof conversationCreateSchema>;
export const eventSchema = z.object({
  kind: z.string(), id: z.string().optional(), sessionId: z.string().optional(), seq: z.number().optional(),
  content: z.string().optional(), text: z.string().optional(), role: z.string().optional(),
  toolName: z.string().optional(), requestId: z.string().optional(), timestamp: z.string().optional(),
}).passthrough();
export type ChatEvent = z.infer<typeof eventSchema>;
export type ChatState = { events: ChatEvent[]; lastSeq: number; processing: boolean; permissions: ChatEvent[]; error?: string };
export const emptyChat: ChatState = { events: [], lastSeq: 0, processing: false, permissions: [] };
export function decodeEvent(value: unknown): ChatEvent | null {
  const decoded = eventSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
}
export function reduceChat(state: ChatState, event: ChatEvent): ChatState {
  if (event.kind === 'chat_subscribed') {
    const permissions = Array.isArray(event.pendingPermissions)
      ? event.pendingPermissions.map(v => decodeEvent({ ...v, kind: 'permission_request' })).filter((e): e is ChatEvent => !!e) : [];
    return { ...state, processing: event.isProcessing === true, permissions };
  }
  if (event.seq !== undefined && event.seq <= state.lastSeq) return state;
  const next = { ...state, lastSeq: event.seq ?? state.lastSeq };
  switch (event.kind) {
    case 'permission_request':
      next.permissions = [...state.permissions.filter(e => e.requestId !== event.requestId), event]; break;
    case 'permission_resolved':
    case 'permission_cancelled':
      next.permissions = state.permissions.filter(e => e.requestId !== event.requestId); break;
    case 'token_usage': break;
    case 'status': if (!event.tokenBudget) next.processing = true; break;
    case 'complete': next.processing = false; next.permissions = []; break;
    case 'protocol_error': next.error = String(event.message ?? event.content ?? '会话连接错误'); next.processing = false; break;
    case 'interaction_error': next.error = String(event.content ?? '回应未被接受'); break;
    default: if (event.kind !== 'session_upserted' && event.kind !== 'loading_progress') next.processing = true;
  }
  if (event.kind !== 'session_upserted' && event.kind !== 'loading_progress') {
    const optimistic = event.kind === 'text' && event.role === 'user' ? state.events.findIndex(e => e.optimistic === true) : -1;
    next.events = optimistic >= 0 ? state.events.map((e, i) => i === optimistic ? event : e) : [...state.events, event];
  }
  return next;
}
export type Job = {
  id: string; title: string; command: string; cwd: FileLocation; createdAt: string;
  status: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  startedAt?: string; endedAt?: string; exitCode?: number | null;
};
export type ServerStatus = {
  hostname: string; architecture: string; uptime: number; cpu: number; memoryUsed: number; memoryTotal: number;
  diskFree: number; diskTotal: number; cloudcli: boolean; projectPath: string;
  providers: { id: Provider; installed: boolean; authorized: boolean }[];
};
