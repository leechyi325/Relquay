import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { attachmentSchema, type ChatEvent } from '../shared/protocol.ts';
import { HttpError } from './files.ts';

export const queuedMessageSchema = z.object({
  content: z.string().trim().min(1).max(200000),
  options: z.object({ permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions']).default('default'), model: z.string().max(200).optional(), effort: z.string().max(50).optional(), attachments: attachmentSchema.array().max(10).optional() }).default({ permissionMode: 'default' }),
  attachments: z.array(z.object({ name: z.string().max(500), size: z.number(), mime: z.string().max(200) })).max(10).default([]),
});
export type QueuedMessage = z.infer<typeof queuedMessageSchema> & { id: string; createdAt: string };
export type QueueView = { sessionId: string; items: QueuedMessage[]; paused?: string; sending: boolean };
type Entry = { items: QueuedMessage[]; paused?: string };
const LIMIT = 5;

/**
 * Messages written while the agent is still working. The server sends the next one when a run completes
 * normally, so the queue keeps moving with the phone closed. A stopped or failed run pauses the queue
 * instead of sending more work after something went wrong.
 */
export class MessageQueue {
  private state: Record<string, Entry> = {}; private file: string;
  private sending = new Set<string>(); private handled = new Set<string>(); private dispatchedAt = new Map<string, number>();
  constructor(directory: string, private dispatch: (sessionId: string, item: QueuedMessage) => Promise<void>, private idle: (sessionId: string) => Promise<boolean>, private announce: (view: QueueView & { dispatched?: boolean }) => void = () => {}) {
    this.file = path.join(directory, 'message-queue.json');
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* No queued messages yet. */ }
  }
  view(sessionId: string): QueueView { const entry = this.state[sessionId]; return { sessionId, items: entry?.items ?? [], paused: entry?.paused, sending: this.sending.has(sessionId) }; }
  async add(sessionId: string, input: unknown) {
    const value = queuedMessageSchema.parse(input), entry = this.state[sessionId] ??= { items: [] };
    if (entry.items.length >= LIMIT) throw new HttpError(409, `每个会话最多排队 ${LIMIT} 条消息`);
    const item = { ...value, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    entry.items.push(item); this.changed(sessionId);
    // The run may have finished between the phone's decision and this request.
    if (!entry.paused && await this.idle(sessionId).catch(() => false)) await this.next(sessionId);
    return item;
  }
  remove(sessionId: string, id: string) {
    const entry = this.state[sessionId]; if (!entry?.items.some(item => item.id === id)) throw new HttpError(404, '该排队消息已发送或已移除');
    entry.items = entry.items.filter(item => item.id !== id); this.changed(sessionId);
  }
  async resume(sessionId: string) {
    const entry = this.state[sessionId]; if (!entry) return this.view(sessionId);
    entry.paused = undefined; this.changed(sessionId);
    if (await this.idle(sessionId)) await this.next(sessionId); else this.announce(this.view(sessionId));
    return this.view(sessionId);
  }
  forget(sessionId: string) { if (this.state[sessionId]) { delete this.state[sessionId]; this.persist(); } }
  /** Called for every completion seen on any upstream connection; duplicates of one completion are ignored. */
  async completed(event: ChatEvent) {
    const id = event.sessionId; if (!id || event.kind !== 'complete' || !this.state[id]?.items.length) return;
    const key = `${id}:${event.id ?? event.seq ?? event.timestamp ?? ''}`;
    if (this.handled.has(key)) return; this.handled.add(key); if (this.handled.size > 500) this.handled.delete(this.handled.values().next().value!);
    // A completion that arrives right after a dispatch belongs to the run before it.
    if (Date.now() - (this.dispatchedAt.get(id) ?? 0) < 1500) return;
    if (event.aborted === true || event.success === false) { this.state[id].paused = '上一轮已停止或未成功完成，排队消息已暂停'; this.changed(id); return; }
    await this.next(id);
  }
  private async next(sessionId: string) {
    const entry = this.state[sessionId];
    if (!entry?.items.length || entry.paused || this.sending.has(sessionId)) return;
    const item = entry.items.shift()!; this.sending.add(sessionId); this.dispatchedAt.set(sessionId, Date.now()); this.persist();
    this.announce({ ...this.view(sessionId), dispatched: true });
    try { await this.dispatch(sessionId, item); }
    catch(e) { entry.items.unshift(item); entry.paused = '自动发送失败：' + (e instanceof Error ? e.message : String(e)).slice(0, 200); }
    finally { this.sending.delete(sessionId); this.changed(sessionId); }
  }
  private changed(sessionId: string) {
    const entry = this.state[sessionId]; if (entry && !entry.items.length) delete this.state[sessionId];
    this.persist(); this.announce(this.view(sessionId));
  }
  private persist() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); }
}
