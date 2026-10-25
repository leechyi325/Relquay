import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { ClaudeQuota } from '../server/usage.ts';
import { Extensions } from '../server/extensions.ts';
import { AgentConfigs } from '../server/agent-config.ts';
import { createStudio } from '../server/app.ts';
export async function fixture(port = 0) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'roamdeck-test-'));
  for (const root of ['project', 'inputs', 'outputs', 'logs']) await fs.mkdir(path.join(temp, root));
  const projects: { projectId: string; fullPath: string; displayName: string }[] = [];
  const catalog = new Map<string, { sessionId: string; provider: string; projectPath: string; sessionTitle: string }>();
  const running = new Set<string>();
  const sentMessages: Record<string, unknown>[] = [];
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/auth/login') { res.end(JSON.stringify({ token: 'test-upstream-token', user: { username: 'test-owner' } })); return; }
    if (url.pathname === '/api/auth/status') { res.end('{}'); return; }
    if (req.headers.authorization !== 'Bearer test-upstream-token') { res.statusCode = 401; res.end('{}'); return; }
    let body: Record<string, unknown> = {};
    if (['POST', 'PUT'].includes(req.method ?? '')) { const chunks = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
    if (url.pathname === '/api/projects') { res.end(JSON.stringify(projects)); return; }
    if (url.pathname === '/api/projects/create-project') {
      if (projects.some(value => value.fullPath === body.path)) { res.statusCode = 409; res.end('{"error":"Project path already exists"}'); return; }
      const project = { projectId: randomUUID(), fullPath: String(body.path), displayName: String(body.customName) }; projects.push(project); res.end(JSON.stringify({ success: true, project })); return;
    }
    const rename = /^\/api\/projects\/([^/]+)\/rename$/.exec(url.pathname);
    if (rename) { projects.find(value => value.projectId === rename[1])!.displayName = String(body.displayName); res.end('{"success":true}'); return; }
    if (url.pathname === '/api/providers/sessions/recent') { res.end(JSON.stringify({ success: true, data: { conversations: [...catalog.values()].map(session => ({ ...session, projectDisplayName: projects.find(value => value.fullPath === session.projectPath)?.displayName ?? '默认项目', lastActivity: new Date().toISOString() })) } })); return; }
    if (url.pathname === '/api/providers/sessions/running') { res.end(JSON.stringify({ success: true, data: { sessions: [...running].map(sessionId => ({ sessionId })) } })); return; }
    if (url.pathname === '/api/providers/sessions') { const session = { sessionId: randomUUID(), provider: String(body.provider), projectPath: String(body.projectPath), sessionTitle: 'Untitled Session' }; catalog.set(session.sessionId, session); res.end(JSON.stringify({ success: true, data: session })); return; }
    const sessionMatch = /^\/api\/providers\/sessions\/([^/]+)$/.exec(url.pathname);
    if (sessionMatch) {
      const session = catalog.get(sessionMatch[1]);
      if (!session) { res.statusCode = 404; res.end('{"error":"Session not found"}'); return; }
      if (req.method === 'DELETE') { catalog.delete(session.sessionId); res.end('{"success":true}'); return; }
      if (req.method === 'PUT') session.sessionTitle = String(body.summary);
      res.end(JSON.stringify({ success: true, data: { ...session, project: { fullPath: session.projectPath } } })); return;
    }
    if (url.pathname.endsWith('/messages')) { res.end(JSON.stringify({ success: true, data: { messages: [] } })); return; }
    if (url.pathname.endsWith('/models')) { res.end(JSON.stringify({ success: true, data: { models: { DEFAULT: 'claude-test', OPTIONS: [{ value: 'claude-test', label: 'Claude Test', effort: { default: 'medium', values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] } }, { value: 'claude-fast', label: 'Claude Fast' }] } } })); return; }
    res.end(JSON.stringify({ success: true }));
  });
  const subscribers = new Map<WebSocket, Set<string>>(), replay = new Map<string, Record<string, unknown>[]>();
  const publish = (sessionId: string, event: Record<string, unknown>, reset = false) => {
    if (reset) replay.set(sessionId, []);
    const history = replay.get(sessionId) ?? [], message = { ...event, sessionId, seq: history.length + 1 }; history.push(message); replay.set(sessionId, history);
    if (event.kind === 'complete') running.delete(sessionId); else running.add(sessionId);
    for (const [client, ids] of subscribers) if (client.readyState === 1 && ids.has(sessionId)) client.send(JSON.stringify(message));
  };
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', client => { subscribers.set(client, new Set()); client.on('close', () => subscribers.delete(client)); client.on('message', value => {
    const input = JSON.parse(value.toString()); sentMessages.push(input);
    if (input.type === 'chat.subscribe') {
      for (const item of input.sessions) { subscribers.get(client)!.add(item.sessionId); const events = replay.get(item.sessionId) ?? []; client.send(JSON.stringify({ kind: 'chat_subscribed', sessionId: item.sessionId, isProcessing: running.has(item.sessionId), pendingPermissions: running.has(item.sessionId) ? events.filter(event => event.kind === 'permission_request' && !events.some(next => next.kind === 'permission_resolved' && next.requestId === event.requestId)) : [] })); if (running.has(item.sessionId)) for (const event of events) if (Number(event.seq) > (item.lastSeq ?? 0)) client.send(JSON.stringify(event)); }
    } else if (input.type === 'chat.send') {
      const sessionId = input.sessionId; replay.set(sessionId, []); subscribers.get(client)!.add(sessionId);
      if (input.content.includes('UI_APPROVAL')) publish(sessionId, { kind: 'permission_request', requestId: 'ui-approval', toolName: 'Bash', input: { command: 'npm run build', cwd: '/workspace/demo', description: '运行构建，核对页面修改' } });
      else if (input.content.includes('UI_QUESTION')) publish(sessionId, { kind: 'permission_request', requestId: 'ui-question', toolName: 'AskUserQuestion', input: { questions: [{ header: '实现方式', question: '希望优先实现哪些入口？', multiSelect: true, options: [{ label: '文件', description: '优先完成文件管理' }, { label: '终端', description: '优先完成触屏终端' }] }] } });
      else if (input.content.includes('WAIT_OBSERVER')) publish(sessionId, { kind: 'status', content: 'fixture is working' });
      else { publish(sessionId, { kind: 'text', role: 'assistant', content: '已收到测试消息和附件。' }); publish(sessionId, { kind: 'complete' }); }
    } else if (input.type === 'chat.permission-response') {
      const sessionId = [...replay].find(([, events]) => events.some(event => event.requestId === input.requestId))?.[0];
      if (sessionId) { publish(sessionId, { kind: 'permission_resolved', requestId: input.requestId }); publish(sessionId, { kind: 'complete' }); }
    } else if (input.type === 'init') client.send(JSON.stringify({ type: 'output', data: 'TERMINAL_READY\r\n' + 'WRAP_' + 'a'.repeat(160) + '_END\r\n中文_' + '中'.repeat(63) + '_结束\r\nHARD_LINE_ONE\r\nHARD_LINE_TWO\r\n' }));
    else if (input.type === 'input') client.send(JSON.stringify({ type: 'output', data: input.data }));
    else client.send(value.toString());
  }); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address() as { port: number };
  const agentConfigs = new AgentConfigs({ codex: path.join(temp, 'agent-codex'), claude: path.join(temp, 'agent-claude') });
  const pluginRecords: { id: string; version: string; enabled: boolean; scope: string }[] = [];
  const extensions = new Extensions(path.join(temp, 'state'), agentConfigs, async value => { const real = await fs.realpath(value); if (!real.startsWith(await fs.realpath(temp) + path.sep)) throw new Error('outside fixture'); return real; }, { home: temp, claudeJson: path.join(temp, '.claude.json'), codexSkillRoots: [path.join(temp, 'agent-codex/skills')], run: async (provider, args) => {
    if (args[1] === 'list') return JSON.stringify(provider === 'codex' ? { installed: pluginRecords.map(item => ({ ...item, pluginId: item.id, name: item.id.split('@')[0] })) } : pluginRecords);
    const id = args[2], item = pluginRecords.find(item => item.id === id);
    if (['install', 'add'].includes(args[1])) pluginRecords.push({ id, version: '1.0.0', enabled: true, scope: 'user' });
    if (args[1] === 'disable' && item) item.enabled = false;
    if (args[1] === 'enable' && item) item.enabled = true;
    if (['remove', 'uninstall'].includes(args[1]) && item) pluginRecords.splice(pluginRecords.indexOf(item), 1);
    return '{}';
  } });
  const studio = createStudio({ agentConfigs, extensions, codexCommand: process.execPath, codexArgs: [path.resolve('tests/codex-fixture.mjs')], claudeQuota: new ClaudeQuota(path.join(temp, 'no-credentials')), base: temp, state: path.join(temp, 'state'), cloud: `http://127.0.0.1:${address.port}`, dist: path.resolve('dist'), origin: 'http://127.0.0.1:' + port, allowedDirectories: [temp], cloudAssets: path.join(temp, 'cloud-assets'), clientOrigins: ['http://127.0.0.1:3090'] });
  studio.server.listen(port, '127.0.0.1'); await once(studio.server, 'listening');
  const studioPort = (studio.server.address() as { port: number }).port, base = `http://127.0.0.1:${studioPort}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test-owner', password: 'fixture-password' }) });
  const { token } = await login.json() as { token: string };
  const call = (url: string, options?: RequestInit) => fetch(base + url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options?.headers } });
  const close = async () => { studio.close(); wss.clients.forEach(c => c.terminate()); wss.close(); upstream.close(); await fs.rm(temp, { recursive: true, force: true }); };
  return { temp, base, token, call, close, studio, projects, catalog, running, sentMessages, publish, extensions };
}
export async function until(condition: () => boolean, timeout = 5000) { const start = Date.now(); while (!condition()) { if (Date.now() - start > timeout) throw new Error('Timed out waiting for state'); await new Promise(r => setTimeout(r, 25)); } }
