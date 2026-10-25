import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'node:http';
import { promises as fs, existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import multer from 'multer';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { conversationCreateSchema, fileModuleSchema, locationSchema } from '../shared/protocol.ts';
import { FileModules } from './modules.ts';
import { Attachments, withFileReferences } from './attachments.ts';
import { cloudModels, validateModel } from './models.ts';
import { Files, HttpError, streamFile } from './files.ts';
import { Jobs } from './jobs.ts';
import { CodexBridge } from './codex.ts';
import { appVersion } from '../shared/config.ts';
import { UsageStore, ClaudeQuota } from './usage.ts';
import { NotificationStore } from './notifications.ts';
import { CloudObserver } from './cloud-observer.ts';
import { claudeTokens } from '../shared/usage.ts';
import { decodeEvent } from '../shared/protocol.ts';

const exec = promisify(execFile);
type Config = { base: string; state: string; cloud: string; dist: string; origin: string; filebrowser?: string; envFile?: string; allowedDirectories?: string[]; cloudAssets?: string; clientOrigins?: string[]; codexCommand?: string; codexArgs?: string[]; claudeQuota?: ClaudeQuota };
type LoginSession = { token: string; cloudToken: string; username: string; expires: number };
const readBearer = (req: Request) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
const readCookie = (req: Request) => /(?:^|;\s*)studio=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
export function createStudio(config: Config) {
  mkdirSync(config.state, { recursive: true, mode: 0o700 });
  const notices = new NotificationStore(config.state), usage = new UsageStore(config.state), claudeQuota = config.claudeQuota ?? new ClaudeQuota();
  const modules = new FileModules(config.base, config.state, config.allowedDirectories);
  const files = new Files(config.base, id => modules.root(id)), jobs = new Jobs(path.join(config.state, 'jobs'), files, config.envFile, job => notices.job(job));
  const codex = new CodexBridge(path.join(config.state, 'codex'), config.codexCommand ?? 'codex', config.codexArgs ?? ['app-server', '--listen', 'stdio://'], event => { notices.ingest(event, 'codex'); usage.ingest(event); });
  const attachments = new Attachments(path.join(config.state, 'attachments'), files, config.cloudAssets ?? path.join(os.homedir(), '.cloudcli/assets'));
  const app = express(); app.disable('x-powered-by'); app.set('trust proxy', 'loopback');
  const server = createServer(app), wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const sessionsFile = path.join(config.state, 'sessions.json');
  const sessions = new Map<string, LoginSession>(existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, 'utf8')) : []);
  const observer = new CloudObserver(config.cloud, () => [...sessions.values()].reverse().find(session => session.expires > Date.now())?.cloudToken, notices, id => codex.has(id), event => usage.ingest(event));
  const persistSessions = () => { writeFileSync(sessionsFile + '.tmp', JSON.stringify([...sessions]), { mode: 0o600 }); renameSync(sessionsFile + '.tmp', sessionsFile); };
  const socketOwners = new WeakMap<WebSocket, string>();
  const secretFile = path.join(config.state, 'preview.secret');
  if (!existsSync(secretFile)) writeFileSync(secretFile, crypto.randomBytes(32), { mode: 0o600 });
  const secret = readFileSync(secretFile);
  const tickets = new Map<string, { session: LoginSession; expires: number; channel: string }>();
  const attempts = new Map<string, { count: number; until: number }>();
  const allowed = new Set([config.origin, 'https://localhost', 'capacitor://localhost', 'http://localhost:5173', 'http://127.0.0.1:5173', ...(config.clientOrigins ?? [])]);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!req.path.startsWith('/preview/') && origin && !allowed.has(origin) && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) { res.status(403).json({ error: '来源不允许' }); return; }
    if (origin) res.set({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin' });
    res.set({ 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });
  app.use(express.json({ limit: '3mb' }));
  const asyncRoute = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };
  const cloud = async (endpoint: string, token?: string, init?: RequestInit) => {
    const response = await fetch(config.cloud + '/api' + endpoint, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init?.headers }, signal: AbortSignal.timeout(30000) });
    const data = await response.json().catch(() => ({ error: '上游返回格式异常' }));
    if (!response.ok) throw new HttpError(response.status, typeof data.error === 'string' ? data.error : data.message ?? 'CloudCLI 请求失败');
    return data;
  };
  const getSession = (token?: string) => {
    const session = token ? sessions.get(token) : undefined;
    if (!session || session.expires < Date.now()) throw new HttpError(401, '请重新登录工作台');
    return session;
  };
  const auth = (req: Request, res: Response, next: NextFunction) => {
    try { res.locals.session = getSession(readBearer(req) ?? readCookie(req)); next(); } catch(e) { next(e); }
  };
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: appVersion }));
  app.post('/api/login', asyncRoute(async (req, res) => {
    const key = req.ip ?? 'unknown', now = Date.now();
    let attempt = attempts.get(key);
    if (!attempt || attempt.until < now) { attempt = { count: 0, until: now + 15 * 60_000 }; attempts.set(key, attempt); }
    if (attempt.count++ >= 10) throw new HttpError(429, '登录尝试过多，请稍后重试');
    const credentials = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(1000) }).parse(req.body);
    const result = await cloud('/auth/login', undefined, { method: 'POST', body: JSON.stringify(credentials) });
    const token = crypto.randomBytes(32).toString('base64url');
    const session = { token, cloudToken: String(result.token), username: credentials.username, expires: now + 7 * 86400_000 };
    sessions.set(token, session); persistSessions(); attempts.delete(key);
    observer.start();
    res.cookie('studio', token, { httpOnly: true, secure: config.origin.startsWith('https:'), sameSite: 'strict', maxAge: 7 * 86400_000 });
    res.json({ token, username: credentials.username });
  }));
  app.use('/api', (req, res, next) => { if (req.path === '/health' || req.path === '/login') { next(); return; } auth(req, res, next); });
  app.post('/api/logout', (_req, res) => {
    const token = res.locals.session.token; sessions.delete(token); persistSessions();
    for (const ws of wss.clients) if (socketOwners.get(ws) === token) ws.close(1008, '已退出登录');
    res.clearCookie('studio'); res.json({ ok: true });
  });
  app.get('/api/me', (_req, res) => res.json({ username: res.locals.session.username }));
  app.get('/api/usage/accounts', asyncRoute(async (_req, res) => res.json({ accounts: await Promise.all([codex.accountUsage(), claudeQuota.read()]) })));
  app.get('/api/usage/sessions/:id', asyncRoute(async (req, res) => {
    const id = z.string().regex(/^[a-zA-Z0-9_-]+$/).parse(req.params.id);
    if (!codex.has(id)) {
      const session = await cloud('/providers/sessions/' + id, res.locals.session.cloudToken);
      if (session.data.provider === 'claude') {
        try { usage.set(id, claudeTokens((await cloud('/providers/sessions/' + id + '/token-usage', res.locals.session.cloudToken)).data)); } catch { /* Keep the last actually reported snapshot. */ }
      }
    }
    res.json({ snapshot: usage.get(id), reason: usage.get(id) ? undefined : '首轮返回用量后显示；尚未报告的数据不会估算' });
  }));
  app.get('/api/notifications', (req, res, next) => { try { observer.start(); const after = z.coerce.number().int().nonnegative().optional().parse(req.query.after); res.json(notices.page(after)); } catch(e) { next(e); } });
  app.get('/api/notifications/:id', (req, res, next) => { try { res.json(notices.get(String(req.params.id))); } catch(e) { next(e); } });
  app.post('/api/notifications/read-all', (_req, res) => { notices.read(); res.json({ ok: true }); });
  app.post('/api/notifications/:id/read', (req, res, next) => { try { notices.read(String(req.params.id)); res.json({ ok: true }); } catch(e) { next(e); } });
  app.get('/api/agents/:provider/models', asyncRoute(async (req, res) => {
    const provider = z.enum(['claude', 'codex']).parse(req.params.provider);
    res.json({ models: provider === 'codex' ? await codex.models() : cloudModels((await cloud('/providers/claude/models', res.locals.session.cloudToken)).data) });
  }));
  app.post('/api/conversations', asyncRoute(async (req, res) => {
    const body = conversationCreateSchema.parse(req.body), token = res.locals.session.cloudToken;
    const loc = { ...body.cwd };
    if (body.createDirectory) {
      if (['.', '..'].includes(body.projectName) || /[/\\\0]/.test(body.projectName)) throw new HttpError(400, '项目文件夹名称不能包含斜线或特殊路径');
      loc.path = path.posix.join(loc.path, body.projectName);
      await fs.mkdir(await files.resolve(loc, true));
    }
    const projectPath = await files.resolve(loc);
    if (!(await fs.stat(projectPath)).isDirectory()) throw new HttpError(400, '请选择项目目录');
    let project: { projectId?: string; isArchived?: boolean };
    try {
      const result = await cloud('/projects/create-project', token, { method: 'POST', body: JSON.stringify({ path: projectPath, customName: body.projectName }) });
      project = z.object({ projectId: z.string(), isArchived: z.boolean().optional() }).parse(result.project);
    } catch(error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
      const list = z.array(z.object({ projectId: z.string().optional(), name: z.string().optional(), id: z.string().optional(), fullPath: z.string().optional(), path: z.string().optional() })).parse(await cloud('/projects?skipSync=1', token));
      const existing = list.find(value => (value.fullPath ?? value.path) === projectPath);
      const id = existing?.projectId ?? existing?.name ?? existing?.id;
      if (!id) throw new HttpError(502, '无法定位现有项目，请刷新后重试');
      project = { projectId: id };
      await cloud(`/projects/${encodeURIComponent(id)}/rename`, token, { method: 'PUT', body: JSON.stringify({ displayName: body.projectName }) });
    }
    if (project.isArchived) await cloud(`/projects/${encodeURIComponent(project.projectId!)}/restore`, token, { method: 'POST', body: '{}' });
    const result = await cloud('/providers/sessions', token, { method: 'POST', body: JSON.stringify({ provider: body.provider, projectPath, initialMessage: '' }) });
    const sessionId = z.string().regex(/^[a-zA-Z0-9_-]+$/).parse(result.data.sessionId), title = body.title || '新会话';
    await cloud(`/providers/sessions/${sessionId}`, token, { method: 'PUT', body: JSON.stringify({ summary: title }) });
    if (body.provider === 'codex') codex.register(sessionId, projectPath);
    res.status(201).json({ sessionId, provider: body.provider, projectDisplayName: body.projectName, projectPath, sessionTitle: title, lastActivity: new Date().toISOString() });
  }));
  app.delete('/api/conversations/:id', asyncRoute(async (req, res) => {
    const id = z.string().regex(/^[a-zA-Z0-9_-]+$/).parse(req.params.id), token = res.locals.session.cloudToken;
    if (codex.sessions.get(id)?.processing) throw new HttpError(409, '会话正在运行，请先停止后再删除');
    const running = await cloud('/providers/sessions/running', token);
    if (z.array(z.object({ sessionId: z.string() })).parse(running.data.sessions).some(value => value.sessionId === id)) throw new HttpError(409, '会话正在运行，请先停止后再删除');
    if (codex.has(id)) await codex.archive(id);
    await cloud(`/providers/sessions/${id}?force=true&deletedFromDisk=true`, token, { method: 'DELETE' });
    if (codex.has(id)) codex.remove(id);
    res.json({ ok: true });
  }));
  app.post('/api/socket-ticket', (req, res) => {
    const channel = z.enum(['chat', 'terminal']).parse(req.body.channel), ticket = crypto.randomBytes(24).toString('base64url');
    for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key);
    tickets.set(ticket, { channel, session: res.locals.session, expires: Date.now() + 30_000 }); res.json({ ticket });
  });
  app.use('/api/cloud', asyncRoute(async (req, res) => {
    // Keep CloudCLI owner registration, plugin installation and unrelated admin routes private.
    if (!/^\/(providers|projects|git|commands)(\/|\?|$)/.test(req.url)) throw new HttpError(404, '接口不可用');
    const history = /^\/providers\/sessions\/([a-zA-Z0-9_-]+)\/messages/.exec(req.url);
    if (req.method === 'GET' && history && codex.has(history[1])) { res.json({ success: true, data: codex.history(history[1]) }); return; }
    const data = await cloud(req.url, res.locals.session.cloudToken, { method: req.method, ...(req.method === 'GET' ? {} : { body: JSON.stringify(req.body) }) });
    if (req.method === 'POST' && req.path === '/providers/sessions' && req.body.provider === 'codex') codex.register(data.data.sessionId, req.body.projectPath);
    res.json(data);
  }));
  app.get('/api/status', asyncRoute(async (_req, res) => {
    const stat = await fs.statfs(config.base);
    const providers = await Promise.all((['codex', 'claude'] as const).map(async id => {
      let installed = false, authorized = false;
      try { await exec(id, ['--version'], { timeout: 5000 }); installed = true; } catch {}
      if (installed) {
        try { await exec(id, id === 'codex' ? ['login', 'status'] : ['auth', 'status'], { timeout: 7000 }); authorized = true; } catch {}
      }
      return { id, installed, authorized };
    }));
    let cloudcli = false;
    try { cloudcli = (await fetch(config.cloud + '/api/auth/status', { signal: AbortSignal.timeout(2000) })).ok; } catch {}
    res.json({ hostname: os.hostname(), architecture: os.arch(), uptime: os.uptime(), cpu: os.loadavg()[0] / os.cpus().length,
      memoryUsed: os.totalmem() - os.freemem(), memoryTotal: os.totalmem(), diskFree: Number(stat.bavail) * Number(stat.bsize), diskTotal: Number(stat.blocks) * Number(stat.bsize), providers, cloudcli, projectPath: path.join(config.base, 'project') });
  }));
  app.get('/api/files', asyncRoute(async (req, res) => res.json(await files.list(locationSchema.parse(req.query)))));
  app.post('/api/files/resolve', asyncRoute(async (req, res) => res.json({ path: await files.resolve(locationSchema.parse(req.body)), terminalRc: path.join(config.base, 'studio/terminal.rc') })));
  const activeRoots = () => new Set(jobs.records.filter(job => ['queued', 'running', 'cancelling'].includes(job.status)).map(job => job.cwd.root));
  app.get('/api/file-modules', (_req, res) => res.json(modules.modules));
  app.put('/api/file-modules/:id', asyncRoute(async (req, res) => {
    const module = fileModuleSchema.parse({ ...req.body, id: req.params.id });
    res.json(await modules.save(module, activeRoots));
  }));
  app.delete('/api/file-modules/:id', (req, res, next) => { try { modules.remove(String(req.params.id), activeRoots()); res.json({ ok: true }); } catch(e) { next(e); } });
  app.get('/api/directories', asyncRoute(async (req, res) => res.json(await modules.browse(z.string().optional().parse(req.query.path)))));
  app.get('/api/files/text', asyncRoute(async (req, res) => res.json(await files.read(locationSchema.parse(req.query)))));
  app.put('/api/files/text', asyncRoute(async (req, res) => {
    const body = locationSchema.extend({ content: z.string().max(2 * 1024 * 1024), modified: z.number() }).parse(req.body);
    res.json(await files.write(body, body.content, body.modified));
  }));
  app.post('/api/files/folder', asyncRoute(async (req, res) => {
    const loc = locationSchema.parse(req.body);
    if (!loc.path) throw new HttpError(400, '目录名不能为空');
    await fs.mkdir(await files.resolve(loc, true)); res.json({ ok: true });
  }));
  app.post('/api/files/move', asyncRoute(async (req, res) => {
    const body = z.object({ from: locationSchema, to: locationSchema }).parse(req.body);
    await files.move(body.from, body.to); res.json({ ok: true });
  }));
  const upload = multer({ dest: path.join(config.state, 'uploads'), limits: { fileSize: 512 * 1024 * 1024, files: 1 } });
  app.post('/api/chat/attachments', upload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) throw new HttpError(400, '没有选择文件');
    try { res.status(201).json(await attachments.upload(req.file.path, req.file.originalname)); }
    finally { await fs.rm(req.file.path, { force: true }); }
  }));
  app.post('/api/files/upload', upload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) throw new HttpError(400, '没有选择文件');
    try {
      const loc = locationSchema.parse(req.query);
      const candidate = /^[\u0000-\u00ff]*$/.test(req.file.originalname) ? Buffer.from(req.file.originalname, 'latin1').toString('utf8') : req.file.originalname;
      const original = candidate.includes('\ufffd') ? req.file.originalname : candidate;
      const name = path.basename(original);
      if (name !== original || name === '.' || name === '..') throw new HttpError(400, '无效文件名');
      const target = await files.resolve({ root: loc.root, path: path.posix.join(loc.path, name) }, true);
      await fs.copyFile(req.file.path, target, 1); res.json({ ok: true, name });
    } finally { await fs.rm(req.file.path, { force: true }); }
  }));
  app.get('/api/files/download', asyncRoute(async (req, res) => { await streamFile(res, await files.resolve(locationSchema.parse(req.query)), req.headers.range, true); }));
  const sign = (payload: string) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  app.post('/api/files/preview', asyncRoute(async (req, res) => {
    const loc = locationSchema.parse(req.body); await files.resolve(loc);
    const directory = path.posix.dirname(loc.path);
    const payload = Buffer.from(JSON.stringify({ root: loc.root, path: directory === '.' ? '' : directory, mount: modules.fingerprint(loc.root), expires: Date.now() + 15 * 60_000 })).toString('base64url');
    res.json({ url: `/preview/${payload}.${sign(payload)}/${encodeURIComponent(path.posix.basename(loc.path))}` });
  }));
  app.get('/preview/:ticket/*asset', asyncRoute(async (req, res) => {
    const [payload, signature] = String(req.params.ticket).split('.');
    const expected = sign(payload ?? '');
    if (!signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new HttpError(403, '预览链接无效');
    const cap = locationSchema.extend({ expires: z.number(), mount: z.string().optional() }).parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
    if (cap.expires < Date.now()) throw new HttpError(410, '预览已过期，请重新打开');
    if (cap.mount !== modules.fingerprint(cap.root)) throw new HttpError(410, '目录映射已修改，请重新打开预览');
    const asset = req.params.asset as unknown as string[];
    const relative = asset.join('/');
    if (relative.split('/').includes('..')) throw new HttpError(403, '无效预览路径');
    const loc = { root: cap.root, path: path.posix.join(cap.path, relative) };
    res.set({ 'Access-Control-Allow-Origin': '*', 'Content-Security-Policy': "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self' https://localhost capacitor://localhost" });
    await streamFile(res, await files.resolve(loc), req.headers.range, req.query.download === '1');
  }));
  app.get('/api/jobs', (_req, res) => res.json([...jobs.records].reverse().slice(0, 200)));
  app.post('/api/jobs', asyncRoute(async (req, res) => {
    const body = z.object({ title: z.string().min(1).max(200), command: z.string().min(1).max(16000), cwd: locationSchema }).parse(req.body);
    res.status(201).json(await jobs.add(body.title, body.command, body.cwd));
  }));
  app.post('/api/jobs/:id/cancel', (req, res) => res.json(jobs.cancel(String(req.params.id))));
  app.get('/api/jobs/:id/log', (req, res) => res.json({ log: jobs.log(String(req.params.id)) }));
  app.get('/api/roots', (_req, res) => res.json(modules.listRoots()));
  if (config.filebrowser) {
    const browserTickets = new Map<string, { token: string; expires: number }>();
    app.post('/api/filebrowser-link', (_req, res) => {
      for (const [key, value] of browserTickets) if (value.expires < Date.now()) browserTickets.delete(key);
      const ticket = crypto.randomBytes(24).toString('base64url');
      browserTickets.set(ticket, { token: res.locals.session.token, expires: Date.now() + 30000 });
      res.json({ url: '/files-manager-pair?ticket=' + ticket });
    });
    app.get('/files-manager-pair', (req, res, next) => {
      try {
        const key = String(req.query.ticket ?? ''), pair = browserTickets.get(key); browserTickets.delete(key);
        if (!pair || pair.expires < Date.now()) throw new HttpError(401, '连接链接已过期');
        getSession(pair.token);
        res.cookie('studio', pair.token, { httpOnly: true, secure: config.origin.startsWith('https:'), sameSite: 'strict', maxAge: 7 * 86400_000 });
        res.redirect('/files-manager/');
      } catch(e) { next(e); }
    });
    app.use('/files-manager', auth, createProxyMiddleware({ target: config.filebrowser, changeOrigin: true, pathRewrite: path => '/files-manager' + path, on: { proxyReq(proxyReq, _req, res) {
      const session = (res as Response).locals.session as LoginSession;
      proxyReq.setHeader('X-Remote-User', session.username); proxyReq.removeHeader('Authorization');
      fixRequestBody(proxyReq, _req as Request);
    } } }));
  }
  app.use(express.static(config.dist));
  app.get('/{*splat}', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/preview/')) { res.status(404).json({ error: '接口不存在' }); return; }
    res.set('Cache-Control', 'no-store').sendFile(path.resolve(config.dist, 'index.html'));
  });
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { res.end(); return; }
    const status = error instanceof HttpError ? error.status : error instanceof z.ZodError ? 400 : error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE' ? 413 : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : (error as NodeJS.ErrnoException).code === 'EEXIST' ? 409 : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : '服务暂时不可用' });
  });
  server.on('upgrade', (req, socket, head) => {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const origin = req.headers.origin;
      if (origin && !allowed.has(origin) && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new Error('Origin');
      const ticketKey = url.searchParams.get('ticket') ?? '', ticket = tickets.get(ticketKey); tickets.delete(ticketKey);
      if (!ticket || ticket.expires < Date.now() || !sessions.has(ticket.session.token) || url.pathname !== `/ws/${ticket.channel}`) throw new Error('Ticket');
      wss.handleUpgrade(req, socket, head, client => {
        socketOwners.set(client, ticket.session.token);
        const upstream = new WebSocket(config.cloud.replace(/^http/, 'ws') + (ticket.channel === 'chat' ? '/ws' : '/shell'), { headers: { Authorization: `Bearer ${ticket.session.cloudToken}` }, maxPayload: 8 * 1024 * 1024 });
        const buffer: Buffer[] = [];
        client.on('message', data => {
          let interactionRequest: string | undefined;
          try {
            const message = JSON.parse(data.toString());
            if (message.type === 'chat.permission-response' && typeof message.requestId === 'string') interactionRequest = message.requestId;
            if (ticket.channel === 'chat') {
              if (message.type === 'chat.subscribe' && Array.isArray(message.sessions)) {
                const remote: unknown[] = [];
                for (const target of message.sessions) {
                  if (codex.has(target.sessionId)) codex.subscribe(target.sessionId, client, Number(target.lastSeq) || 0); else remote.push(target);
                }
                if (!remote.length) return; message.sessions = remote;
              } else if (message.type === 'chat.permission-response' && typeof message.requestId === 'string' && message.requestId.startsWith('codex:')) {
                const answers = message.answers === undefined ? undefined : z.record(z.string(), z.object({ answers: z.array(z.string().max(10000)).max(30) })).parse(message.answers);
                if (!codex.approve(message.requestId, message.allow === true, answers)) client.send(JSON.stringify({ kind: 'interaction_error', requestId: message.requestId, content: '该请求已处理或已失效，请刷新会话' }));
                return;
              } else if (message.type === 'chat.send') {
                void (async () => {
                  const body = z.object({ sessionId: z.string().regex(/^[a-zA-Z0-9_-]+$/), content: z.string().min(1).max(200000), options: z.object({ model: z.string().optional(), effort: z.string().optional(), attachments: z.array(z.unknown()).max(10).optional() }).default({}) }).parse(message);
                  const resolved = await attachments.resolve(body.options.attachments);
                  if (codex.has(body.sessionId)) { await codex.send(body.sessionId, body.content, body.options, resolved); return; }
                  const session = await cloud('/providers/sessions/' + body.sessionId, ticket.session.cloudToken);
                  if (session.data.provider !== 'claude') throw new HttpError(400, '该会话类型暂不支持，请在终端继续');
                  const models = cloudModels((await cloud('/providers/claude/models', ticket.session.cloudToken)).data);
                  const selected = validateModel(models, body.options.model, body.options.effort);
                  const images = await attachments.claudeImages(resolved);
                  notices.begin(body.sessionId); observer.begin(body.sessionId);
                  const prepared = { type: 'chat.send', sessionId: body.sessionId, content: withFileReferences(body.content, resolved), options: { permissionMode: 'default', model: body.options.model ?? selected?.id, effort: body.options.effort ?? 'default', attachments: images } };
                  if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(prepared)); else if (buffer.length < 30) buffer.push(Buffer.from(JSON.stringify(prepared)));
                })().catch(e => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ kind: 'protocol_error', sessionId: message.sessionId, content: String(e) })); });
                return;
              } else if (codex.has(message.sessionId)) {
                if (message.type === 'chat.abort') { void codex.abort(message.sessionId).catch(e => client.send(JSON.stringify({ kind: 'error', sessionId: message.sessionId, content: String(e) }))); return; }
              }
            }
            const encoded = JSON.stringify(message);
            if (upstream.readyState === WebSocket.OPEN) upstream.send(encoded); else if (buffer.length < 30) buffer.push(Buffer.from(encoded));
          } catch(e) { client.send(JSON.stringify({ kind: interactionRequest ? 'interaction_error' : 'protocol_error', requestId: interactionRequest, content: e instanceof Error ? e.message : '无效会话消息' })); }
        });
        upstream.on('open', () => { for (const data of buffer) upstream.send(data.toString()); });
        upstream.on('message', data => {
          if (ticket.channel === 'chat') { try { const event = decodeEvent(JSON.parse(data.toString())); if (event && !codex.has(event.sessionId ?? '')) { notices.ingest(event, 'claude'); usage.ingest(event); if (event.sessionId && event.kind !== 'chat_subscribed') observer.watch(event.sessionId); } } catch {} }
          if (client.readyState === WebSocket.OPEN) client.send(data.toString());
        });
        upstream.on('error', () => client.close(1011, 'CloudCLI 连接失败'));
        upstream.on('close', () => client.close());
        client.on('close', () => upstream.close());
        client.on('error', () => upstream.close());
      });
    } catch { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); }
  });
  setTimeout(() => { void jobs.pump(); observer.start(); }, 0).unref();
  return { app, server, jobs, files, codex, notices, usage, close: () => { observer.close(); codex.close(); jobs.stop(); wss.clients.forEach(c => c.close()); wss.close(); server.close(); } };
}
