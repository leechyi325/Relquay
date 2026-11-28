import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { MessageQueue, type QueuedMessage } from '../server/queue.ts';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { fixture } from './helpers.ts';

const wait = async (check: () => boolean, ms = 10000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(resolve => setTimeout(resolve, 50)); } };

test('queue sends after a normal completion only, once per completion, and pauses after a stop or failed send', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'relquay-queue-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sent: string[] = [], views: unknown[] = []; let idle = false, fail = false;
  const queue = new MessageQueue(dir, async (_id, item: QueuedMessage) => { if (fail) throw new Error('上游不可用'); sent.push(item.content); }, async () => idle, view => views.push(view));
  await queue.add('s', { content: '第一条' }); await queue.add('s', { content: '第二条' });
  assert.deepEqual([...sent], []); assert.equal(queue.view('s').items.length, 2);
  await queue.completed({ kind: 'complete', sessionId: 's', id: 'c1' });
  assert.deepEqual([...sent], ['第一条']);
  await queue.completed({ kind: 'complete', sessionId: 's', id: 'c1' }); // same completion seen on another socket
  assert.deepEqual([...sent], ['第一条']);
  await new Promise(resolve => setTimeout(resolve, 1600));
  await queue.completed({ kind: 'complete', sessionId: 's', id: 'c2', aborted: true });
  assert.deepEqual([...sent], ['第一条']); assert.match(queue.view('s').paused ?? '', /暂停/);
  // The queue survives a restart.
  const reloaded = new MessageQueue(dir, async (_id, item: QueuedMessage) => { sent.push(item.content); }, async () => true);
  assert.equal(reloaded.view('s').items[0].content, '第二条');
  await reloaded.resume('s'); assert.deepEqual([...sent], ['第一条', '第二条']); assert.equal(reloaded.view('s').items.length, 0);
  // Added while idle: sent at once; a failed send keeps the message and pauses.
  idle = true; await queue.resume('s'); sent.length = 0;
  await queue.add('t', { content: '立即发送' }); assert.deepEqual([...sent], ['立即发送']);
  fail = true; await queue.add('t', { content: '发送失败' });
  assert.equal(queue.view('t').items[0].content, '发送失败'); assert.match(queue.view('t').paused ?? '', /上游不可用/);
  queue.remove('t', queue.view('t').items[0].id); assert.equal(queue.view('t').items.length, 0);
  assert.ok(views.length > 0);
});

test('a queued Claude message is sent by the server when the running turn completes', async t => {
  const f = await fixture(); t.after(f.close);
  const sessionId = randomUUID(); f.catalog.set(sessionId, { sessionId, provider: 'claude', projectPath: path.join(f.temp, 'project'), sessionTitle: '排队' });
  f.running.add(sessionId);
  const post = (url: string, value: unknown) => f.call(url, { method: 'POST', body: JSON.stringify(value) });
  assert.equal((await post(`/api/conversations/${sessionId}/queue`, { content: '跑完后检查测试', options: { permissionMode: 'acceptEdits' } })).status, 201);
  assert.equal((await (await f.call(`/api/conversations/${sessionId}/queue`)).json()).items.length, 1);
  // The server observer follows running sessions; wait until it subscribed before the run completes.
  await wait(() => f.sentMessages.some(message => message.type === 'chat.subscribe' && JSON.stringify(message).includes(sessionId)));
  f.running.delete(sessionId); f.publish(sessionId, { kind: 'complete' });
  await wait(() => f.sentMessages.some(message => message.type === 'chat.send' && message.sessionId === sessionId));
  const sent = f.sentMessages.find(message => message.type === 'chat.send' && message.sessionId === sessionId)!;
  assert.equal(sent.content, '跑完后检查测试'); assert.equal((sent.options as { permissionMode: string }).permissionMode, 'acceptEdits');
  assert.equal((await (await f.call(`/api/conversations/${sessionId}/queue`)).json()).items.length, 0);
  assert.equal((await post(`/api/conversations/${sessionId}/queue`, { content: '' })).status, 400);
});

test('the events channel pushes change hints and answers pings without an upstream connection', async t => {
  const f = await fixture(); t.after(f.close);
  const { ticket } = await (await f.call('/api/socket-ticket', { method: 'POST', body: '{"channel":"events"}' })).json();
  const ws = new WebSocket(f.base.replace('http', 'ws') + '/ws/events?ticket=' + ticket); t.after(() => ws.close());
  const frames: { type: string; topics?: string[] }[] = []; ws.on('message', data => frames.push(JSON.parse(data.toString())));
  await once(ws, 'open'); await wait(() => frames.some(frame => frame.type === 'hello'));
  ws.send('{"type":"ping"}'); await wait(() => frames.some(frame => frame.type === 'pong'));
  await f.call('/api/jobs', { method: 'POST', body: JSON.stringify({ title: '推送', command: 'true', cwd: { root: 'project', path: '' } }) });
  await wait(() => frames.some(frame => frame.type === 'changed' && frame.topics?.includes('jobs')));
  const before = f.sentMessages.length; await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.sentMessages.slice(before).filter(message => JSON.stringify(message).includes('ping')).length, 0);
  const reused = new WebSocket(f.base.replace('http', 'ws') + '/ws/events?ticket=' + ticket);
  await assert.rejects(once(reused, 'open'));
});
