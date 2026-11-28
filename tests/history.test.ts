import test from 'node:test';
import assert from 'node:assert/strict';
import { slimHistory } from '../server/history.ts';

test('history pages drop repeated and oversized tool output but keep everything the chat shows', () => {
  const huge = 'x'.repeat(50_000), image = '{"type":"image","file":{"base64":"' + 'A'.repeat(5000) + '"}}';
  const page = { total: 3, hasMore: true, messages: [
    { kind: 'text', id: 'a', role: 'user', content: '你好' },
    { kind: 'tool_use', id: 'b', toolName: 'Read', toolInput: { file_path: '/w/a.ts' }, toolResult: { content: huge, isError: false, toolUseResult: { file: huge } } },
    { kind: 'tool_use', id: 'c', toolName: 'Read', toolInput: {}, toolResult: { content: image, isError: true, toolUseResult: image } },
  ] };
  const slim = slimHistory(page), [text, big, picture] = slim.messages as { toolResult?: { content: string; isError: boolean; toolUseResult?: unknown } }[];
  assert.deepEqual([slim.total, slim.hasMore], [3, true]); assert.deepEqual(text, page.messages[0]);
  assert.ok(big.toolResult!.content.length < 4100 && big.toolResult!.content.includes('已省略')); assert.equal('toolUseResult' in big.toolResult!, false);
  assert.ok(picture.toolResult!.content.length < 100 && picture.toolResult!.isError === true);
  assert.equal(JSON.stringify(page).length > 100_000, true); assert.ok(JSON.stringify(slim).length < 6000);
  assert.deepEqual(slimHistory({ error: 'x' }), { error: 'x' }); assert.equal(slimHistory(null), null);
});
