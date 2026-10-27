import { z } from 'zod';
export const count = z.number().finite().nonnegative();
export const tokenSnapshotSchema = z.object({
  provider: z.enum(['claude', 'codex']), scope: z.enum(['context', 'thread']), source: z.string(), updatedAt: z.string(),
  inputTokens: count.optional(), outputTokens: count.optional(), cachedInputTokens: count.optional(), cacheWriteTokens: count.optional(), reasoningTokens: count.optional(), totalTokens: count.optional(), contextTokens: count.optional(), contextWindow: count.optional(),
});
export type TokenSnapshot = z.infer<typeof tokenSnapshotSchema>;
export type QuotaWindow = { id: string; name: string; usedPercent: number; durationMinutes?: number; resetsAt?: string };
export type AccountUsage = { provider: 'claude' | 'codex'; status: 'available' | 'partial' | 'unavailable'; updatedAt: string; source: string; reason?: string; windows: QuotaWindow[]; lifetimeTokens?: number; daily?: { date: string; tokens: number }[]; credits?: { balance?: string; unlimited: boolean; hasCredits: boolean } };
const optionalCount = count.nullish().transform(value => value ?? undefined);
const breakdown = z.object({ inputTokens: optionalCount, outputTokens: optionalCount, cachedInputTokens: optionalCount, cacheWriteInputTokens: optionalCount, reasoningOutputTokens: optionalCount, totalTokens: optionalCount });
export function codexTokens(value: unknown): TokenSnapshot {
  const usage = z.object({ total: breakdown, last: breakdown.optional(), modelContextWindow: optionalCount }).parse(value);
  return { provider: 'codex', scope: 'thread', source: 'Codex App Server thread/tokenUsage/updated', updatedAt: new Date().toISOString(), inputTokens: usage.total.inputTokens, outputTokens: usage.total.outputTokens, cachedInputTokens: usage.total.cachedInputTokens, cacheWriteTokens: usage.total.cacheWriteInputTokens, reasoningTokens: usage.total.reasoningOutputTokens, totalTokens: usage.total.totalTokens, contextWindow: usage.modelContextWindow };
}
export function claudeTokens(value: unknown): TokenSnapshot {
  const usage = z.object({ used: optionalCount, total: optionalCount, inputTokens: optionalCount, outputTokens: optionalCount, cacheReadTokens: optionalCount, cacheCreationTokens: optionalCount, unsupported: z.boolean().optional() }).parse(value);
  if (usage.unsupported || [usage.used, usage.inputTokens, usage.outputTokens].every(value => value === undefined)) throw new Error('当前会话尚未提供 Token 数据');
  return { provider: 'claude', scope: 'context', source: 'CloudCLI token_budget / token-usage', updatedAt: new Date().toISOString(), contextTokens: usage.used, contextWindow: usage.total, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheCreationTokens };
}
export function unavailableUsage(provider: AccountUsage['provider'], reason: string): AccountUsage { return { provider, status: 'unavailable', source: provider === 'codex' ? 'Codex App Server' : 'Claude OAuth usage', updatedAt: new Date().toISOString(), windows: [], reason }; }
const windowSchema = z.object({ usedPercent: z.number().finite(), windowDurationMins: optionalCount, resetsAt: optionalCount });
const snapshotSchema = z.object({ limitId: z.string().nullish(), limitName: z.string().nullish(), primary: windowSchema.nullish(), secondary: windowSchema.nullish(), credits: z.object({ hasCredits: z.boolean(), unlimited: z.boolean(), balance: z.string().nullish() }).nullish() });
export function codexAccount(limits: unknown, activity?: unknown): AccountUsage {
  const parsed = z.object({ rateLimits: snapshotSchema.optional(), rateLimitsByLimitId: z.record(z.string(), snapshotSchema).nullish() }).parse(limits);
  const buckets = parsed.rateLimitsByLimitId && Object.keys(parsed.rateLimitsByLimitId).length ? Object.entries(parsed.rateLimitsByLimitId) : parsed.rateLimits ? [[parsed.rateLimits.limitId ?? 'codex', parsed.rateLimits] as const] : [];
  const windows = buckets.flatMap(([id, bucket]) => (['primary', 'secondary'] as const).flatMap(name => {
    const value = bucket[name]; if (!value) return [];
    return [{ id: `${id}:${name}`, name: `${bucket.limitName ?? id} · ${name === 'primary' ? '主要窗口' : '次要窗口'}`, usedPercent: Math.max(0, Math.min(100, value.usedPercent)), durationMinutes: value.windowDurationMins, resetsAt: value.resetsAt === undefined ? undefined : new Date(value.resetsAt * 1000).toISOString() }];
  }));
  const metrics = z.object({ summary: z.object({ lifetimeTokens: optionalCount }), dailyUsageBuckets: z.array(z.object({ startDate: z.string(), tokens: count })).nullish() }).safeParse(activity);
  const credits = buckets.map(([, bucket]) => bucket.credits).find(Boolean);
  const activityReported = metrics.success && (metrics.data.summary.lifetimeTokens !== undefined || !!metrics.data.dailyUsageBuckets?.length);
  return { provider: 'codex', source: 'Codex App Server account/rateLimits/read + account/usage/read', status: windows.length ? 'available' : activityReported || credits ? 'partial' : 'unavailable', updatedAt: new Date().toISOString(), windows, ...(metrics.success ? { lifetimeTokens: metrics.data.summary.lifetimeTokens, daily: metrics.data.dailyUsageBuckets?.map(item => ({ date: item.startDate, tokens: item.tokens })) } : {}), ...(credits ? { credits: { ...credits, balance: credits.balance ?? undefined } } : {}) };
}
export function claudeAccount(value: unknown): AccountUsage {
  const row = z.object({ utilization: z.number().finite(), resets_at: z.string().nullish() });
  const usage = z.record(z.string(), z.unknown()).parse(value), windows: QuotaWindow[] = [];
  const names: Record<string, string> = { five_hour: '5 小时窗口', seven_day: '7 天窗口', seven_day_opus: 'Opus · 7 天', seven_day_sonnet: 'Sonnet · 7 天', seven_day_oauth_apps: 'OAuth 应用 · 7 天' };
  for (const [id, input] of Object.entries(usage)) { const parsed = row.safeParse(input); if (parsed.success) windows.push({ id, name: names[id] ?? id, usedPercent: Math.max(0, Math.min(100, parsed.data.utilization)), resetsAt: parsed.data.resets_at ?? undefined, durationMinutes: id === 'five_hour' ? 300 : id.startsWith('seven_day') ? 10080 : undefined }); }
  return { provider: 'claude', status: windows.length ? 'available' : 'unavailable', source: 'Claude OAuth usage', updatedAt: new Date().toISOString(), windows, reason: windows.length ? undefined : '当前登录方式未提供账号额度窗口' };
}

export type SessionUsage = { sessionId: string; provider: 'claude' | 'codex'; title: string; projectName: string; snapshot: TokenSnapshot | null };
export type SessionUsagePage = { items: SessionUsage[]; total: number; hasMore: boolean; warning?: string };
