import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { codePath, fileLine, linkPath, toolPaths, urlTransform } from '../src/file-links.ts';
import { emptyChat, mergeLatestHistory, reduceChat } from '../shared/protocol.ts';
import { fixture } from './helpers.ts';

test('file references in replies: links, inline code and tool inputs, but not commands or plain code', () => {
  assert.equal(linkPath('src/App.tsx:12'), 'src/App.tsx');
  assert.equal(linkPath('file:///home/u/%E6%8A%A5%E5%91%8A.pdf#L3'), '/home/u/报告.pdf');
  assert.equal(linkPath('<docs/a b.md>'), 'docs/a b.md');
  for (const value of ['https://example.com', 'mailto:a@b.c', '#section', '//cdn.example/x.js']) assert.equal(linkPath(value), null, value);
  assert.equal(urlTransform('file:///tmp/a.txt'), 'file:///tmp/a.txt');
  assert.equal(urlTransform('javascript:alert(1)'), '');
  assert.equal(codePath('src/App.tsx:12:3'), 'src/App.tsx');
  assert.equal(codePath('~/dev/Relquay/'), '~/dev/Relquay/');
  assert.equal(codePath('报告.pdf'), '报告.pdf');
  assert.equal(codePath('package.json'), 'package.json');
  for (const value of ['console.log', 'npm run build', 'ls -la out/report.pdf', 'cat a.md | head', 'a.b.c()', 'src/utils', '$HOME/a.txt']) assert.equal(codePath(value), null, value);
  assert.equal(fileLine('src/App.tsx:12'), 12); assert.equal(fileLine('a.ts#L40-L42'), 40); assert.equal(fileLine('a.ts'), undefined);
  assert.deepEqual(toolPaths({ file_path: '/w/a.ts', path: '/w/a.ts' }), ['/w/a.ts']);
  assert.deepEqual(toolPaths({ command: 'ls' }), []);
});

test('broadcast frames neither add chat rows nor mark the session busy; confirmed messages keep their row key', () => {
  let state = reduceChat(emptyChat, { kind: 'scheduled_messages_changed', sessionId: 's' });
  state = reduceChat(state, { kind: 'relquay_pong' });
  state = reduceChat(state, { kind: 'session_upserted', sessionId: 's' });
  assert.equal(state.processing, false); assert.equal(state.events.length, 0);
  state = { ...state, events: [{ kind: 'text', role: 'user', content: 'hi', id: 'local', optimistic: true }] };
  state = reduceChat(state, { kind: 'text', role: 'user', content: 'hi', id: 'server', seq: 1 });
  assert.equal(state.events.length, 1); assert.equal(state.events[0].id, 'server'); assert.equal(state.events[0].renderKey, 'local');
});

test('locate maps conversation paths onto bound roots; delete removes files and folders but protects roots', async t => {
  const f = await fixture(); t.after(f.close);
  const post = (url: string, value: unknown) => f.call(url, { method: 'POST', body: JSON.stringify(value) });
  const project = path.join(f.temp, 'project');
  await fs.mkdir(path.join(project, 'app/src'), { recursive: true }); await fs.writeFile(path.join(project, 'app/src/main.ts'), 'x');
  await fs.mkdir(path.join(f.temp, 'outside')); await fs.writeFile(path.join(f.temp, 'outside/secret.txt'), 's');

  const relative = await (await post('/api/files/locate', { path: 'src/main.ts', base: path.join(project, 'app') })).json();
  assert.deepEqual([relative.root, relative.path, relative.directory], ['project', 'app/src/main.ts', false]);
  const absolute = await (await post('/api/files/locate', { path: 'file://' + path.join(project, 'app') })).json();
  assert.deepEqual([absolute.root, absolute.path, absolute.directory], ['project', 'app', true]);
  assert.equal((await post('/api/files/locate', { path: path.join(f.temp, 'outside/secret.txt') })).status, 404);
  assert.equal((await post('/api/files/locate', { path: path.join(project, 'missing.txt') })).status, 404);
  assert.equal((await post('/api/files/locate', { path: 'main.ts' })).status, 404);

  assert.equal((await post('/api/files/delete', { root: 'project', path: '' })).status, 400);
  assert.equal((await post('/api/files/delete', { root: 'project', path: 'app/..' })).status, 400);
  assert.equal((await post('/api/files/delete', { root: 'project', path: '../outside' })).status, 403);
  await fs.symlink(path.join(f.temp, 'outside'), path.join(project, 'link'));
  assert.equal((await post('/api/files/delete', { root: 'project', path: 'link' })).status, 403);
  assert.equal(await fs.readFile(path.join(f.temp, 'outside/secret.txt'), 'utf8'), 's');

  // A folder that contains another bound module root cannot be deleted from here.
  const extra = { id: 'module_nested', name: '嵌套', folders: [{ id: 'folder_nested', name: '源码', path: path.join(project, 'app/src') }] };
  assert.equal((await f.call('/api/file-modules/module_nested', { method: 'PUT', body: JSON.stringify(extra) })).status, 200);
  assert.equal((await post('/api/files/delete', { root: 'project', path: 'app' })).status, 409);
  assert.equal((await f.call('/api/file-modules/module_nested', { method: 'DELETE' })).status, 200);

  assert.equal((await post('/api/files/delete', { root: 'project', path: 'app/src/main.ts' })).status, 200);
  await assert.rejects(fs.access(path.join(project, 'app/src/main.ts')));
  const folder = await (await post('/api/files/delete', { root: 'project', path: 'app' })).json();
  assert.equal(folder.directory, true); await assert.rejects(fs.access(path.join(project, 'app')));
  assert.equal((await post('/api/files/delete', { root: 'project', path: 'app' })).status, 404);
});

test('catching up after a missed run end keeps loaded pages and unsent messages, and never wipes the screen', () => {
  const older = [{ kind: 'text', id: 'a', content: '旧' }, { kind: 'text', id: 'b', content: '中' }], pending = { kind: 'text', id: 'local', role: 'user', content: '未发出', optimistic: true };
  const fresh = [{ kind: 'text', id: 'b', content: '中' }, { kind: 'text', id: 'c', content: '离线期间的回复' }];
  const merged = mergeLatestHistory([...older, { kind: 'stream_delta', content: '残' }, pending], fresh)!;
  assert.deepEqual(merged.events.map(event => event.id), ['a', 'b', 'c', 'local']); assert.equal(merged.restarted, false);
  assert.equal(mergeLatestHistory(older, []), undefined);
  assert.equal(mergeLatestHistory(older, [{ kind: 'text', id: 'z' }])!.restarted, true);
});
