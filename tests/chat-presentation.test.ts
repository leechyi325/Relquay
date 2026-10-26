import test from 'node:test';
import assert from 'node:assert/strict';
import { presentEvents } from '../shared/chat-presentation.ts';
import { emptyChat, reduceChat, type ChatEvent } from '../shared/protocol.ts';
import { CodexBridge } from '../server/codex.ts';
import { fixture } from './helpers.ts';

test('reasoning parts reconcile by item/channel across tools; snapshots replace deltas without losing text', () => {
  const events: ChatEvent[] = [
    { kind: 'thinking', itemId: 'r1', channel: 'summary', partIndex: 0, mode: 'delta', content: '**核对**' },
    { kind: 'status', content: 'working' },
    { kind: 'thinking', itemId: 'r1', channel: 'summary', partIndex: 0, mode: 'delta', content: '中文' },
    { kind: 'thinking', itemId: 'r1', channel: 'summary', partIndex: 1, mode: 'delta', content: '下一段' },
    { kind: 'thinking', itemId: 'r1', channel: 'reasoning', mode: 'delta', content: '代理返回的正文' },
    { kind: 'thinking', itemId: 'r1', channel: 'summary', mode: 'snapshot', content: '**核对**中文\n\n下一段（完整）' },
    { kind: 'stream_delta', itemId: 'm1', content: '# 最终' },
    { kind: 'tool_result', content: 'tool' },
    { kind: 'text', itemId: 'm1', role: 'assistant', content: '# 最终\n\n| 表格 | 结果 |\n| --- | --- |\n| A | B |' },
    { kind: 'complete' },
  ];
  const shown = presentEvents(events);
  assert.equal(shown.filter(e => e.kind === 'thinking').length, 2);
  assert.equal(shown[0].content, '**核对**中文\n\n下一段（完整）');
  assert.equal(shown.filter(e => ['text', 'stream_delta'].includes(e.kind)).length, 1);
  assert.match(shown.find(e => e.itemId === 'm1')!.content!, /表格/);
  assert.equal(events[0].content, '**核对**'); // projection must not mutate replay source
});

test('long live reasoning keeps its beginning and end; repeated events and separate turns stay distinct', () => {
  let state = emptyChat;
  for (let i = 1; i <= 2400; i++) state = reduceChat(state, { kind: 'thinking', provider: 'codex', mode: 'delta', itemId: 'long', seq: i, id: String(i), content: i === 1 ? '开头' : i === 2400 ? '结尾' : '中' });
  const repeated = reduceChat(state, { kind: 'thinking', seq: 2400, id: '2400', content: '重复' });
  assert.equal(repeated, state);
  const shown = presentEvents(state.events); assert.equal(shown.length, 1);
  assert.ok(shown[0].content!.startsWith('开头')); assert.ok(shown[0].content!.endsWith('结尾'));
  assert.equal(presentEvents([...state.events, { kind: 'complete' }, { kind: 'thinking', provider: 'codex', itemId: 'long', content: '下一轮' }]).filter(e => e.kind === 'thinking').length, 2);
});

test('owned Codex history never starts midway through a long reasoning turn and can page older turns', async t => {
  const f = await fixture(); t.after(f.close); const bridge = f.studio.codex;
  bridge.register('history-fixture', f.temp);
  const session = bridge.sessions.get('history-fixture')!;
  session.threadId = 'test-native';
  const emit = (method: string, params: Record<string, unknown>) => bridge.receive({ method, params: { threadId: 'test-native', ...params } });
  session.events.push({ kind: 'text', role: 'user', content: 'previous' }, { kind: 'text', role: 'assistant', content: 'earlier answer' }, { kind: 'complete' }, { kind: 'text', role: 'user', content: 'current' });
  for (let i = 0; i < 250; i++) emit('item/reasoning/summaryTextDelta', { itemId: 'r1', summaryIndex: 0, delta: i === 0 ? '开始' : '中' });
  emit('item/reasoning/textDelta', { itemId: 'r1', contentIndex: 0, delta: '返回的思考正文' });
  emit('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['完整摘要一', '完整摘要二'], content: ['返回的思考正文全文'] } });
  const first = await (await f.call('/api/cloud/providers/sessions/history-fixture/messages?limit=100')).json();
  assert.equal(first.data.messages[0].content, 'current'); assert.equal(first.data.hasMore, true);
  const reasoning = presentEvents(first.data.messages).filter(e => e.kind === 'thinking');
  assert.equal(reasoning.length, 2); assert.equal(reasoning[0].content, '完整摘要一\n\n完整摘要二'); assert.equal(reasoning[1].content, '返回的思考正文全文');
  const older = await (await f.call('/api/cloud/providers/sessions/history-fixture/messages?limit=100&offset=' + first.data.nextOffset)).json();
  assert.equal(older.data.messages[0].content, 'previous'); assert.equal(older.data.hasMore, false);
  const restored = new CodexBridge(f.temp + '/state/codex');
  assert.ok(restored.history('history-fixture', 1000).messages.some(e => e.content === '完整摘要一\n\n完整摘要二')); restored.close();
});

test('recent conversations collapse app/native aliases, preserve independent same-title sessions and owned orphans', async t => {
  const f = await fixture(); t.after(f.close);
  const create = async () => (await (await f.call('/api/conversations', { method: 'POST', body: JSON.stringify({ provider: 'codex', title: '同名', projectName: '相同项目', cwd: { root: 'project', path: '' } }) })).json());
  const a = await create(), b = await create();
  f.studio.codex.sessions.get(a.sessionId)!.threadId = 'native-alias';
  f.catalog.set('native-alias', { ...f.catalog.get(a.sessionId)!, sessionId: 'native-alias' });
  const rows = (await (await f.call('/api/cloud/providers/sessions/recent')).json()).data.conversations;
  assert.equal(rows.length, 2); assert.ok(rows.every((v: { sessionTitle: string }) => v.sessionTitle === '同名')); assert.equal(rows.filter((v: { sessionId: string }) => v.sessionId === a.sessionId).length, 1);
  f.running.add('native-alias');
  assert.equal((await f.call('/api/conversations/' + a.sessionId, { method: 'DELETE' })).status, 409);
  f.running.delete('native-alias');
  assert.equal((await f.call('/api/conversations/native-alias', { method: 'DELETE' })).status, 200);
  assert.ok(!f.catalog.has('native-alias')); assert.ok(!f.catalog.has(a.sessionId));
  f.catalog.delete(b.sessionId);
  assert.equal((await (await f.call('/api/cloud/providers/sessions/recent')).json()).data.conversations.length, 1);
});
