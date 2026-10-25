import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import crypto from 'node:crypto';
import { z } from 'zod';
import { WebSocket } from 'ws';
import { decodeEvent, type ChatEvent } from '../shared/protocol.ts';
import { HttpError } from './files.ts';
import { appVersion } from '../shared/config.ts';

type Session = { id: string; cwd: string; threadId?: string; turnId?: string; seq: number; processing: boolean; events: ChatEvent[] };
type Approval = { rpcId: string | number; sessionId: string; event: ChatEvent };
const rpcSchema = z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), result: z.unknown().optional(), error: z.object({ message: z.string() }).passthrough().optional() });
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};

/** Local stdio only. CloudCLI remains the session catalog; this fills its exec adapter's approval gap. */
export class CodexBridge {
  sessions = new Map<string, Session>(); approvals = new Map<string, Approval>();
  private listeners = new Map<string, Set<WebSocket>>(); private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private child?: ChildProcessWithoutNullStreams; private starting?: Promise<void>; private requestId = 0; private loaded = new Set<string>();
  constructor(private directory: string, private command = 'codex', private args = ['app-server', '--listen', 'stdio://']) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'sessions.json');
    if (fs.existsSync(file)) {
      for (const metadata of JSON.parse(fs.readFileSync(file, 'utf8')) as Omit<Session, 'events'>[]) {
        const log = path.join(directory, metadata.id + '.jsonl');
        const events = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').flatMap(line => { try { const event = decodeEvent(JSON.parse(line)); return event ? [event] : []; } catch { return []; } }) : [];
        const session = { ...metadata, events, processing: false, turnId: undefined }; this.sessions.set(session.id, session);
        if (metadata.processing) this.emit(session, { kind: 'complete', success: false, aborted: true, content: '服务重启，上一轮已中断；可以继续此会话。' });
      }
    }
  }
  private persist() {
    const file = path.join(this.directory, 'sessions.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify([...this.sessions.values()].map(({ events, ...metadata }) => metadata)), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
  }
  register(id: string, cwd: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new HttpError(400, '无效会话编号');
    this.sessions.set(id, { id, cwd, processing: false, seq: 0, events: [] }); this.persist();
  }
  has(id: string) { return this.sessions.has(id); }
  async archive(id: string) {
    const session = this.sessions.get(id); if (!session) return;
    if (session.processing) throw new HttpError(409, '会话正在运行，请先停止后再删除');
    if (session.threadId) { await this.start(); await this.request('thread/archive', { threadId: session.threadId }); this.loaded.delete(session.threadId); }
  }
  remove(id: string) {
    if (this.sessions.get(id)?.processing) throw new HttpError(409, '会话正在运行，请先停止后再删除');
    this.sessions.delete(id); this.listeners.delete(id);
    fs.rmSync(path.join(this.directory, id + '.jsonl'), { force: true }); this.persist();
  }
  history(id: string, limit = 100) { const s = this.sessions.get(id)!; return { messages: s.events.slice(-limit), total: s.events.length, hasMore: s.events.length > limit }; }
  private emit(session: Session, value: ChatEvent) {
    const event = { ...value, id: value.id ?? crypto.randomUUID(), sessionId: session.id, provider: 'codex', timestamp: new Date().toISOString(), seq: ++session.seq };
    session.events.push(event);
    fs.appendFileSync(path.join(this.directory, session.id + '.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
    for (const ws of this.listeners.get(session.id) ?? []) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    return event;
  }
  subscribe(id: string, ws: WebSocket, lastSeq: number) {
    const session = this.sessions.get(id); if (!session) return;
    if (!this.listeners.has(id)) this.listeners.set(id, new Set()); this.listeners.get(id)!.add(ws);
    ws.once('close', () => this.listeners.get(id)?.delete(ws));
    ws.send(JSON.stringify({ kind: 'chat_subscribed', sessionId: id, isProcessing: session.processing, lastSeq: session.seq, pendingPermissions: [...this.approvals.values()].filter(p => p.sessionId === id).map(p => p.event) }));
    for (const event of session.events) if ((event.seq ?? 0) > lastSeq) ws.send(JSON.stringify(event));
  }
  private write(value: unknown) { if (!this.child?.stdin.writable) throw new Error('Codex App Server 未启动'); this.child.stdin.write(JSON.stringify(value) + '\n'); }
  private request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 超时`)); }, 30000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.write({ id, method, params }); } catch(e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  private async start() {
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = (async () => {
      const child = spawn(this.command, this.args, { stdio: 'pipe', env: process.env }); this.child = child;
      const lines = createInterface({ input: child.stdout }); lines.on('line', line => { try { this.receive(JSON.parse(line)); } catch { /* CLI diagnostics are not protocol messages. */ } });
      const diagnostics = fs.createWriteStream(path.join(this.directory, 'app-server.log'), { flags: 'a', mode: 0o600 }); child.stderr.pipe(diagnostics);
      child.on('error', e => this.fail(e));
      child.on('close', () => { diagnostics.end(); lines.close(); if (this.child === child) { this.child = undefined; this.loaded.clear(); this.fail(new Error('Codex 服务已停止，当前轮次中断')); } });
      await this.request('initialize', { clientInfo: { name: 'roamdeck', title: 'RoamDeck', version: appVersion } });
      this.write({ method: 'initialized', params: {} });
    })();
    try { await this.starting; } finally { this.starting = undefined; }
  }
  private fail(error: Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); } this.pending.clear();
    for (const session of this.sessions.values()) if (session.processing) this.finish(session, false, error.message);
    this.approvals.clear();
  }
  private finish(session: Session, success: boolean, error?: string) {
    if (error) this.emit(session, { kind: 'error', content: error });
    session.processing = false; session.turnId = undefined;
    for (const [id, p] of this.approvals) if (p.sessionId === session.id) { this.approvals.delete(id); this.emit(session, { kind: 'permission_cancelled', requestId: id }); }
    this.emit(session, { kind: 'complete', success }); this.persist();
  }
  async send(id: string, content: string, options: Record<string, unknown> = {}) {
    const session = this.sessions.get(id); if (!session) throw new HttpError(404, '会话不存在');
    if (session.processing) throw new HttpError(409, '当前会话仍在运行');
    session.processing = true; this.persist();
    this.emit(session, { kind: 'text', role: 'user', content });
    try {
      await this.start();
      const config = { cwd: session.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', ...(typeof options.model === 'string' ? { model: options.model } : {}) };
      if (!session.threadId) {
        const result = await this.request<{ thread: { id: string } }>('thread/start', config);
        session.threadId = result.thread.id; this.loaded.add(session.threadId); this.persist();
      } else if (!this.loaded.has(session.threadId)) {
        await this.request('thread/resume', { threadId: session.threadId, excludeTurns: true, ...config }); this.loaded.add(session.threadId);
      }
      const result = await this.request<{ turn: { id: string } }>('turn/start', { threadId: session.threadId, input: [{ type: 'text', text: content }], ...(typeof options.model === 'string' ? { model: options.model } : {}) });
      session.turnId = result.turn.id; this.persist();
    } catch(e) { if (session.processing) this.finish(session, false, String(e)); }
  }
  async abort(id: string) {
    const s = this.sessions.get(id);
    if (s?.processing && s.threadId && s.turnId) await this.request('turn/interrupt', { threadId: s.threadId, turnId: s.turnId });
  }
  approve(requestId: string, allow: boolean) {
    const approval = this.approvals.get(requestId); if (!approval) return false;
    this.write({ id: approval.rpcId, result: { decision: allow ? 'accept' : 'decline' } });
    this.approvals.delete(requestId); const session = this.sessions.get(approval.sessionId)!;
    this.emit(session, { kind: 'permission_resolved', requestId }); return true;
  }
  receive(input: unknown) {
    const decoded = rpcSchema.safeParse(input); if (!decoded.success) return;
    const frame = decoded.data;
    if (frame.id !== undefined && !frame.method) {
      const pending = this.pending.get(Number(frame.id)); if (!pending) return;
      this.pending.delete(Number(frame.id)); clearTimeout(pending.timer);
      if (frame.error) pending.reject(new Error(frame.error.message)); else pending.resolve(frame.result); return;
    }
    const p = frame.params ?? {}, threadId = String(p.threadId ?? record(p.thread).id ?? '');
    const session = [...this.sessions.values()].find(s => s.threadId === threadId);
    if (frame.id !== undefined && frame.method) {
      if (session && ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(frame.method)) {
        const requestId = `codex:${frame.id}`;
        const event = this.emit(session, { kind: 'permission_request', requestId, toolName: frame.method.includes('commandExecution') ? '执行命令' : '修改文件', input: p });
        this.approvals.set(requestId, { rpcId: frame.id, sessionId: session.id, event });
      } else {
        // Never silently approve unsupported requests or user-input forms.
        this.write({ id: frame.id, error: { code: -32601, message: '该交互类型尚未支持，请在终端继续此会话。' } });
        if (session) this.emit(session, { kind: 'error', content: `需要终端处理的交互：${frame.method}` });
      } return;
    }
    if (!session) return;
    const item = record(p.item);
    switch (frame.method) {
      case 'turn/started': session.turnId = String(record(p.turn).id); this.emit(session, { kind: 'status', content: 'Codex 正在工作' }); break;
      case 'item/agentMessage/delta': this.emit(session, { kind: 'stream_delta', content: String(p.delta ?? ''), itemId: p.itemId }); break;
      case 'item/reasoning/summaryTextDelta': this.emit(session, { kind: 'thinking', content: String(p.delta ?? '') }); break;
      case 'item/commandExecution/outputDelta': this.emit(session, { kind: 'tool_result', toolId: String(p.itemId), content: String(p.delta ?? '') }); break;
      case 'item/started':
        if (!['agentMessage', 'userMessage', 'reasoning'].includes(String(item.type))) this.emit(session, { kind: 'tool_use', toolName: String(item.type), toolId: String(item.id), toolInput: item });
        break;
      case 'item/completed':
        if (item.type === 'agentMessage') this.emit(session, { kind: 'text', role: 'assistant', content: String(item.text ?? ''), itemId: item.id });
        else if (!['userMessage', 'reasoning'].includes(String(item.type))) this.emit(session, { kind: 'tool_result', toolId: String(item.id), toolResult: item });
        break;
      case 'turn/completed': this.finish(session, record(p.turn).status === 'completed', record(p.turn).error ? JSON.stringify(record(p.turn).error) : undefined); break;
      case 'error': this.emit(session, { kind: 'error', content: String(record(p.error).message ?? 'Codex 运行出错') }); break;
      case 'serverRequest/resolved': {
        const requestId = `codex:${p.requestId}`; this.approvals.delete(requestId); this.emit(session, { kind: 'permission_resolved', requestId }); break;
      }
      default:
        if (!frame.method?.startsWith('codex/event/')) this.emit(session, { kind: 'status', content: frame.method, details: p });
    }
  }
  close() { this.child?.kill('SIGTERM'); }
}
