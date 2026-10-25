import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createStudio } from '../server/app.ts';
export async function fixture(port = 0) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'roamdeck-test-'));
  for (const root of ['project', 'inputs', 'outputs', 'logs']) await fs.mkdir(path.join(temp, root));
  const projects: { projectId: string; fullPath: string; displayName: string }[] = [];
  const catalog = new Map<string, { sessionId: string; provider: string; projectPath: string; sessionTitle: string }>();
  const running = new Set<string>();
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
    if (url.pathname.endsWith('/models')) { res.end(JSON.stringify({ success: true, data: { models: [] } })); return; }
    res.end(JSON.stringify({ success: true }));
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', client => { client.on('message', value => { const input = JSON.parse(value.toString()); if (input.type === 'chat.subscribe') client.send(JSON.stringify({ kind: 'chat_subscribed', sessionId: 'test-session', isProcessing: false, pendingPermissions: [] })); else client.send(value.toString()); }); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const address = upstream.address() as { port: number };
  const studio = createStudio({ base: temp, state: path.join(temp, 'state'), cloud: `http://127.0.0.1:${address.port}`, dist: path.resolve('dist'), origin: 'http://127.0.0.1:' + port });
  studio.server.listen(port, '127.0.0.1'); await once(studio.server, 'listening');
  const studioPort = (studio.server.address() as { port: number }).port, base = `http://127.0.0.1:${studioPort}`;
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test-owner', password: 'fixture-password' }) });
  const { token } = await login.json() as { token: string };
  const call = (url: string, options?: RequestInit) => fetch(base + url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options?.headers } });
  const close = async () => { studio.close(); wss.clients.forEach(c => c.terminate()); wss.close(); upstream.close(); await fs.rm(temp, { recursive: true, force: true }); };
  return { temp, base, token, call, close, studio, projects, catalog, running };
}
export async function until(condition: () => boolean, timeout = 5000) { const start = Date.now(); while (!condition()) { if (Date.now() - start > timeout) throw new Error('Timed out waiting for state'); await new Promise(r => setTimeout(r, 25)); } }
