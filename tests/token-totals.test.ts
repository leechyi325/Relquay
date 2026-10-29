import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeTranscriptTotals, UsageStore } from '../server/usage.ts';
import { claudeTokens } from '../shared/usage.ts';

test('claude cumulative totals count each message once, using its final usage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-usage-')), dir = path.join(root, 'proj'); fs.mkdirSync(dir);
  const line = (id: string, input: number, output: number, read: number, write: number) => JSON.stringify({ type: 'assistant', uuid: id + output, message: { id, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: write } } });
  fs.writeFileSync(path.join(dir, 'abc-1.jsonl'), [line('m1', 2, 10, 100, 5), line('m1', 2, 40, 100, 5), line('m2', 3, 20, 150, 0), JSON.stringify({ type: 'user', message: { content: 'hi' } }), '{"type":"assistant","message":{"usage":'].join('\n'));
  const totals = await claudeTranscriptTotals('abc-1', root);
  assert.deepEqual({ ...totals, updatedAt: '' }, { inputTokens: 5, outputTokens: 60, cacheReadTokens: 250, cacheWriteTokens: 5, calls: 2, updatedAt: '' });
  assert.equal(await claudeTranscriptTotals('missing', root), null);
  assert.equal(await claudeTranscriptTotals('../etc', root), null);
});

test('an all-zero claude report does not overwrite a real context snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-store-')), store = new UsageStore(dir);
  store.set('s1', claudeTokens({ used: 500, total: 1000, inputTokens: 500, outputTokens: 5 }));
  store.set('s1', claudeTokens({ used: 0, total: 1000, inputTokens: 0, outputTokens: 0 }));
  assert.equal(store.get('s1')?.contextTokens, 500);
  store.set('s2', claudeTokens({ used: 0, total: 1000, outputTokens: 0 }));
  assert.equal(store.get('s2')?.contextTokens, 0);
});
