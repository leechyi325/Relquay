import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { fixture, until } from './helpers.ts';
import { Files } from '../server/files.ts';
import { Jobs } from '../server/jobs.ts';
import { emptyChat, reduceChat, decodeEvent } from '../shared/protocol.ts';

test('gateway login, protected files and upstream administration boundaries', async t => {
  const f = await fixture(); t.after(f.close);
  assert.equal((await fetch(f.base + '/api/files')).status, 401);
  assert.equal((await f.call('/api/cloud/auth/register', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await f.call('/api/files', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await f.call('/api/me')).status, 200);
  await f.call('/api/logout', { method: 'POST', body: '{}' });
  assert.equal((await f.call('/api/me')).status, 401);
});
test('filesystem rejects traversal, symlink escapes and conflicting writes', async t => {
  const f = await fixture(); t.after(f.close);
  await fs.writeFile(path.join(f.temp, 'project/script.md'), '原始文本');
  await fs.symlink(path.join(f.temp, 'state'), path.join(f.temp, 'project/escape'));
  assert.equal((await f.call('/api/files?root=project&path=../state')).status, 403);
  assert.equal((await f.call('/api/files?root=project&path=escape')).status, 403);
  assert.equal((await f.call('/api/files?root=project&path=/etc')).status, 400);
  const content = await (await f.call('/api/files/text?root=project&path=script.md')).json();
  const body = { root: 'project', path: 'script.md', content: '修订文本', modified: content.modified };
  assert.equal((await f.call('/api/files/text', { method: 'PUT', body: JSON.stringify(body) })).status, 200);
  assert.equal((await f.call('/api/files/text', { method: 'PUT', body: JSON.stringify(body) })).status, 409);
  assert.equal(await fs.readFile(path.join(f.temp, 'project/script.md'), 'utf8'), '修订文本');
});
test('Chinese uploads, exclusive destination, scoped previews and media byte ranges', async t => {
  const f = await fixture(); t.after(f.close);
  const form = new FormData(); form.append('file', new Blob(['0123456789']), '示例.txt');
  assert.equal((await f.call('/api/files/upload?root=inputs', { method: 'POST', body: form })).status, 200);
  assert.equal(await fs.readFile(path.join(f.temp, 'inputs/示例.txt'), 'utf8'), '0123456789');
  const again = new FormData(); again.append('file', new Blob(['overwrite']), '示例.txt');
  assert.equal((await f.call('/api/files/upload?root=inputs', { method: 'POST', body: again })).status, 409);
  const { url } = await (await f.call('/api/files/preview', { method: 'POST', body: JSON.stringify({ root: 'inputs', path: '示例.txt' }) })).json();
  const partial = await fetch(f.base + url, { headers: { Range: 'bytes=2-5', Origin: 'null' } });
  assert.equal(partial.status, 206); assert.equal(await partial.text(), '2345'); assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal((await fetch(f.base + url, { headers: { Range: 'bytes=50-' } })).status, 416);
  assert.equal((await fetch(f.base + url.replace('/preview/', '/preview/corrupt'))).status, 403);
  assert.equal((await fetch(f.base + '/api/files', { headers: { Origin: 'null' } })).status, 403);
});
test('job serialization, cancellation and persisted interrupted state', async t => {
  const f = await fixture(); t.after(f.close);
  const first = await f.studio.jobs.add('long job', 'echo started; sleep 20', { root: 'project', path: '' });
  const next = await f.studio.jobs.add('next job', 'echo next-result', { root: 'project', path: '' });
  await until(() => !!f.studio.jobs.child?.pid);
  assert.equal(next.status, 'queued');
  f.studio.jobs.cancel(first.id);
  await until(() => next.status === 'succeeded');
  assert.equal(first.status, 'cancelled'); assert.match(f.studio.jobs.log(next.id), /next-result/);
  const persisted = new Jobs(path.join(f.temp, 'restart'), new Files(f.temp));
  persisted.records = [{ ...first, status: 'running' }]; persisted.persist();
  const restarted = new Jobs(path.join(f.temp, 'restart'), new Files(f.temp));
  assert.equal(restarted.records[0].status, 'interrupted');
});
test('one-time websocket tickets bridge only the intended channel', async t => {
  const f = await fixture(); t.after(f.close);
  const { ticket } = await (await f.call('/api/socket-ticket', { method: 'POST', body: '{"channel":"chat"}' })).json();
  const socketUrl = f.base.replace('http', 'ws') + '/ws/chat?ticket=' + ticket;
  const ws = new WebSocket(socketUrl); await once(ws, 'open');
  const message = once(ws, 'message'); ws.send('{"type":"chat.subscribe","sessions":[{"sessionId":"test-session","lastSeq":0}]}');
  assert.equal(JSON.parse((await message)[0].toString()).kind, 'chat_subscribed');
  ws.close();
  const replay = new WebSocket(socketUrl); const [error] = await once(replay, 'error'); assert.match(String(error), /401/);
});
test('chat replay keeps upstream cursor, resolves approvals and ignores duplicates', () => {
  const approval = decodeEvent({ kind: 'permission_request', seq: 3, requestId: 'p1', toolName: 'Bash' })!;
  const state = reduceChat(emptyChat, approval); assert.equal(state.permissions.length, 1);
  assert.equal(reduceChat(state, approval), state);
  const connected = reduceChat(state, { kind: 'chat_subscribed', isProcessing: true, lastSeq: 9, pendingPermissions: [] });
  assert.equal(connected.lastSeq, 3); assert.equal(connected.permissions.length, 0);
  const complete = reduceChat(connected, { kind: 'complete', seq: 10, success: false }); assert.equal(complete.processing, false);
});
