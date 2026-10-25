import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { codexTokens, claudeTokens, claudeAccount, unavailableUsage, tokenSnapshotSchema, type TokenSnapshot, type AccountUsage } from '../shared/usage.ts';
import type { ChatEvent } from '../shared/protocol.ts';

export class UsageStore {
  private snapshots = new Map<string, TokenSnapshot>(); private filename: string;
  constructor(directory: string) {
    this.filename = path.join(directory, 'token-usage.json');
    if (fs.existsSync(this.filename)) for (const [id, snapshot] of Object.entries(JSON.parse(fs.readFileSync(this.filename, 'utf8')))) { const parsed = tokenSnapshotSchema.safeParse(snapshot); if (parsed.success) this.snapshots.set(id, parsed.data); }
  }
  get(id: string) { return this.snapshots.get(id) ?? null; }
  set(id: string, value: TokenSnapshot) {
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
