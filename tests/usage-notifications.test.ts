import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { fixture, until } from './helpers.ts';
import { claudeAccount, claudeTokens, codexAccount, codexTokens } from '../shared/usage.ts';
import { ClaudeQuota, UsageStore } from '../server/usage.ts';
import { NotificationStore } from '../server/notifications.ts';
import { emptyChat, reduceChat } from '../shared/protocol.ts';
import type { NoticePage } from '../shared/notifications.ts';

test('quota normalization prefers multiple limit buckets, preserves unknown and real zero, keeps token subsets', () => {
  const account = codexAccount({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1893456000 } }, review: { primary: { usedPercent: 100 } } } }, { summary: { lifetimeTokens: null }, dailyUsageBuckets: null });
  assert.equal(account.windows.length, 2); assert.equal(account.windows[0].usedPercent, 25); assert.equal(account.windows[0].resetsAt, '2030-01-01T00:00:00.000Z'); assert.equal(account.lifetimeTokens, undefined);
  assert.equal(codexAccount({}).status, 'unavailable'); assert.equal(codexAccount({}, { summary: { lifetimeTokens: null }, dailyUsageBuckets: null }).status, 'unavailable');
  const tokens = codexTokens({ total: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 10, totalTokens: 120 } });
  assert.equal(tokens.totalTokens, 120); assert.equal(tokens.cachedInputTokens, 50); assert.equal(tokens.reasoningTokens, 10); assert.equal(tokens.cacheWriteTokens, undefined);
  const claude = claudeTokens({ used: 0, total: 200000, outputTokens: 0 }); assert.equal(claude.contextTokens, 0); assert.equal(claude.totalTokens, undefined); assert.equal(claude.scope, 'context'); assert.throws(() => claudeTokens({ unsupported: true }));
  const quota = claudeAccount({ five_hour: { utilization: 8, resets_at: null }, seven_day: null, extra_usage: { enabled: true } }); assert.equal(quota.windows.length, 1); assert.equal(quota.windows[0].usedPercent, 8);
  assert.equal(reduceChat(emptyChat, { kind: 'token_usage' }).processing, false); assert.equal(reduceChat(emptyChat, { kind: 'status', tokenBudget: { used: 100 } }).processing, false);
});

test('Claude OAuth quota stays on the fixed TLS endpoint, caches requests and never returns credentials', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roamdeck-quota-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fixture-auth.json'), secret = 'fixture-only-secret'; await fs.writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: secret } })); let requests = 0;
  const quota = new ClaudeQuota(file, (async (url, options) => { requests++; assert.equal(url, 'https://api.anthropic.com/api/oauth/usage'); assert.equal(options?.redirect, 'error'); assert.equal((options!.headers as Record<string, string>).Authorization, 'Bearer ' + secret); return new Response(JSON.stringify({ five_hour: { utilization: 0 } })); }) as typeof fetch);
  const values = await Promise.all([quota.read(), quota.read()]); assert.equal(requests, 1); assert.equal(values[0].windows[0].usedPercent, 0); assert.ok(!JSON.stringify(values).includes(secret));
  assert.equal((await new ClaudeQuota(path.join(dir, 'missing')).read()).status, 'unavailable');
  const failed = await new ClaudeQuota(file, (async () => new Response(secret, { status: 401 })) as typeof fetch).read(); assert.equal(failed.status, 'unavailable'); assert.ok(!JSON.stringify(failed).includes(secret));
});

test('notification persistence deduplicates requests and completed runs, marks resolved/read, recovers cursors', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roamdeck-notice-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); const store = new NotificationStore(dir);
  const request = { kind: 'permission_request', sessionId: 'one', requestId: 'r1', toolName: 'Bash', input: { command: 'SECRET COMMAND' } };
  store.begin('one'); store.ingest(request, 'claude'); store.ingest(request, 'claude'); store.ingest({ kind: 'complete', sessionId: 'one', seq: 2 }, 'claude'); store.ingest({ kind: 'complete', sessionId: 'one', seq: 2 }, 'claude');
  assert.equal(store.page().items.length, 2); assert.equal(store.page().unread, 1); assert.ok(store.page().items.find(item => item.type === 'approval')?.resolvedAt); assert.ok(!JSON.stringify(store.page()).includes('SECRET'));
  const restored = new NotificationStore(dir); restored.ingest(request, 'claude'); assert.equal(restored.page().items.length, 2); restored.begin('one'); restored.ingest({ kind: 'complete', sessionId: 'one', seq: 1 }, 'claude'); assert.equal(restored.page().items.length, 3);
  assert.equal(restored.page(0).items[0].seq, 1); assert.equal(restored.page(999).gap, true); restored.read(); assert.equal(restored.page().unread, 0);
  const usage = new UsageStore(dir); usage.ingest({ kind: 'token_usage', provider: 'codex', sessionId: 'one', tokenUsage: { total: { totalTokens: 120 } } }); assert.equal(new UsageStore(dir).get('one')?.totalTokens, 120); assert.equal(new UsageStore(dir).get('unknown'), null);
});

test('protected account/session usage, Codex approvals and job completion reach the persistent inbox', async t => {
  const f = await fixture(); t.after(f.close);
  assert.equal((await fetch(f.base + '/api/usage/accounts')).status, 401); assert.equal((await fetch(f.base + '/api/notifications')).status, 401);
  const account = await (await f.call('/api/usage/accounts')).json(); assert.equal(account.accounts.find((value: { provider: string }) => value.provider === 'codex').windows[0].usedPercent, 24); assert.equal(account.accounts.find((value: { provider: string }) => value.provider === 'claude').status, 'unavailable');
  const result = await (await f.call('/api/conversations', { method: 'POST', body: JSON.stringify({ provider: 'codex', projectName: 'fixture', cwd: { root: 'project', path: '' } }) })).json(); const sid = result.sessionId;
  assert.equal((await (await f.call('/api/usage/sessions/' + sid)).json()).snapshot, null);
  await f.studio.codex.send(sid, 'test approval'); await until(() => f.studio.codex.approvals.size === 1);
  const snapshot = await (await f.call('/api/usage/sessions/' + sid)).json(); assert.equal(snapshot.snapshot.totalTokens, 1250);
  const pending = (await (await f.call('/api/notifications')).json() as NoticePage).items.find(item => item.type === 'approval')!; assert.equal(pending.sessionId, sid);
  assert.equal((await f.call('/api/notifications?after=-1')).status, 400);
  await f.call('/api/notifications/' + pending.id + '/read', { method: 'POST', body: '{}' }); assert.ok((await (await f.call('/api/notifications/' + pending.id)).json()).readAt); assert.equal(f.studio.codex.approvals.size, 1, 'Reading never approves');
  f.studio.codex.approve(pending.requestId!, false); await until(() => !f.studio.codex.sessions.get(sid)!.processing);
  assert.ok((await (await f.call('/api/notifications/' + pending.id)).json()).resolvedAt);
  const job = await (await f.call('/api/jobs', { method: 'POST', body: JSON.stringify({ title: 'notification fixture', command: 'echo fixture-only', cwd: { root: 'project', path: '' } }) })).json();
  await until(() => f.studio.notices.page().items.some(item => item.jobId === job.id));
  await f.call('/api/notifications/read-all', { method: 'POST', body: '{}' }); assert.equal(f.studio.notices.page().unread, 0);
});

test('Claude server observer receives approval and completion after the client disconnects, across run seq resets', async t => {
  const f = await fixture(); t.after(f.close);
  const session = await (await f.call('/api/conversations', { method: 'POST', body: JSON.stringify({ provider: 'claude', projectName: 'fixture', cwd: { root: 'project', path: '' } }) })).json(); const id = session.sessionId;
  const ticket = await (await f.call('/api/socket-ticket', { method: 'POST', body: '{"channel":"chat"}' })).json(); const ws = new WebSocket(f.base.replace('http', 'ws') + '/ws/chat?ticket=' + ticket.ticket); await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'chat.send', sessionId: id, content: 'WAIT_OBSERVER', options: {} }));
  await until(() => f.sentMessages.some(message => message.type === 'chat.send'));
  await until(() => f.sentMessages.filter(message => message.type === 'chat.subscribe').length >= 1);
  ws.close(); await once(ws, 'close');
  f.publish(id, { kind: 'permission_request', requestId: 'after-disconnect', toolName: 'Bash', input: { command: 'fixture-only' } }); await until(() => f.studio.notices.page().items.some(item => item.requestId === 'after-disconnect'));
  f.publish(id, { kind: 'status', tokenBudget: { used: 100, total: 200000, inputTokens: 90, outputTokens: 10 } }); f.publish(id, { kind: 'complete' }); await until(() => f.studio.notices.page().items.some(item => item.type === 'agent-complete'));
  assert.equal(f.studio.usage.get(id)?.contextTokens, 100);
  f.studio.notices.begin(id); f.running.add(id); f.publish(id, { kind: 'permission_request', requestId: 'next-turn', toolName: 'AskUserQuestion' }, true);
  await until(() => f.studio.notices.page().items.some(item => item.requestId === 'next-turn')); f.publish(id, { kind: 'complete' }); await until(() => f.studio.notices.page().items.filter(item => item.type === 'agent-complete').length === 2);
});
