import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { noticeSchema, type Notice, type NoticePage } from '../shared/notifications.ts';
import type { ChatEvent, Job } from '../shared/protocol.ts';
import { HttpError } from './files.ts';

type Run = { key: string; startedAt: number; active: boolean; absent: number };
type State = { seq: number; items: Notice[]; seen: string[]; runs: Record<string, Run> };
export class NotificationStore {
  private file: string; private state: State;
  constructor(directory: string) {
    this.file = path.join(directory, 'notifications.json');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { seq: 0, items: [], seen: [], runs: {} };
    this.state.items = noticeSchema.array().parse(this.state.items);
  }
  get(id: string) { const item = this.state.items.find(item => item.id === id); if (!item) throw new HttpError(404, '提醒已移除或过期'); return item; }
  page(after?: number): NoticePage {
    const all = after === undefined ? [...this.state.items].reverse() : this.state.items.filter(item => item.seq > after), items = all.slice(0, 100);
    return { items, cursor: after === undefined ? this.state.seq : items.at(-1)?.seq ?? this.state.seq, unread: this.state.items.filter(item => !item.readAt && !item.resolvedAt).length, hasMore: all.length > items.length, gap: after !== undefined && (after > this.state.seq || after > 0 && after < (this.state.items[0]?.seq ?? 1) - 1) };
  }
  read(id?: string) {
    const now = new Date().toISOString();
    if (id) this.get(id).readAt = now; else for (const item of this.state.items) item.readAt ??= now;
    this.persist();
  }
  private add(key: string, value: Omit<Notice, 'id' | 'seq' | 'createdAt'>) {
    if (this.state.seen.includes(key)) return;
    this.state.seen.push(key); this.state.seen = this.state.seen.slice(-3000);
    this.state.items.push({ ...value, id: crypto.randomUUID(), seq: ++this.state.seq, createdAt: new Date().toISOString() }); this.state.items = this.state.items.slice(-500); this.persist();
  }
  private persist() { fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); }
  begin(sessionId: string) {
    this.state.runs[sessionId] = { key: crypto.randomUUID(), active: true, startedAt: Date.now(), absent: 0 };
    const entries = Object.entries(this.state.runs); if (entries.length > 1000) { const old = entries.filter(([, run]) => !run.active).sort((a, b) => a[1].startedAt - b[1].startedAt)[0]; if (old) delete this.state.runs[old[0]]; }
    this.persist();
  }
  watched() { return Object.entries(this.state.runs).filter(([, run]) => run.active).map(([id]) => id); }
  running(ids: string[]) {
    for (const [id, run] of Object.entries(this.state.runs)) if (run.active) {
      if (ids.includes(id)) run.absent = 0;
      else if (Date.now() - run.startedAt > 15000 && ++run.absent >= 2) { run.active = false; this.add('claude:complete:' + run.key, { type: 'agent-ended', provider: 'claude', sessionId: id, title: 'Claude Code 会话已结束，请查看结果' }); }
    }
  }
  ingest(event: ChatEvent, provider: 'claude' | 'codex') {
    const id = event.sessionId; if (!id) return;
    if (event.kind === 'chat_subscribed') {
      if (event.isProcessing && !this.state.runs[id]) this.begin(id);
      if (Array.isArray(event.pendingPermissions)) for (const item of event.pendingPermissions) if (item && typeof item === 'object') this.ingest({ ...item, kind: 'permission_request', sessionId: id }, provider);
      return;
    }
    if (event.kind === 'permission_request' && event.requestId) {
      const question = event.interaction === 'questions' || event.toolName === 'AskUserQuestion';
      this.add(`${provider}:request:${id}:${event.requestId}`, { type: question ? 'question' : 'approval', provider, sessionId: id, requestId: event.requestId, title: `${provider === 'codex' ? 'Codex' : 'Claude Code'} ${question ? '需要你的回答' : '需要手动批准'}` });
    } else if (['permission_resolved', 'permission_cancelled'].includes(event.kind)) {
      for (const item of this.state.items) if (item.sessionId === id && item.requestId === event.requestId) item.resolvedAt ??= new Date().toISOString(); this.persist();
    } else if (event.kind === 'complete') {
      const run = this.state.runs[id];
      if (provider === 'claude' && !run?.active) return;
      if (run) run.active = false;
      const failed = event.success === false || event.exitCode && event.exitCode !== 0 || event.aborted === true;
      this.add(provider === 'codex' ? `codex:complete:${id}:${event.id ?? event.seq}` : 'claude:complete:' + run!.key, { type: failed ? 'agent-failed' : 'agent-complete', provider, sessionId: id, title: `${provider === 'codex' ? 'Codex' : 'Claude Code'} ${failed ? '轮次已中断或失败，请查看结果' : '本轮已完成'}` });
      for (const item of this.state.items) if (item.sessionId === id && ['approval', 'question'].includes(item.type)) item.resolvedAt ??= new Date().toISOString(); this.persist();
    }
  }
  job(job: Job) {
    if (!['succeeded', 'failed', 'interrupted'].includes(job.status)) return;
    this.add(`job:${job.id}:${job.status}`, { type: job.status === 'succeeded' ? 'job-complete' : 'job-failed', jobId: job.id, title: job.status === 'succeeded' ? '后台任务已完成' : '后台任务失败或中断，请查看日志' });
  }
}
