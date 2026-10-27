import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'smol-toml';
import { readConfigFields, applyConfigFields } from '../shared/config-fields.ts';
import { fixture, until } from './helpers.ts';
import { UsageStore } from '../server/usage.ts';
import { codexTokens, claudeTokens } from '../shared/usage.ts';

test('guided fields preserve unrelated Codex configuration and support inline/env credentials without auth-file writes', () => {
  const source = '# keep when untouched\nmodel = "old"\n[projects."/tmp/中文"]\ntrust_level = "trusted"\n[mcp_servers.test]\ncommand = "example"\n[plugins."a@b"]\nenabled = true\n';
  const original = readConfigFields('codex', source);
  assert.equal(applyConfigFields('codex', source, original), source);
  const fields = { ...original, connection: 'custom' as const, baseUrl: 'https://api.example.com/v1', model: 'my-模型', effort: 'high', providerId: 'my_provider', secret: 'fixture-"quoted"-key' };
  const content = applyConfigFields('codex', source, fields), parsed = parse(content);
  assert.equal(parsed.model, 'my-模型'); assert.equal(parsed.model_provider, 'my_provider');
  assert.deepEqual(parsed.mcp_servers, parse(source).mcp_servers); assert.deepEqual(parsed.projects, parse(source).projects); assert.deepEqual(parsed.plugins, parse(source).plugins);
  const entry = (parsed.model_providers as Record<string, Record<string, unknown>>).my_provider;
  assert.equal(entry.experimental_bearer_token, fields.secret); assert.equal(entry.requires_openai_auth, false); assert.equal(entry.wire_api, 'responses');
  const env = parse(applyConfigFields('codex', content, { ...readConfigFields('codex', content), connection: 'custom', credential: 'env', envKey: 'PROVIDER_API_KEY' }));
  const config = (env.model_providers as Record<string, Record<string, unknown>>).my_provider;
  assert.equal(config.env_key, 'PROVIDER_API_KEY'); assert.equal(config.experimental_bearer_token, undefined);
  const official = parse(applyConfigFields('codex', content, { ...readConfigFields('codex', content), connection: 'official' }));
  assert.equal(official.model_provider, 'openai'); assert.deepEqual(official.model_providers, parsed.model_providers);
});

test('guided Claude fields synchronize model/effort overrides and preserve permissions/hooks/plugins', () => {
  const original = { model: 'old', env: { ANTHROPIC_MODEL: 'override', CLAUDE_CODE_EFFORT_LEVEL: 'low', ANTHROPIC_AUTH_TOKEN: 'old-token', OTHER: 'keep' }, permissions: { deny: ['Read(.env)'] }, hooks: { Stop: [] }, enabledPlugins: { 'a@b': true } };
  const source = JSON.stringify(original), fields = readConfigFields('claude', source);
  assert.equal(fields.model, 'override');
  const output = JSON.parse(applyConfigFields('claude', source, { ...fields, connection: 'custom', model: 'new', effort: 'high', baseUrl: 'https://api.example.com', claudeAuth: 'key', secret: 'test-only' }));
  assert.equal(output.env.ANTHROPIC_API_KEY, 'test-only'); assert.equal(output.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(output.env.ANTHROPIC_MODEL, 'new'); assert.equal(output.model, 'new'); assert.equal(output.effortLevel, 'high'); assert.equal(output.env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
  assert.equal(output.env.OTHER, 'keep'); for (const key of ['permissions', 'hooks', 'enabledPlugins']) assert.deepEqual(output[key], original[key as keyof typeof original]);
  const official = JSON.parse(applyConfigFields('claude', JSON.stringify(output), { ...readConfigFields('claude', JSON.stringify(output)), connection: 'official' }));
  assert.equal(official.env.ANTHROPIC_API_KEY, undefined); assert.equal(official.env.ANTHROPIC_BASE_URL, undefined); assert.equal(official.env.OTHER, 'keep');
});

test('guided validation rejects unsafe/invalid fields and leaves advanced auth and syntax to source editing', () => {
  const base = { ...readConfigFields('codex', ''), connection: 'custom' as const, baseUrl: 'https://api.example.com/v1', model: 'test', secret: 'secret-must-not-leak' };
  for (const patch of [{ baseUrl: 'javascript:alert(1)' }, { baseUrl: 'https://secret@host.example/v1' }, { providerId: 'openai' }, { providerId: '../bad' }, { secret: '' }, { secret: 'bad\nkey' }, { credential: 'env' as const, envKey: 'X;echo' }, { model: '' }]) assert.throws(() => applyConfigFields('codex', '', { ...base, ...patch }), error => error instanceof Error && !error.message.includes(base.secret));
  const source = '[model_providers.roamdeck_custom.auth]\ncommand="helper"\n';
  assert.throws(() => applyConfigFields('codex', source, base), /高级鉴权/);
  assert.throws(() => readConfigFields('codex', 'model=['), /格式/);
  assert.throws(() => readConfigFields('claude', '[]'), /格式/);
});

test('session usage list is authenticated, canonical, searchable and keeps context snapshots separate from cumulative usage', async t => {
  const f = await fixture(); t.after(f.close);
  const create = async (provider: string, title: string) => (await (await f.call('/api/conversations', { method: 'POST', body: JSON.stringify({ provider, title, projectName: '统计项目', cwd: { root: 'project', path: '' } }) })).json());
  const a = await create('codex', '编码统计'), b = await create('claude', '文稿统计'), c = await create('codex', '尚未运行');
  f.studio.codex.sessions.get(a.sessionId)!.threadId = 'stats-native'; f.catalog.set('stats-native', { ...f.catalog.get(a.sessionId)!, sessionId: 'stats-native' });
  f.studio.usage.set(a.sessionId, codexTokens({ total: { totalTokens: 120, inputTokens: 100, outputTokens: 20 } }));
  f.studio.usage.set('stats-native', { ...codexTokens({ total: { totalTokens: 125 } }), updatedAt: '2099-01-01T00:00:00Z' });
  f.studio.usage.set(b.sessionId, claudeTokens({ used: 0, total: 200000 }));
  const response = await f.call('/api/usage/sessions'); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const page = await response.json(); assert.equal(page.items.length, 3);
  assert.equal(page.items.find((row: { sessionId: string }) => row.sessionId === a.sessionId).snapshot.totalTokens, 125);
  assert.equal((await (await f.call('/api/usage/sessions/' + a.sessionId)).json()).snapshot.totalTokens, 125);
  assert.equal((await (await f.call('/api/usage/sessions/stats-native')).json()).snapshot.totalTokens, 125);
  const claude = page.items.find((row: { sessionId: string }) => row.sessionId === b.sessionId); assert.equal(claude.snapshot.scope, 'context'); assert.equal(claude.snapshot.contextTokens, 0); assert.equal(claude.snapshot.totalTokens, undefined);
  assert.equal(page.items.find((row: { sessionId: string }) => row.sessionId === c.sessionId).snapshot, null);
  assert.equal((await (await f.call('/api/usage/sessions?provider=codex&search=编码&limit=1')).json()).total, 1);
  const first = await (await f.call('/api/usage/sessions?limit=1')).json(); assert.equal(first.hasMore, true);
  assert.equal((await (await f.call('/api/usage/sessions?offset=1&limit=100')).json()).items.length, 2);
  assert.equal((await fetch(f.base + '/api/usage/sessions')).status, 401);
  assert.equal((await f.call('/api/usage/sessions?limit=1001')).status, 400);
  const restored = new UsageStore(f.temp + '/state'); assert.equal(restored.get(b.sessionId)?.contextTokens, 0);
  await f.studio.codex.send(c.sessionId, 'default config'); await until(() => f.studio.codex.approvals.size === 1); await f.studio.codex.abort(c.sessionId);
});
