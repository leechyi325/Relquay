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
import { conversationCreateSchema, fileModuleSchema, locationSchema, type Conversation } from '../shared/protocol.ts';
import { FileModules } from './modules.ts';
import { Attachments, withFileReferences } from './attachments.ts';
import { cloudModels, validateModel } from './models.ts';
import { Files, HttpError, streamFile } from './files.ts';
import { Extensions } from './extensions.ts';
import { providerSchema, extensionName, mcpWriteSchema, skillWriteSchema, pluginIdSchema } from '../shared/extensions.ts';
import { AgentConfigs } from './agent-config.ts';
import { Jobs } from './jobs.ts';
import { CodexBridge } from './codex.ts';
import { appVersion } from '../shared/config.ts';
import { UsageStore, ClaudeQuota } from './usage.ts';
import { NotificationStore } from './notifications.ts';
import { CloudObserver } from './cloud-observer.ts';
import { claudeTokens } from '../shared/usage.ts';
import { decodeEvent } from '../shared/protocol.ts';
import { TerminalNegotiation } from './terminal.ts';
import { cloudConversation, conversationId, conversationRename } from './conversations.ts';

const exec = promisify(execFile);
type Config = { base: string; state: string; cloud: string; dist: string; origin: string; filebrowser?: string; envFile?: string; allowedDirectories?: string[]; cloudAssets?: string; clientOrigins?: string[]; codexCommand?: string; codexArgs?: string[]; claudeQuota?: ClaudeQuota; agentConfigs?: AgentConfigs; extensions?: Extensions };
type LoginSession = { token: string; cloudToken: string; username: string; expires: number };
const readBearer = (req: Request) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
const readCookie = (req: Request) => /(?:^|;\s*)studio=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
export function createStudio(config: Config) {
  mkdirSync(config.state, { recursive: true, mode: 0o700 });
  const agentConfigs = config.agentConfigs ?? new AgentConfigs();
  const notices = new NotificationStore(config.state), usage = new UsageStore(config.state), claudeQuota = config.claudeQuota ?? new ClaudeQuota();
  const modules = new FileModules(config.base, config.state, config.allowedDirectories);
  const extensions = config.extensions ?? new Extensions(config.state, agentConfigs, input => modules.directory(input));
  const files = new Files(config.base, id => modules.root(id)), jobs = new Jobs(path.join(config.state, 'jobs'), files, config.envFile, job => notices.job(job));
  const codex = new CodexBridge(path.join(config.state, 'codex'), config.codexCommand ?? 'codex', config.codexArgs ?? ['app-server', '--listen', 'stdio://'], event => { notices.ingest(event, 'codex'); usage.ingest(event); });
  const attachments = new Attachments(path.join(config.state, 'attachments'), files, config.cloudAssets ?? path.join(os.homedir(), '.cloudcli/assets'));
  const app = express(); app.disable('x-powered-by'); app.set('trust proxy', 'loopback');
  const server = createServer(app), wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  // 刚创建、尚未发送过消息的会话在 CloudCLI/Codex 里没有原生记录，不在最近列表展示，避免出现服务器上找不到的空会话。
  const draftsFile = path.join(config.state, 'draft-sessions.json');
  const drafts = new Set<string>((() => { try { return z.array(z.string()).parse(JSON.parse(readFileSync(draftsFile, 'utf8'))); } catch { return []; } })());
  const saveDrafts = () => { writeFileSync(draftsFile + '.tmp', JSON.stringify([...drafts]), { mode: 0o600 }); renameSync(draftsFile + '.tmp', draftsFile); };
  const markUsed = (id: string) => { if (drafts.delete(id)) saveDrafts(); };
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
  const conversation = async (value: string, token: string) => {
    const id = codex.resolveId(conversationId.parse(value)), owned = codex.info(id);
    if (owned && codex.sessions.get(id)?.title) return owned;
    try {
      const result = cloudConversation((await cloud('/providers/sessions/' + encodeURIComponent(id), token)).data);
      if (owned) codex.setInfo(id, result.sessionTitle, result.projectDisplayName);
      return owned ? { ...result, projectPath: owned.projectPath } : result;
    } catch (error) {
      if (owned) return owned;
      if (error instanceof HttpError && [401, 403].includes(error.status)) throw new HttpError(error.status, '会话访问授权已失效，请重新登录工作台');
      if (error instanceof HttpError && [404, 410].includes(error.status)) throw new HttpError(410, '对应会话已删除或归档，请从工作台选择其他会话');
      throw new HttpError(502, '暂时无法打开会话，请稍后重试');
    }
  };
  function recentConversations(items: Conversation[]) {
    const canonical = new Map<string, Conversation>();
    for (const item of items) {
      if (drafts.has(item.sessionId)) continue;
      if (codex.has(item.sessionId) && !codex.sessions.get(item.sessionId)?.title && item.sessionTitle) codex.setInfo(item.sessionId, item.sessionTitle, item.projectDisplayName);
      const owned = item.provider === 'codex' ? codex.info(item.sessionId) : undefined;
      const row = owned ? { ...item, ...owned, lastActivity: owned.lastActivity ?? item.lastActivity } : item;
      canonical.set(row.provider + ':' + row.sessionId, row);
    }
    // CloudCLI can independently discover the native thread behind an app session.
    // Identity, never display name or directory, determines whether rows are aliases.
    for (const session of codex.sessions.values()) {
      const key = 'codex:' + session.id;
      if (!canonical.has(key) && !drafts.has(session.id)) canonical.set(key, codex.info(session.id)!);
    }
    return [...canonical.values()].sort((a, b) => (Date.parse(b.lastActivity ?? '') || 0) - (Date.parse(a.lastActivity ?? '') || 0));
  }
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
  app.get('/api/usage/sessions', asyncRoute(async (req, res) => {
    const query = z.object({ provider: z.enum(['claude', 'codex']).optional(), search: z.string().max(200).default(''), offset: z.coerce.number().int().min(0).max(10000).default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    let known: Conversation[] = [], warning: string | undefined;
    try { known = (await cloud('/providers/sessions/recent?limit=100', res.locals.session.cloudToken)).data.conversations; }
    catch { warning = '暂未同步会话名称，已保留本服务器报告的统计'; }
    const search = query.search.trim().toLocaleLowerCase();
    const rows = usage.sessions(recentConversations(known), id => codex.resolveId(id)).filter(row => (!query.provider || row.provider === query.provider) && (!search || [row.title, row.projectName, row.sessionId].some(value => value.toLocaleLowerCase().includes(search))));
    res.set('Cache-Control', 'no-store'); res.json({ items: rows.slice(query.offset, query.offset + query.limit), total: rows.length, hasMore: rows.length > query.offset + query.limit, warning });
  }));
  app.get('/api/usage/sessions/:id', asyncRoute(async (req, res) => {
    const id = codex.resolveId(conversationId.parse(req.params.id));
    const cached = usage.forSession(id, value => codex.resolveId(value));
    if (cached?.provider === 'claude') {
      try { usage.set(id, claudeTokens((await cloud('/providers/sessions/' + id + '/token-usage', res.locals.session.cloudToken)).data)); } catch { /* Retain the last reported snapshot if the session is unavailable. */ }
    } else if (!codex.has(id) && !cached) {
      const session = await cloud('/providers/sessions/' + id, res.locals.session.cloudToken);
      if (session.data.provider === 'claude') {
        try { usage.set(id, claudeTokens((await cloud('/providers/sessions/' + id + '/token-usage', res.locals.session.cloudToken)).data)); } catch { /* Keep the last actually reported snapshot. */ }
      }
    }
    res.set('Cache-Control', 'no-store');
    const snapshot = usage.forSession(id, value => codex.resolveId(value));
    res.json({ snapshot, reason: snapshot ? undefined : '首轮返回用量后显示；尚未报告的数据不会估算' });
  }));
  app.get('/api/notifications', (req, res, next) => { try { observer.start(); const after = z.coerce.number().int().nonnegative().optional().parse(req.query.after); res.json(notices.page(after)); } catch(e) { next(e); } });
  app.get('/api/notifications/:id', (req, res, next) => { try { res.json(notices.get(String(req.params.id))); } catch(e) { next(e); } });
  app.post('/api/notifications/read-all', (_req, res) => { notices.read(); res.json({ ok: true }); });
  app.post('/api/notifications/:id/read', (req, res, next) => { try { notices.read(String(req.params.id)); res.json({ ok: true }); } catch(e) { next(e); } });
  app.get('/api/agents/:provider/skills', asyncRoute(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await extensions.skills(providerSchema.parse(req.params.provider))); }));
  app.post('/api/agents/:provider/skills', asyncRoute(async (req, res) => { const provider = providerSchema.parse(req.params.provider), body = skillWriteSchema.parse(req.body); res.json(await extensions.exclusive(provider, () => extensions.saveSkill(provider, body.name, body.content))); }));
  app.put('/api/agents/:provider/skills/:id', asyncRoute(async (req, res) => { const provider = providerSchema.parse(req.params.provider), body = skillWriteSchema.parse(req.body); res.json(await extensions.exclusive(provider, () => extensions.saveSkill(provider, body.name, body.content, String(req.params.id), body.revision))); }));
  app.post('/api/agents/:provider/skills/import', asyncRoute(async (req, res) => { const provider = providerSchema.parse(req.params.provider), body = z.object({ name: extensionName, path: z.string().min(1).max(2000) }).parse(req.body); res.json(await extensions.exclusive(provider, () => extensions.importSkill(provider, body.name, body.path))); }));
  app.delete('/api/agents/:provider/skills/:id', asyncRoute(async (req, res) => { const provider = providerSchema.parse(req.params.provider), body = z.object({ revision: z.string() }).parse(req.body); await extensions.exclusive(provider, () => extensions.removeSkill(provider, String(req.params.id), body.revision)); res.json({ ok: true }); }));
  app.get('/api/agents/:provider/mcp', asyncRoute(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await extensions.mcps(providerSchema.parse(req.params.provider))); }));
  app.get('/api/agents/:provider/mcp/:name', asyncRoute(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await extensions.mcps(providerSchema.parse(req.params.provider), extensionName.parse(req.params.name))); }));
  app.put('/api/agents/:provider/mcp', asyncRoute(async (req, res) => { const provider = providerSchema.parse(req.params.provider), body = mcpWriteSchema.parse(req.body); res.json(await extensions.exclusive(provider, () => extensions.saveMcp(provider, body.name, body.config, body.enabled, body.revision, false, body.create))); }));
  app.delete('/api/agents/:provider/mcp/:name', asyncRoute(async (req, res) => { const provider = providerSchema.parse(req.params.provider), body = z.object({ revision: z.string() }).parse(req.body); res.json(await extensions.exclusive(provider, () => extensions.saveMcp(provider, extensionName.parse(req.params.name), {}, false, body.revision, true))); }));
  app.get('/api/agents/:provider/plugins', asyncRoute(async (req, res) => { res.set('Cache-Control', 'no-store'); res.json(await extensions.plugins(providerSchema.parse(req.params.provider))); }));
  app.post('/api/agents/:provider/plugins', asyncRoute(async (req, res) => { const provider = providerSchema.parse(req.params.provider), body = z.object({ id: pluginIdSchema, action: z.enum(['install', 'enable', 'disable', 'remove']) }).parse(req.body); await extensions.exclusive(provider, () => extensions.pluginAction(provider, body.id, body.action)); res.json({ ok: true }); }));
  app.get('/api/agents/:provider/config', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await agentConfigs.read(z.enum(['claude', 'codex']).parse(req.params.provider)));
  }));
  app.put('/api/agents/:provider/config', asyncRoute(async (req, res) => {
    const body = z.object({ content: z.string().max(512 * 1024), revision: z.string().length(64) }).parse(req.body);
    res.set('Cache-Control', 'no-store');
    const provider = providerSchema.parse(req.params.provider);
    res.json(await extensions.exclusive(provider, () => agentConfigs.write(provider, body.content, body.revision)));
  }));
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
    if (body.provider === 'codex') codex.register(sessionId, projectPath, { title, projectDisplayName: body.projectName });
    drafts.add(sessionId); saveDrafts();
    res.status(201).json({ sessionId, provider: body.provider, projectDisplayName: body.projectName, projectPath, sessionTitle: title, lastActivity: new Date().toISOString() });
  }));
  app.get('/api/conversations/:id', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store'); res.json(await conversation(String(req.params.id), res.locals.session.cloudToken));
  }));
  app.put('/api/conversations/:id', asyncRoute(async (req, res) => {
    const body = conversationRename.parse(req.body), token = res.locals.session.cloudToken;
    const current = await conversation(String(req.params.id), token);
    if (codex.has(current.sessionId)) {
      // Owned Codex metadata remains usable when CloudCLI's catalog row is gone.
      await cloud(`/providers/sessions/${current.sessionId}`, token, { method: 'PUT', body: JSON.stringify({ summary: body.title }) }).catch(() => {});
      codex.setInfo(current.sessionId, body.title, current.projectDisplayName);
    } else await cloud(`/providers/sessions/${current.sessionId}`, token, { method: 'PUT', body: JSON.stringify({ summary: body.title }) });
    res.set('Cache-Control', 'no-store'); res.json({ ...current, sessionTitle: body.title });
  }));
  app.delete('/api/conversations/:id', asyncRoute(async (req, res) => {
    const id = codex.resolveId(conversationId.parse(req.params.id)), token = res.locals.session.cloudToken;
    const nativeId = codex.sessions.get(id)?.threadId;
    if (codex.sessions.get(id)?.processing) throw new HttpError(409, '会话正在运行，请先停止后再删除');
    const running = await cloud('/providers/sessions/running', token);
    if (z.array(z.object({ sessionId: z.string() })).parse(running.data.sessions).some(value => value.sessionId === id || value.sessionId === nativeId)) throw new HttpError(409, '会话正在运行，请先停止后再删除');
    if (codex.has(id)) await codex.archive(id);
    try { await cloud(`/providers/sessions/${id}?force=true&deletedFromDisk=true`, token, { method: 'DELETE' }); }
    catch(error) { if (!codex.has(id) || !(error instanceof HttpError) || error.status !== 404) throw error; }
    if (nativeId && nativeId !== id) {
      try { await cloud(`/providers/sessions/${nativeId}?force=true&deletedFromDisk=true`, token, { method: 'DELETE' }); }
      catch(error) { if (!(error instanceof HttpError) || error.status !== 404) throw error; }
    }
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
    if (req.method === 'GET' && history && codex.has(history[1])) {
      const limit = z.coerce.number().int().min(1).max(500).default(100).parse(req.query.limit);
      const offset = z.coerce.number().int().min(0).max(1000000).default(0).parse(req.query.offset);
      res.json({ success: true, data: codex.history(history[1], limit, offset) }); return;
    }
    const data = await cloud(req.url, res.locals.session.cloudToken, { method: req.method, ...(req.method === 'GET' ? {} : { body: JSON.stringify(req.body) }) });
    if (req.method === 'GET' && req.path === '/providers/sessions/recent' && Array.isArray(data.data?.conversations)) {
      data.data.conversations = recentConversations(data.data.conversations);
    }
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
  app.put('/api/jobs/:id', (req, res, next) => { try { const body = z.object({ title: z.string().trim().min(1).max(200), command: z.string().trim().min(1).max(20000).optional() }).parse(req.body); res.json(jobs.update(String(req.params.id), body.title, body.command)); } catch(e) { next(e); } });
  app.delete('/api/jobs/:id', (req, res, next) => { try { jobs.remove(String(req.params.id)); res.json({ ok: true }); } catch(e) { next(e); } });
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
        const terminal = new TerminalNegotiation(data => { if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: 'input', data })); });
        client.on('message', data => {
          let interactionRequest: string | undefined;
          try {
            const message = JSON.parse(data.toString());
            if (ticket.channel === 'terminal') {
              // Enforce fresh tmux attachments for pre-0.4.1 phone clients too.
              if (message.type === 'init' && message.isPlainShell === true) message.forceRestart = true;
              if (message.type === 'input' && typeof message.data === 'string') {
                message.data = terminal.clientInput(message.data);
                if (!message.data) return;
              }
            }
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
                if (!codex.approve(message.requestId, message.allow === true, answers, message.remember === true)) client.send(JSON.stringify({ kind: 'interaction_error', requestId: message.requestId, content: '该请求已处理或已失效，请刷新会话' }));
                return;
              } else if (message.type === 'chat.send') {
                void (async () => {
                  const body = z.object({ sessionId: z.string().regex(/^[a-zA-Z0-9_-]+$/), content: z.string().min(1).max(200000), options: z.object({ model: z.string().optional(), effort: z.string().optional(), attachments: z.array(z.unknown()).max(10).optional() }).default({}) }).parse(message);
                  markUsed(body.sessionId);
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
          if (ticket.channel === 'terminal') {
            try {
              const message = JSON.parse(data.toString());
              if (message.type === 'output' && typeof message.data === 'string') {
                message.data = terminal.serverOutput(message.data);
                if (message.data && client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
                return;
              }
            } catch {}
          }
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
  return { app, server, jobs, files, codex, notices, usage, drafts, markUsed, close: () => { observer.close(); codex.close(); jobs.stop(); wss.clients.forEach(c => c.close()); wss.close(); server.close(); } };
}
