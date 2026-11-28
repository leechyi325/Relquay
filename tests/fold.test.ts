import test from 'node:test';
import assert from 'node:assert/strict';
import { foldProcess, isFold } from '../shared/fold.ts';
import type { ChatEvent } from '../shared/protocol.ts';

const user = (id: string): ChatEvent => ({ kind: 'text', role: 'user', content: '问' + id, id });
const say = (id: string, content = '答' + id): ChatEvent => ({ kind: 'text', role: 'assistant', content, id });
const think = (id: string): ChatEvent => ({ kind: 'thinking', content: '想', id });
const tool = (id: string, name = 'Read'): ChatEvent => ({ kind: 'tool_use', toolName: name, id });
const result = (id: string): ChatEvent => ({ kind: 'tool_result', content: 'ok', id });
const shape = (rows: ReturnType<typeof foldProcess>) => rows.map(row => isFold(row) ? `fold(${row.events.map(e => e.id).join(',')})` : row.id);

test('work before the answer folds away; the question and the answer stay', () => {
  const rows = foldProcess([user('u1'), think('t1'), tool('c1'), result('r1'), say('a0', '我先看看'), tool('c2'), result('r2'), say('a1')], false);
  assert.deepEqual(shape(rows), ['u1', 'fold(t1,c1,r1,a0,c2,r2)', 'a1']);
  const fold = rows[1]; assert.ok(isFold(fold) && fold.thinking === 1 && fold.tools === 2 && fold.notes === 1 && fold.latest === 'Read');
});
test('a plain answer has nothing to fold, and each question is folded on its own', () => {
  assert.deepEqual(shape(foldProcess([user('u1'), say('a1'), user('u2'), tool('c1'), say('a2')], false)), ['u1', 'a1', 'u2', 'fold(c1)', 'a2']);
});
test('errors stay visible, in front of the answer only when they came first', () => {
  const error: ChatEvent = { kind: 'error', content: '失败', id: 'e1' };
  assert.deepEqual(shape(foldProcess([user('u1'), tool('c1'), error, say('a1')], false)), ['u1', 'fold(c1)', 'e1', 'a1']);
  assert.deepEqual(shape(foldProcess([user('u1'), tool('c1'), error], false)), ['u1', 'fold(c1)', 'e1']);
});
test('while running, streaming text is the answer until the agent moves on to another step', () => {
  assert.deepEqual(shape(foldProcess([user('u1'), think('t1'), say('a1', '正在写')], true)), ['u1', 'fold(t1)', 'a1']);
  assert.deepEqual(shape(foldProcess([user('u1'), say('a1', '先读文件'), tool('c1')], true)), ['u1', 'fold(a1,c1)']);
  assert.deepEqual(shape(foldProcess([user('u1'), say('a1', '先读文件'), tool('c1')], false)), ['u1', 'fold(c1)', 'a1'], 'a finished run keeps its last text as the answer');
});
test('earlier turns are unaffected by a running last turn, and events before the first question are kept', () => {
  assert.deepEqual(shape(foldProcess([tool('c0'), say('a0'), user('u1'), say('a1', 'x'), tool('c1'), user('u2'), say('a2')], true)), ['fold(c0)', 'a0', 'u1', 'fold(c1)', 'a1', 'u2', 'a2']);
});

test('a second run without a user echo (queued message) is its own question and keeps its own answer', () => {
  const turn = (event: ChatEvent, runTurn: number): ChatEvent => ({ ...event, runTurn });
  assert.deepEqual(shape(foldProcess([turn(user('u1'), 1), turn(say('a1', '第一轮'), 1), turn(say('a2', '第二轮'), 2)], false)), ['u1', 'a1', 'a2']);
});
