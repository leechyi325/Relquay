import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.ts';
import { CodexBridge } from '../server/codex.ts';

test('conversation rename persists for both agents without changing identity, files or work directory', async t => {
  const f = await fixture(); t.after(f.close);
  await fs.writeFile(path.join(f.temp, 'project/keep.txt'), 'source remains');
  for (const provider of ['claude', 'codex']) {
    const create = await f.call('/api/conversations', { method: 'POST', body: JSON.stringify({ provider, projectName: '项目', title: '旧会话', cwd: { root: 'project', path: '' } }) });
    const item = await create.json();
    const get = await f.call('/api/conversations/' + item.sessionId); assert.equal(get.status, 200); assert.equal(get.headers.get('cache-control'), 'no-store');
    if (provider === 'claude') {
      f.catalog.set('native-claude-alias', f.catalog.get(item.sessionId)!);
      assert.equal((await (await f.call('/api/conversations/native-claude-alias')).json()).sessionId, item.sessionId);
      f.catalog.delete('native-claude-alias');
    }
    f.running.add(item.sessionId);
    const rename = await f.call('/api/conversations/' + item.sessionId, { method: 'PUT', body: JSON.stringify({ title: '  手机重命名  ' }) });
    assert.equal(rename.status, 200); const changed = await rename.json(); assert.equal(changed.sessionTitle, '手机重命名');
    assert.equal(changed.sessionId, item.sessionId); assert.equal(changed.projectPath, item.projectPath); assert.equal(changed.projectDisplayName, '项目');
    assert.equal(f.catalog.get(item.sessionId)?.sessionTitle, '手机重命名');
    assert.equal((await (await f.call('/api/conversations/' + item.sessionId)).json()).sessionTitle, '手机重命名');
    const recent = await (await f.call('/api/cloud/providers/sessions/recent')).json();
    assert.equal(recent.data.conversations.find((v: { sessionId: string }) => v.sessionId === item.sessionId).sessionTitle, '手机重命名');
    for (const title of ['', '  ', 'x'.repeat(201)]) assert.equal((await f.call('/api/conversations/' + item.sessionId, { method: 'PUT', body: JSON.stringify({ title }) })).status, 400);
    f.running.delete(item.sessionId);
  }
  assert.equal(await fs.readFile(path.join(f.temp, 'project/keep.txt'), 'utf8'), 'source remains');
  assert.equal((await fetch(f.base + '/api/conversations/missing')).status, 401);
  assert.equal((await fetch(f.base + '/api/conversations/missing', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"title":"x"}' })).status, 401);
});

test('notifications can resolve owned Codex history without a CloudCLI catalog row, while deleted sessions return actionable errors', async t => {
  const f = await fixture(); t.after(f.close);
  const response = await f.call('/api/conversations', { method: 'POST', body: JSON.stringify({ provider: 'codex', projectName: '恢复项目', title: '可恢复对话', cwd: { root: 'inputs', path: '' } }) });
  const item = await response.json();
  f.catalog.delete(item.sessionId); // Reproduce the real404 observed for a notice.
  const session = f.studio.codex.sessions.get(item.sessionId)!; session.threadId = 'native-thread-alias';
  assert.equal((await (await f.call('/api/conversations/native-thread-alias')).json()).sessionId, item.sessionId);
  const renamed = await f.call('/api/conversations/' + item.sessionId, { method: 'PUT', body: '{"title":"独立目录记录"}' });
  assert.equal(renamed.status, 200); assert.equal((await renamed.json()).sessionTitle, '独立目录记录');
  const restored = new CodexBridge(path.join(f.temp, 'state/codex'), process.execPath, [path.resolve('tests/codex-fixture.mjs')]);
  assert.equal(restored.info(item.sessionId)?.sessionTitle, '独立目录记录'); restored.close();
  const history = await f.call('/api/cloud/providers/sessions/' + item.sessionId + '/messages'); assert.equal(history.status, 200);
  f.studio.codex.sessions.get(item.sessionId)!.threadId = undefined;
  assert.equal((await f.call('/api/conversations/' + item.sessionId, { method: 'DELETE' })).status, 200);
  const missing = await f.call('/api/conversations/' + item.sessionId); assert.equal(missing.status, 410); assert.match((await missing.json()).error, /删除或归档/);
  f.studio.codex.register('legacy-owned', path.join(f.temp, 'inputs'));
  assert.equal((await f.call('/api/conversations/legacy-owned')).status, 200);
});
