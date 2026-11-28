import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurns, plain } from '../shared/turns.ts';
import type { ChatEvent } from '../shared/protocol.ts';

test('question index: turns start at user questions, preview the last reply, skip orphan events', () => {
  const events: ChatEvent[] = [
    { kind: 'text', role: 'assistant', content: '上一页遗留的回答', id: 'orphan' },
    { kind: 'text', role: 'user', content: '  检查 `src/App.tsx`  ', id: 'q1', timestamp: '2026-11-28T01:00:00Z', attachments: [{ name: 'a.png' }] },
    { kind: 'text', role: 'assistant', content: '我先看一下。', id: 'a1' },
    { kind: 'tool_use', id: 't1', toolName: 'Read' }, { kind: 'tool_result', id: 'r1' }, { kind: 'tool_use', id: 't2', toolName: 'Read' },
    { kind: 'text', role: 'assistant', content: '## 结论\n**没有问题**，见 [说明](https://x.y)。', id: 'a2' },
    { kind: 'text', role: 'user', content: '', id: 'empty' },
    { kind: 'text', role: 'user', content: '第二个问题', id: 'local', renderKey: 'stable', optimistic: true },
    { kind: 'stream_delta', role: 'assistant', content: '正在输出', id: 'd1' },
    { kind: 'text', role: 'user', content: '没有编号的问题' },
  ];
  const turns = buildTurns(events);
  assert.deepEqual(turns.map(turn => [turn.key, turn.tools, turn.attachments]), [['q1', 2, 1], ['stable', 0, 0]]);
  assert.equal(turns[0].question, '检查 `src/App.tsx`'); assert.equal(turns[0].answer, '## 结论\n**没有问题**，见 [说明](https://x.y)。');
  assert.equal(turns[1].answer, '正在输出');
  assert.equal(plain(turns[0].answer), '结论 没有问题，见 说明。');
  assert.equal(plain('```ts\nconst a = 1;\n```\n- 项目 `x`'), 'const a = 1; 项目 x');
  assert.deepEqual(buildTurns([]), []);
});
