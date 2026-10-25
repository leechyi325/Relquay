import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fixture } from './helpers.ts';

test('named project location, persisted upstream catalog, delete preserves source', async t => {
  const f = await fixture(); t.after(f.close);
  const input = { provider: 'codex', projectName: '我的项目', title: '功能实现', cwd: { root: 'project', path: '' }, createDirectory: true };
  const create = await f.call('/api/conversations', { method: 'POST', body: JSON.stringify(input) });
  assert.equal(create.status, 201); const conversation = await create.json();
  const expected = await fs.realpath(path.join(f.temp, 'project/我的项目'));
  assert.equal(conversation.projectPath, expected);
  assert.equal(f.studio.codex.sessions.get(conversation.sessionId)?.cwd, expected);
  assert.equal(f.catalog.get(conversation.sessionId)?.projectPath, expected);
  assert.equal(f.projects[0].displayName, '我的项目');
  const recent = await (await f.call('/api/cloud/providers/sessions/recent')).json();
  assert.equal(recent.data.conversations[0].sessionTitle, '功能实现');
  assert.equal(recent.data.conversations[0].projectDisplayName, '我的项目');
  await fs.writeFile(path.join(expected, 'film.ts'), 'source-must-survive');
  f.running.add(conversation.sessionId);
  assert.equal((await f.call('/api/conversations/' + conversation.sessionId, { method: 'DELETE' })).status, 409);
  f.running.clear();
  assert.equal((await f.call('/api/conversations/' + conversation.sessionId, { method: 'DELETE' })).status, 200);
  assert.equal(f.catalog.has(conversation.sessionId), false); assert.equal(f.studio.codex.has(conversation.sessionId), false);
  assert.equal(await fs.readFile(path.join(expected, 'film.ts'), 'utf8'), 'source-must-survive');
});

test('existing directory naming and invalid project locations are enforced', async t => {
  const f = await fixture(); t.after(f.close);
  const input = { provider: 'claude', projectName: '现有项目', cwd: { root: 'project', path: '' } };
  const first = await f.call('/api/conversations', { method: 'POST', body: JSON.stringify(input) }); assert.equal(first.status, 201);
  const second = await f.call('/api/conversations', { method: 'POST', body: JSON.stringify({ ...input, projectName: '改名后的项目' }) }); assert.equal(second.status, 201);
  assert.equal(f.projects.length, 1); assert.equal(f.projects[0].displayName, '改名后的项目');
  for (const invalid of [{ ...input, cwd: { root: 'project', path: '../state' } }, { ...input, projectName: '../escape', createDirectory: true }]) {
    const result = await f.call('/api/conversations', { method: 'POST', body: JSON.stringify(invalid) }); assert.ok([400, 403].includes(result.status));
  }
  await fs.mkdir(path.join(f.temp, 'project/已存在'));
  assert.equal((await f.call('/api/conversations', { method: 'POST', body: JSON.stringify({ ...input, projectName: '已存在', createDirectory: true }) })).status, 409);
  await fs.symlink(path.join(f.temp, 'state'), path.join(f.temp, 'project/escape'));
  assert.equal((await f.call('/api/conversations', { method: 'POST', body: JSON.stringify({ ...input, cwd: { root: 'project', path: 'escape' } }) })).status, 403);
});
