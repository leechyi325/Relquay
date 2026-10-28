import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { fixture } from './helpers.ts';
import { quotaReset } from '../shared/time.ts';
import type { McpDetail, McpDocument } from '../shared/extensions.ts';
const text = '---\nname: phone-helper\ndescription: A test skill\n---\n\nRun this workflow.\n';

test('user skills create, conflict, resource import and delete remain inside dedicated user roots', async () => {
  const f = await fixture();
  try {
    const list = await f.extensions.saveSkill('codex', 'phone-helper', text);
    assert.equal(list.length, 1); assert.match(list[0].path, /agent-codex\/skills\/phone-helper\/SKILL.md$/);
    await assert.rejects(f.extensions.saveSkill('codex', '../escape', text));
    await assert.rejects(f.extensions.saveSkill('codex', 'phone-helper', text), /同名/);
    await assert.rejects(f.extensions.saveSkill('codex', 'phone-helper', text, list[0].id, 'stale'), /修改/);
    await f.extensions.saveSkill('codex', 'phone-helper', text + 'Updated.', list[0].id, list[0].revision);
    const source = path.join(f.temp, 'project/source-skill'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'SKILL.md'), text); await fs.writeFile(path.join(source, 'support.py'), 'print(42)');
    const imported = await f.extensions.importSkill('claude', 'imported', source);
    assert.equal(await fs.readFile(path.join(path.dirname(imported[0].path), 'support.py'), 'utf8'), 'print(42)');
    await assert.rejects(f.extensions.importSkill('claude', 'imported', source), /同名/);
    await fs.symlink('/tmp', path.join(source, 'escape'));
    await assert.rejects(f.extensions.importSkill('claude', 'linked', source), /符号链接/);
    await f.extensions.removeSkill('claude', imported[0].id, imported[0].revision);
    assert.equal((await f.extensions.skills('claude')).length, 0);
    assert.equal(await fs.readFile(path.join(source, 'support.py'), 'utf8'), 'print(42)');
  } finally { await f.close(); }
});

test('provider MCP edits, global disable and conflicts preserve other settings and hide secrets in lists', async () => {
  const f = await fixture();
  try {
    const codex = path.join(f.temp, 'agent-codex/config.toml'); await fs.mkdir(path.dirname(codex), { recursive: true }); await fs.writeFile(codex, 'model = "keep-model"\n');
    const before = await f.extensions.mcps('codex') as McpDocument;
    await f.extensions.saveMcp('codex', 'docs', { url: 'https://example.com/mcp?token=test-secret', http_headers: { Authorization: 'Bearer test-secret' } }, true, before.revision, false, true);
    const list = await f.extensions.mcps('codex') as McpDocument;
    assert.ok(!JSON.stringify(list).includes('test-secret')); assert.equal(list.entries[0].enabled, true);
    await assert.rejects(f.extensions.saveMcp('codex', 'docs', { url: 'https://elsewhere.test/mcp' }, true, before.revision), /变化/);
    await assert.rejects(f.extensions.saveMcp('codex', 'docs', { url: 'https://elsewhere.test/mcp' }, true, list.revision, false, true), /同名/);
    const detail = await f.extensions.mcps('codex', 'docs') as McpDetail;
    await f.extensions.saveMcp('codex', 'docs', detail.config, false, detail.revision);
    const saved = parse(await fs.readFile(codex, 'utf8')); assert.equal(saved.model, 'keep-model');
    assert.equal((await f.extensions.mcps('codex') as McpDocument).entries[0].enabled, false);
    const claude = path.join(f.temp, '.claude.json'); await fs.writeFile(claude, JSON.stringify({ oauthAccount: { must: 'stay-private' }, projects: { keep: { trust: true } } }));
    let state = await f.extensions.mcps('claude') as McpDocument;
    await f.extensions.saveMcp('claude', 'local', { type: 'stdio', command: 'node', args: ['server.js'], env: { SECRET: 'test-secret' } }, true, state.revision);
    const active = await f.extensions.mcps('claude', 'local') as McpDetail;
    await f.extensions.saveMcp('claude', 'local', active.config, false, active.revision);
    let raw = JSON.parse(await fs.readFile(claude, 'utf8')); assert.equal(raw.mcpServers.local, undefined); assert.equal(raw.oauthAccount.must, 'stay-private'); assert.equal(raw.projects.keep.trust, true);
    state = await f.extensions.mcps('claude') as McpDocument; assert.equal(state.entries[0].enabled, false); assert.ok(!JSON.stringify(state).includes('test-secret'));
    assert.equal((await fs.stat(path.join(f.temp, 'state/claude-mcp-disabled.json'))).mode & 0o777, 0o600);
    const disabled = await f.extensions.mcps('claude', 'local') as McpDetail;
    await f.extensions.saveMcp('claude', 'local', disabled.config, true, disabled.revision);
    raw = JSON.parse(await fs.readFile(claude, 'utf8')); assert.equal(raw.mcpServers.local.env.SECRET, 'test-secret');
    state = await f.extensions.mcps('claude') as McpDocument;
    await f.extensions.saveMcp('claude', 'local', {}, false, state.revision, true);
    assert.equal((await f.extensions.mcps('claude') as McpDocument).entries.length, 0);
    await fs.writeFile(path.join(f.temp, 'state/claude-mcp-disabled.json'), 'invalid fixture');
    assert.equal((await f.extensions.mcps('codex') as McpDocument).entries.length, 1);
    await assert.rejects(f.extensions.saveMcp('claude', 'constructor', {}, true, state.revision));
  } finally { await f.close(); }
});

test('extension routes require authentication, use actual provider config and refuse unknown plugin selectors', async () => {
  const f = await fixture();
  try {
    for (const item of ['skills', 'mcp', 'plugins']) assert.equal((await fetch(f.base + '/api/agents/claude/' + item)).status, 401);
    const added = await f.call('/api/agents/claude/plugins', { method: 'POST', body: JSON.stringify({ id: 'test-plugin@fixture', action: 'install' }) }); assert.equal(added.status, 200);
    assert.equal((await (await f.call('/api/agents/claude/plugins')).json())[0].id, 'test-plugin@fixture');
    assert.equal((await f.call('/api/agents/claude/plugins', { method: 'POST', body: JSON.stringify({ id: '--config@injection', action: 'install' }) })).status, 400);
    assert.equal((await f.call('/api/agents/claude/plugins', { method: 'POST', body: JSON.stringify({ id: 'missing@fixture', action: 'remove' }) })).status, 404);
    const toggled = await f.call('/api/agents/claude/plugins', { method: 'POST', body: JSON.stringify({ id: 'test-plugin@fixture', action: 'disable' }) }); assert.equal(toggled.status, 200);
    assert.equal((await (await f.call('/api/agents/claude/plugins')).json())[0].enabled, false);
    assert.equal((await f.call('/api/agents/claude/plugins', { method: 'POST', body: JSON.stringify({ id: 'test-plugin@fixture', action: 'remove' }) })).status, 200);
    assert.equal((await (await f.call('/api/agents/claude/plugins')).json()).length, 0);
    await f.extensions.pluginAction('codex', 'codex-probe@fixture', 'install');
    await f.extensions.pluginAction('codex', 'codex-probe@fixture', 'disable');
    const settings = parse(await fs.readFile(path.join(f.temp, 'agent-codex/config.toml'), 'utf8'));
    assert.deepEqual(JSON.parse(JSON.stringify(settings.plugins)), { 'codex-probe@fixture': { enabled: false } });
    await f.extensions.pluginAction('codex', 'codex-probe@fixture', 'remove');
    const state = await f.extensions.mcps('codex') as McpDocument;
    let release!: () => void; const lock = f.extensions.exclusive('codex', () => new Promise<void>(resolve => { release = resolve; }));
    await assert.rejects(f.extensions.exclusive('codex', async () => {}), /稍后/); release(); await lock;
    const config = await f.call('/api/agents/codex/mcp'); assert.equal(config.headers.get('cache-control'), 'no-store');
    assert.equal((await config.json()).revision, state.revision);
  } finally { await f.close(); }
});

test('quota reset formats the same instant across device zones and observes Pacific DST', () => {
  const reset = '2026-10-25T16:00:00.000Z', now = Date.parse('2026-10-25T14:30:00Z');
  const shanghai = quotaReset(reset, now, 'Asia/Shanghai'), pacific = quotaReset(reset, now, 'America/Los_Angeles');
  assert.match(shanghai.absolute, /00:00/); assert.match(shanghai.absolute, /GMT\+8/);
  assert.match(pacific.absolute, /09:00/); assert.match(pacific.absolute, /GMT-7/);
  assert.equal(shanghai.remaining, pacific.remaining); assert.match(shanghai.remaining, /1 小时 30 分钟后重置/);
  assert.match(quotaReset('2026-12-01T16:00:00Z', now, 'America/Los_Angeles').absolute, /GMT-8/);
  assert.match(quotaReset(reset, Date.parse(reset) + 1000).remaining, /等待刷新/);
});

test('agent and command documents are managed as plain markdown files with conflict checks', async () => {
  const f = await fixture();
  try {
    const agent = '---\nname: reviewer\ndescription: Reviews diffs\n---\n\nBe strict.\n';
    const list = await f.extensions.saveDoc('claude', 'agents', 'reviewer', agent);
    assert.equal(list[0].name, 'reviewer'); assert.equal(list[0].description, 'Reviews diffs'); assert.match(await fs.readFile(path.join(f.temp, 'agent-claude/agents/reviewer.md'), 'utf8'), /Be strict/);
    await assert.rejects(f.extensions.saveDoc('claude', 'agents', 'reviewer', agent), /已存在/);
    await assert.rejects(f.extensions.saveDoc('claude', 'agents', 'bad', 'no metadata'), /name 和 description/);
    await assert.rejects(f.extensions.saveDoc('claude', 'agents', '../escape', agent));
    await assert.rejects(f.extensions.saveDoc('claude', 'agents', 'reviewer', agent + 'x', 'stale'), /修改/);
    await assert.rejects(f.extensions.docs('codex', 'agents'), /Codex/);
    const command = await f.extensions.saveDoc('codex', 'commands', 'ship', '---\ndescription: Ship it\nargument-hint: [branch]\n---\n\nRelease $ARGUMENTS\n');
    assert.deepEqual([command[0].name, command[0].hint], ['ship', '[branch]']); assert.ok(await fs.stat(path.join(f.temp, 'agent-codex/prompts/ship.md')));
    await f.extensions.removeDoc('codex', 'commands', 'ship', command[0].revision);
    assert.equal((await f.extensions.docs('codex', 'commands')).length, 0);
  } finally { await f.close(); }
});
