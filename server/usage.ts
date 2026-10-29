import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { codexTokens, claudeTokens, claudeAccount, unavailableUsage, tokenSnapshotSchema, type TokenSnapshot, type AccountUsage } from '../shared/usage.ts';
import type { Conversation } from '../shared/protocol.ts';
import type { SessionUsage, TranscriptTotals } from '../shared/usage.ts';
import type { ChatEvent } from '../shared/protocol.ts';

export class UsageStore {
  private snapshots = new Map<string, TokenSnapshot>(); private filename: string;
  constructor(directory: string) {
    this.filename = path.join(directory, 'token-usage.json');
    if (fs.existsSync(this.filename)) for (const [id, snapshot] of Object.entries(JSON.parse(fs.readFileSync(this.filename, 'utf8')))) { const parsed = tokenSnapshotSchema.safeParse(snapshot); if (parsed.success) this.snapshots.set(id, parsed.data); }
  }
  get(id: string) { return this.snapshots.get(id) ?? null; }
  forSession(id: string, canonical: (id: string) => string) {
    let snapshot = this.get(id);
    for (const [alias, value] of this.snapshots) if (value.provider === 'codex' && canonical(alias) === id && (!snapshot || value.updatedAt > snapshot.updatedAt)) snapshot = value;
    return snapshot;
  }
  sessions(conversations: Conversation[], canonical: (id: string) => string): SessionUsage[] {
    const rows = new Map<string, SessionUsage>();
    for (const [id, snapshot] of this.snapshots) {
      const sessionId = snapshot.provider === 'codex' ? canonical(id) : id, key = snapshot.provider + ':' + sessionId;
      const previous = rows.get(key);
      if (!previous || snapshot.updatedAt > previous.snapshot!.updatedAt) rows.set(key, { sessionId, provider: snapshot.provider, title: '历史会话 · ' + sessionId.slice(0, 12), projectName: '已报告的会话', snapshot });
    }
    for (const item of conversations) {
      const key = item.provider + ':' + item.sessionId;
      rows.set(key, { sessionId: item.sessionId, provider: item.provider, title: item.sessionTitle, projectName: item.projectDisplayName, snapshot: rows.get(key)?.snapshot ?? null });
    }
    return [...rows.values()].sort((a, b) => (b.snapshot?.updatedAt ?? '').localeCompare(a.snapshot?.updatedAt ?? ''));
  }
  set(id: string, value: TokenSnapshot) {
    // 新回合开始时 Claude 会先报一次全 0，不能覆盖上一次真实的上下文数据。
    const previous = this.snapshots.get(id);
    if (value.provider === 'claude' && !value.contextTokens && !value.inputTokens && !value.outputTokens && previous?.contextTokens) return;
    this.snapshots.delete(id); this.snapshots.set(id, value);
    if (this.snapshots.size > 1000) this.snapshots.delete(this.snapshots.keys().next().value!);
    fs.writeFileSync(this.filename + '.tmp', JSON.stringify(Object.fromEntries(this.snapshots)), { mode: 0o600 }); fs.renameSync(this.filename + '.tmp', this.filename);
  }
  ingest(event: ChatEvent) {
    if (!event.sessionId) return;
    try {
      if (event.kind === 'token_usage' && event.provider === 'codex') this.set(event.sessionId, codexTokens(event.tokenUsage));
      else if (event.kind === 'status' && event.tokenBudget) this.set(event.sessionId, claudeTokens(event.tokenBudget));
    } catch { /* Unknown SDK usage is unavailable, never inferred from output text. */ }
  }
}
export class ClaudeQuota {
  private cache?: AccountUsage; private expires = 0; private loading?: Promise<AccountUsage>;
  constructor(private file = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), '.credentials.json'), private fetcher: typeof fetch = fetch) {}
  async read(): Promise<AccountUsage> {
    if (this.cache && Date.now() < this.expires) return this.cache;
    if (this.loading) return this.loading;
    this.loading = this.load();
    try { this.cache = await this.loading; this.expires = Date.now() + 60000; return this.cache; } finally { this.loading = undefined; }
  }
  private async load(): Promise<AccountUsage> {
    try {
      const credentials = JSON.parse(await fs.promises.readFile(this.file, 'utf8'));
      const token = credentials.claudeAiOauth?.accessToken;
      if (typeof token !== 'string' || !token) return unavailableUsage('claude', '当前登录未提供 Claude OAuth 额度；请在服务器完成账号登录');
      const response = await this.fetcher('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (!response.ok) return unavailableUsage('claude', response.status === 401 || response.status === 403 ? '账号额度读取未获授权，请检查服务器登录状态' : '额度服务暂不可用，请稍后刷新');
      return claudeAccount(await response.json());
    } catch { return unavailableUsage('claude', '暂未取得 Claude 账号额度；本机密钥模式或未登录时可能不提供'); }
  }
}

// Claude 只汇报最近一次调用的上下文；累计值直接读会话记录（每个 message.id 只取最后一条，流式分片不会重复计数）。
const transcriptCache = new Map<string, { key: string; totals: TranscriptTotals }>();
export async function claudeTranscriptTotals(sessionId: string, root = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')): Promise<TranscriptTotals | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
  let file = '';
  try { for (const dir of await fs.promises.readdir(root)) { const candidate = path.join(root, dir, sessionId + '.jsonl'); if (fs.existsSync(candidate)) { file = candidate; break; } } } catch { return null; }
  if (!file) return null;
  const stat = await fs.promises.stat(file), key = stat.mtimeMs + ':' + stat.size, cached = transcriptCache.get(file);
  if (cached?.key === key) return cached.totals;
  const calls = new Map<string, [number, number, number, number]>();
  const lines = (await fs.promises.readFile(file, 'utf8')).split('\n');
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;
    try {
      const entry = JSON.parse(line), message = entry.message, usage = message?.usage;
      if (entry.type !== 'assistant' || !usage) continue;
      const n = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
      calls.set(String(message.id ?? entry.uuid), [n(usage.input_tokens), n(usage.output_tokens), n(usage.cache_read_input_tokens), n(usage.cache_creation_input_tokens)]);
    } catch { /* 跳过写到一半的行 */ }
  }
  const totals: TranscriptTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: calls.size, updatedAt: new Date(stat.mtimeMs).toISOString() };
  for (const [input, output, read, write] of calls.values()) { totals.inputTokens += input; totals.outputTokens += output; totals.cacheReadTokens += read; totals.cacheWriteTokens += write; }
  transcriptCache.set(file, { key, totals }); if (transcriptCache.size > 50) transcriptCache.delete(transcriptCache.keys().next().value!);
  return totals;
}
